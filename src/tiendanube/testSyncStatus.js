const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const dotenv = require("dotenv");
const { loadStorageState } = require("../session");
const { ensureAuthenticatedSession, extractCode } = require("../extractByCodesTest");
const { normalizeProduct } = require("../normalizer/productNormalizer");
const { createTiendanubeClient, getTiendanubeConfig } = require("./client");
const { mapArcoreProductToTiendanube } = require("./mapper");
const {
  createProduct,
  findSkuMatches,
  getLegacyGroupMatches,
  updateProductPublishedStatus,
} = require("./products");
const { getLegacySkuGroup } = require("./legacySkuGroups");
const { normalizeSku } = require("./sku");

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

function decidePublicationAction({ availability, publishedBefore }) {
  const expectedPublished = expectedPublishedForAvailability(availability);

  if (expectedPublished === null) {
    return {
      expectedPublished: null,
      action: "NO_CHANGE",
      reason: "Estado Arcore UNKNOWN. No se modifica el producto.",
    };
  }

  if (publishedBefore === expectedPublished) {
    return {
      expectedPublished,
      action: "NO_CHANGE",
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

async function getArcoreProduct(sourceSku) {
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

    return normalizeProduct(extraction.product.raw);
  } finally {
    await browser.close();
  }
}

function serializeError(error) {
  if (!error.response) return { message: error.message };
  return {
    message: error.message,
    status: error.response.status,
    statusText: error.response.statusText,
    data: error.response.data,
  };
}

function initResult(sourceSku, dryRun) {
  return {
    sourceSku,
    normalizedSku: normalizeSku(sourceSku),
    type: "",
    matchedSku: "",
    productId: null,
    variantId: null,
    arcoreAvailability: "",
    publishedBefore: null,
    expectedPublished: null,
    action: "",
    dryRun,
    updated: false,
    created: false,
    updatedProductIds: [],
    skippedProductIds: [],
    warnings: [],
    errors: [],
    timestamp: new Date().toISOString(),
  };
}

function legacyPairKey(productId, variantId) {
  return `${productId}:${variantId}`;
}

function validateLegacyGroup({ group, legacy, currentSkuMatches }) {
  const issues = [];
  const expectedMatches = Number(group.expectedMatches) || 0;
  const productIds = Array.isArray(group.productIds) ? group.productIds : [];
  const variantIds = Array.isArray(group.variantIds) ? group.variantIds : [];
  const actualMatches = currentSkuMatches.matches.length;
  const registeredPairs = new Set(
    productIds.map((productId, index) => legacyPairKey(productId, variantIds[index])),
  );
  const actualPairs = new Set(
    currentSkuMatches.matches.map((match) =>
      legacyPairKey(match.productId, match.variantId),
    ),
  );

  if (productIds.length !== expectedMatches) {
    issues.push({
      code: "LEGACY_PRODUCT_IDS_COUNT_MISMATCH",
      expectedMatches,
      productIdsCount: productIds.length,
    });
  }

  if (variantIds.length !== expectedMatches) {
    issues.push({
      code: "LEGACY_VARIANT_IDS_COUNT_MISMATCH",
      expectedMatches,
      variantIdsCount: variantIds.length,
    });
  }

  if (actualMatches !== expectedMatches) {
    issues.push({
      code: "LEGACY_ACTUAL_MATCHES_MISMATCH",
      expectedMatches,
      actualMatches,
    });
  }

  if (legacy.missing.length > 0) {
    issues.push({
      code: "LEGACY_GROUP_MISSING_PRODUCT",
      missing: legacy.missing,
    });
  }

  for (const pair of registeredPairs) {
    if (!actualPairs.has(pair)) {
      issues.push({
        code: "LEGACY_REGISTERED_PAIR_NOT_IN_CURRENT_MATCHES",
        pair,
      });
    }
  }

  for (const pair of actualPairs) {
    if (!registeredPairs.has(pair)) {
      issues.push({
        code: "LEGACY_CURRENT_MATCH_NOT_REGISTERED",
        pair,
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    registeredProductIdsCount: productIds.length,
    registeredVariantIdsCount: variantIds.length,
    expectedMatches,
    actualMatches,
  };
}

function printLegacyPublications(matches) {
  console.log("- publicaciones afectadas:");
  for (const match of matches) {
    const name =
      typeof match.name === "object"
        ? match.name.es || match.name.pt || match.name.en || JSON.stringify(match.name)
        : match.name || "sin nombre";
    console.log(
      `  - productId: ${match.productId} | variantId: ${match.variantId} | nombre: ${name} | published: ${match.published}`,
    );
  }
}

async function assertNoExistingSkuBeforeCreate(sku, client) {
  const matches = await findSkuMatches(sku, client);
  if (matches.matches.length === 0) return matches;

  const error = new Error(
    "CREATE_ABORTED_EXISTING_SKU: ya existe una publicacion equivalente por SKU normalizado.",
  );
  error.code = "CREATE_ABORTED_EXISTING_SKU";
  error.matches = matches.matches;
  error.normalizedSku = matches.normalizedSku;
  throw error;
}

async function syncSingleMatch({ match, arcoreProduct, client, dryRun, result }) {
  const decision = decidePublicationAction({
    availability: arcoreProduct.estadoDisponibilidad,
    publishedBefore: match.published,
  });

  result.type = "SINGLE";
  result.action = decision.action === "NO_CHANGE" ? "NO_CHANGE" : "SYNC_SINGLE";
  result.matchedSku = match.matchedSku;
  result.productId = match.productId;
  result.variantId = match.variantId;
  result.publishedBefore = match.published;
  result.expectedPublished = decision.expectedPublished;

  console.log("\nTiendanube:");
  console.log(`- type: SINGLE`);
  console.log(`- productId: ${match.productId}`);
  console.log(`- variantId: ${match.variantId}`);
  console.log(`- matchedSku: ${match.matchedSku}`);
  console.log(`- published actual: ${match.published}`);

  console.log("\nDecision:");
  console.log(`- accion requerida: ${result.action}`);
  console.log(`- detalle: ${decision.reason}`);

  if (decision.expectedPublished === null || decision.action === "NO_CHANGE") {
    result.skippedProductIds.push(match.productId);
    return;
  }

  if (dryRun) {
    result.skippedProductIds.push(match.productId);
    return;
  }

  await updateProductPublishedStatus(match.productId, decision.expectedPublished, client);
  result.updated = true;
  result.updatedProductIds.push(match.productId);
}

async function syncLegacyGroup({ group, arcoreProduct, client, dryRun, result }) {
  const legacy = await getLegacyGroupMatches(group, client);
  const currentSkuMatches = await findSkuMatches(group.normalizedSku, client);
  const validation = validateLegacyGroup({
    group,
    legacy,
    currentSkuMatches,
  });

  result.type = "LEGACY_GROUP";
  result.action = "SYNC_LEGACY_GROUP";
  result.expectedMatches = legacy.expectedMatches;
  result.actualMatches = currentSkuMatches.matches.length;
  result.legacyGroup = {
    normalizedSku: group.normalizedSku,
    type: "LEGACY_GROUP",
    expectedMatches: legacy.expectedMatches,
    actualMatches: currentSkuMatches.matches.length,
    registeredProductIdsCount: validation.registeredProductIdsCount,
    registeredVariantIdsCount: validation.registeredVariantIdsCount,
    publications: legacy.matches,
    missing: legacy.missing,
    validationIssues: validation.issues,
  };

  console.log("\nTiendanube:");
  console.log("- type: LEGACY_GROUP");
  console.log(`- expectedMatches: ${legacy.expectedMatches}`);
  console.log(`- actualMatches: ${currentSkuMatches.matches.length}`);
  console.log(`- productIds registrados: ${validation.registeredProductIdsCount}`);
  console.log(`- variantIds registrados: ${validation.registeredVariantIdsCount}`);
  printLegacyPublications(legacy.matches);

  if (!validation.ok) {
    result.action = "MANUAL_REVIEW";
    result.errors.push({
      code: "MANUAL_REVIEW",
      message:
        "La validacion del LEGACY_GROUP no coincide exactamente con Tiendanube.",
      issues: validation.issues,
    });

    console.log("\nDecision:");
    console.log("- accion requerida: MANUAL_REVIEW");
    console.log("- diferencias detectadas:");
    for (const issue of validation.issues) {
      console.log(`  - ${issue.code}`);
    }
    console.log("- No se realizaron modificaciones.");
    return;
  }

  const expectedPublished = expectedPublishedForAvailability(
    arcoreProduct.estadoDisponibilidad,
  );
  result.expectedPublished = expectedPublished;

  if (expectedPublished === null) {
    result.action = "NO_CHANGE";
    result.warnings.push({
      code: "UNKNOWN_AVAILABILITY",
      message: "Estado Arcore UNKNOWN. No se modifica el LEGACY_GROUP.",
    });
    result.skippedProductIds.push(...legacy.matches.map((match) => match.productId));
    console.log("\nDecision:");
    console.log("- accion requerida: NO_CHANGE");
    console.log("- detalle: Estado UNKNOWN. No se realizaron modificaciones.");
    return;
  }

  console.log("\nDecision:");
  console.log("- accion requerida: SYNC_LEGACY_GROUP");

  for (const match of legacy.matches) {
    const decision = decidePublicationAction({
      availability: arcoreProduct.estadoDisponibilidad,
      publishedBefore: match.published,
    });

    if (decision.action === "NO_CHANGE") {
      result.skippedProductIds.push(match.productId);
      continue;
    }

    if (dryRun) {
      result.skippedProductIds.push(match.productId);
      continue;
    }

    await updateProductPublishedStatus(match.productId, expectedPublished, client);
    result.updated = true;
    result.updatedProductIds.push(match.productId);
  }
}

async function createSingle({ arcoreProduct, client, dryRun, result }) {
  result.type = "SINGLE";
  result.action = "CREATE_SINGLE";

  const expectedPublished = expectedPublishedForAvailability(
    arcoreProduct.estadoDisponibilidad,
  );
  result.expectedPublished = expectedPublished;

  if (expectedPublished === null) {
    result.action = "NO_CHANGE";
    result.warnings.push({
      code: "UNKNOWN_AVAILABILITY",
      message: "Estado Arcore UNKNOWN. No se crea producto.",
    });
    return;
  }

  const mapped = mapArcoreProductToTiendanube(arcoreProduct);
  mapped.payload.published = expectedPublished;

  console.log("\nTiendanube:");
  console.log("- type: SINGLE");
  console.log("- coincidencias actuales: 0");

  console.log("\nDecision:");
  console.log("- accion requerida: CREATE_SINGLE");
  console.log(`- published inicial: ${expectedPublished}`);

  await assertNoExistingSkuBeforeCreate(mapped.sku, client);

  if (dryRun) {
    console.log("- dry-run: se simula creacion, no se hace POST.");
    return;
  }

  // Segunda validacion anti-duplicados inmediatamente antes del POST.
  await assertNoExistingSkuBeforeCreate(mapped.sku, client);
  const createdProduct = await createProduct(mapped.payload, client);
  result.created = true;
  result.productId = createdProduct.id || null;
}

async function main() {
  const sourceSku = process.argv[2] || process.env.TIENDANUBE_TEST_SKU || "";
  const dryRun = isDryRun();
  const result = initResult(sourceSku, dryRun);

  try {
    ensureOutputDir();

    if (!sourceSku.trim()) {
      throw new Error(
        "Falta SKU. Ejecuta: npm run tiendanube:test-status -- \"4150768090\"",
      );
    }

    getTiendanubeConfig();
    const client = createTiendanubeClient();

    console.log("=== SINCRONIZACION DE ESTADO ===\n");
    console.log("Regla fundamental:");
    console.log(
      "- Los SKU repetidos solo se aceptan si pertenecen al registro historico LEGACY_GROUP.",
    );
    console.log("- El sistema nunca crea duplicados nuevos automaticamente.\n");

    console.log("SKU solicitado:");
    console.log(`- sourceSku: ${sourceSku}`);
    console.log(`- normalizedSku: ${result.normalizedSku}`);

    const group = getLegacySkuGroup(result.normalizedSku);
    const arcoreProduct = await getArcoreProduct(sourceSku);
    result.arcoreAvailability = arcoreProduct.estadoDisponibilidad;

    console.log("\nArcore:");
    console.log(`- matchedCode: ${arcoreProduct.matchedCode || arcoreProduct.codigo}`);
    console.log(`- descripcion: ${arcoreProduct.descripcion || arcoreProduct.nombre}`);
    console.log(`- estado normalizado: ${result.arcoreAvailability}`);

    if (group) {
      await syncLegacyGroup({ group, arcoreProduct, client, dryRun, result });
    } else {
      const skuMatches = await findSkuMatches(sourceSku, client);

      if (skuMatches.matches.length === 0) {
        await createSingle({ arcoreProduct, client, dryRun, result });
      } else if (skuMatches.matches.length === 1) {
        await syncSingleMatch({
          match: skuMatches.matches[0],
          arcoreProduct,
          client,
          dryRun,
          result,
        });
      } else {
        result.type = "SINGLE";
        result.action = "MANUAL_REVIEW";
        result.errors.push({
          code: "MANUAL_REVIEW",
          message:
            "SKU no pertenece a LEGACY_GROUP y tiene multiples coincidencias normalizadas.",
          matches: skuMatches.matches,
        });

        console.log("\nTiendanube:");
        console.log("- type: SINGLE");
        console.log(`- coincidencias por SKU normalizado: ${skuMatches.matches.length}`);
        console.log("\nDecision:");
        console.log("- accion requerida: MANUAL_REVIEW");
        console.log("- No se realizaron modificaciones.");
      }
    }

    console.log(`\nDry Run: ${dryRun}`);
    if (dryRun) {
      console.log("No se realizaron modificaciones.");
    } else if (result.updated) {
      console.log("Estado de publicacion actualizado correctamente.");
    } else if (result.created) {
      console.log("Producto SINGLE creado correctamente.");
    } else {
      console.log("No se realizaron modificaciones.");
    }

    writeResult(result);
    process.exitCode = result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    result.action = error.code || result.action || "ERROR";
    result.errors.push({
      ...serializeError(error),
      code: error.code || "ERROR",
      normalizedSku: error.normalizedSku,
      matches: error.matches,
    });
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
  decidePublicationAction,
  main,
};
