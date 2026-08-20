const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const dotenv = require("dotenv");
const { loadStorageState } = require("../session");
const { ensureAuthenticatedSession, extractCode } = require("../extractByCodesTest");
const { normalizeSku } = require("./sku");
const { normalizeProduct } = require("../normalizer/productNormalizer");
const { createTiendanubeClient, getTiendanubeConfig } = require("./client");
const {
  findProductBySku,
  updateProductPublishedStatus,
} = require("./products");

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "output");
const RESULT_FILE = path.resolve(OUTPUT_DIR, "tiendanube-test-status.json");

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function writeResult(result) {
  ensureOutputDir();
  fs.writeFileSync(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
}

function isDryRun() {
  const value = String(process.env.TIENDANUBE_DRY_RUN || "true").trim().toLowerCase();
  return value !== "false";
}

function expectedPublishedForAvailability(availability) {
  if (availability === "AVAILABLE" || availability === "PARTIAL") return true;
  if (availability === "UNAVAILABLE") return false;
  return null;
}

function decideAction({ availability, publishedBefore }) {
  const expectedPublished = expectedPublishedForAvailability(availability);

  if (expectedPublished === null) {
    return {
      expectedPublished: null,
      action: "ABORT",
      reason: "Estado Arcore UNKNOWN. No se modifica el producto.",
    };
  }

  if (publishedBefore === expectedPublished) {
    return {
      expectedPublished,
      action: "NONE",
      reason: "El producto ya esta en el estado esperado.",
    };
  }

  return {
    expectedPublished,
    action: expectedPublished ? "ENABLE" : "DISABLE",
    reason: expectedPublished
      ? "El producto debe estar habilitado."
      : "El producto debe estar deshabilitado.",
  };
}

async function getArcoreAvailability(sourceSku) {
  await ensureAuthenticatedSession();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: { cookies: loadStorageState().cookies },
  });
  const page = await context.newPage();

  try {
    const extraction = await extractCode(page, sourceSku);
    if (!extraction.found) {
      throw new Error(`No se encontro producto en Arcore para SKU ${sourceSku}.`);
    }

    const normalized = normalizeProduct(extraction.product.raw);
    return {
      normalized,
      descripcion: normalized.descripcion || normalized.nombre || "",
      estadoDisponibilidad: normalized.estadoDisponibilidad,
    };
  } finally {
    await browser.close();
  }
}

function serializeError(error) {
  if (!error.response) {
    return {
      message: error.message,
    };
  }

  return {
    message: error.message,
    status: error.response.status,
    statusText: error.response.statusText,
    data: error.response.data,
  };
}

async function main() {
  const sourceSku = process.argv[2] || process.env.TIENDANUBE_TEST_SKU || "";
  const dryRun = isDryRun();
  const result = {
    sourceSku,
    normalizedSku: normalizeSku(sourceSku),
    matchedSku: "",
    productId: null,
    variantId: null,
    arcoreAvailability: "",
    publishedBefore: null,
    expectedPublished: null,
    action: "",
    dryRun,
    updated: false,
    errors: [],
    timestamp: new Date().toISOString(),
  };

  try {
    ensureOutputDir();

    if (!sourceSku.trim()) {
      throw new Error(
        "Falta SKU. Ejecuta: npm run tiendanube:test-status -- \"415 0768 09\"",
      );
    }

    getTiendanubeConfig();
    const client = createTiendanubeClient();

    console.log("=== SINCRONIZACION DE ESTADO ===\n");
    console.log("SKU solicitado:");
    console.log(`- sourceSku: ${sourceSku}`);
    console.log(`- normalizedSku: ${result.normalizedSku}`);

    const tiendanubeMatch = await findProductBySku(sourceSku, client);

    if (tiendanubeMatch.ambiguous) {
      result.action = "ABORT";
      result.errors.push({
        message: "Match ambiguo por SKU normalizado. No se actualiza.",
        matches: tiendanubeMatch.matches,
      });
      console.log("\nTiendanube:");
      console.log("- match ambiguo por SKU normalizado");
      console.log("- No se realizaron modificaciones.");
      writeResult(result);
      process.exitCode = 1;
      return;
    }

    if (!tiendanubeMatch.exists) {
      result.action = "ABORT";
      result.errors.push({
        message: "No existe match seguro por SKU en Tiendanube.",
      });
      console.log("\nTiendanube:");
      console.log("- producto no encontrado con match seguro por SKU");
      console.log("- No se realizaron modificaciones.");
      writeResult(result);
      process.exitCode = 1;
      return;
    }

    result.matchedSku = tiendanubeMatch.matchedSku;
    result.productId = tiendanubeMatch.productId;
    result.variantId = tiendanubeMatch.variantId;
    result.publishedBefore = tiendanubeMatch.published;

    console.log("\nTiendanube:");
    console.log(`- productId: ${result.productId}`);
    console.log(`- variantId: ${result.variantId}`);
    console.log(`- matchedSku: ${result.matchedSku}`);
    console.log(`- published actual: ${result.publishedBefore}`);

    if (!result.productId || !result.variantId) {
      result.action = "ABORT";
      result.errors.push({
        message: "Faltan productId o variantId requeridos. No se actualiza.",
      });
      console.log("- Faltan IDs requeridos. No se realizaron modificaciones.");
      writeResult(result);
      process.exitCode = 1;
      return;
    }

    const arcore = await getArcoreAvailability(sourceSku);
    result.arcoreAvailability = arcore.estadoDisponibilidad;

    console.log("\nArcore:");
    console.log(`- descripcion: ${arcore.descripcion || "sin descripcion"}`);
    console.log(`- estado normalizado: ${result.arcoreAvailability}`);

    const decision = decideAction({
      availability: result.arcoreAvailability,
      publishedBefore: result.publishedBefore,
    });

    result.expectedPublished = decision.expectedPublished;
    result.action = decision.action;

    console.log("\nDecision:");
    console.log(
      `- estado esperado Tiendanube: ${
        result.expectedPublished === null
          ? "SIN CAMBIO"
          : result.expectedPublished
            ? "HABILITADO"
            : "DESHABILITADO"
      }`,
    );
    console.log(`- accion requerida: ${result.action}`);
    console.log(`- motivo: ${decision.reason}`);
    console.log(`\nDry Run: ${dryRun}`);

    if (result.action === "ABORT" || result.action === "NONE") {
      console.log("No se realizaron modificaciones.");
      writeResult(result);
      process.exitCode = result.action === "ABORT" ? 1 : 0;
      return;
    }

    if (dryRun) {
      console.log("No se realizaron modificaciones.");
      writeResult(result);
      process.exitCode = 0;
      return;
    }

    await updateProductPublishedStatus(result.productId, result.expectedPublished, client);
    result.updated = true;

    if (result.action === "ENABLE") {
      console.log("Producto habilitado correctamente.");
    } else {
      console.log("Producto deshabilitado correctamente.");
    }

    writeResult(result);
    process.exitCode = 0;
  } catch (error) {
    result.action = result.action || "ABORT";
    result.errors.push(serializeError(error));
    writeResult(result);

    console.error("\nError en tiendanube:test-status:");
    console.error(`- mensaje: ${error.message}`);
    if (error.response) {
      console.error(`- status HTTP: ${error.response.status}`);
      console.error("- respuesta Tiendanube:");
      console.error(JSON.stringify(error.response.data, null, 2));
    }
    console.error("\nNo se imprime el access token por seguridad.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  decideAction,
  main,
};
