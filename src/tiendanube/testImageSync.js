const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const dotenv = require("dotenv");
const { loadStorageState } = require("../session");
const {
  ensureAuthenticatedSession,
  extractCode,
  looksLikeRealImage,
} = require("../extractByCodesTest");
const { normalizeProduct } = require("../normalizer/productNormalizer");
const { createTiendanubeClient, getTiendanubeConfig } = require("./client");
const {
  deleteProductImage,
  findSkuMatches,
  getLegacyGroupMatches,
  listProductImages,
  uploadProductImage,
} = require("./products");
const { getLegacySkuGroup } = require("./legacySkuGroups");
const { calculateImageHash } = require("./imageFingerprint");
const { normalizeSku } = require("./sku");

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "output");
const RESULT_FILE = path.resolve(OUTPUT_DIR, "tiendanube-test-image.json");

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

function pickName(value) {
  if (!value) return "sin nombre";
  if (typeof value === "string") return value;
  return value.es || value.pt || value.en || JSON.stringify(value);
}

function serializeError(error) {
  if (!error.response) {
    return {
      message: error.message,
      status: error.status || null,
      url: error.url || null,
    };
  }

  return {
    message: error.message,
    status: error.response.status,
    statusText: error.response.statusText,
    data: error.response.data,
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

function legacyPairKey(productId, variantId) {
  return `${productId}:${variantId}`;
}

function validateLegacyGroup({ group, legacy, currentSkuMatches }) {
  const issues = [];
  const expectedMatches = Number(group.expectedMatches) || 0;
  const productIds = Array.isArray(group.productIds) ? group.productIds : [];
  const variantIds = Array.isArray(group.variantIds) ? group.variantIds : [];
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

  if (currentSkuMatches.matches.length !== expectedMatches) {
    issues.push({
      code: "LEGACY_ACTUAL_MATCHES_MISMATCH",
      expectedMatches,
      actualMatches: currentSkuMatches.matches.length,
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
    expectedMatches,
    actualMatches: currentSkuMatches.matches.length,
    registeredProductIdsCount: productIds.length,
    registeredVariantIdsCount: variantIds.length,
  };
}

function getPrimaryImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  return [...images].sort((a, b) => {
    const positionA = Number(a.position) || Number.MAX_SAFE_INTEGER;
    const positionB = Number(b.position) || Number.MAX_SAFE_INTEGER;
    return positionA - positionB;
  })[0];
}

function aggregatePublicationAction(publications) {
  const actions = publications.map((publication) => publication.action);

  if (actions.includes("ERROR")) return "ERROR";
  if (actions.includes("MANUAL_REVIEW")) return "MANUAL_REVIEW";
  if (actions.includes("IMAGE_UPLOAD_FAILED")) return "IMAGE_UPLOAD_FAILED";
  if (actions.includes("IMAGE_DOWNLOAD_FAILED")) return "IMAGE_DOWNLOAD_FAILED";
  if (actions.includes("IMAGE_REPLACE")) return "IMAGE_REPLACE";
  if (actions.includes("IMAGE_CREATE")) return "IMAGE_CREATE";
  if (actions.length > 0 && actions.every((action) => action === "IMAGE_NO_CHANGE")) {
    return "IMAGE_NO_CHANGE";
  }

  return "ERROR";
}

function actionWouldWrite(action) {
  return action === "IMAGE_CREATE" || action === "IMAGE_REPLACE";
}

async function analyzePublication({ match, arcoreImageUrl, arcoreHash, client, dryRun }) {
  const publication = {
    productId: match.productId,
    variantId: match.variantId,
    name: pickName(match.name),
    published: match.published,
    tiendanubeImageCount: 0,
    imageId: null,
    tiendanubeImageUrl: null,
    arcoreHash,
    tiendanubeHash: null,
    action: "",
    updated: false,
    warnings: [],
    errors: [],
  };

  try {
    const images = await listProductImages(match.productId, client);
    publication.tiendanubeImageCount = images.length;

    if (images.length > 1) {
      publication.warnings.push({
        code: "MULTIPLE_TN_IMAGES",
        message:
          "El producto tiene multiples imagenes. Solo se compara la principal.",
      });
    }

    const primaryImage = getPrimaryImage(images);
    publication.imageId = primaryImage?.id || null;
    publication.tiendanubeImageUrl = primaryImage?.src || null;

    console.log(
      `- productId: ${match.productId} | variantId: ${match.variantId} | imagenes TN: ${images.length}`,
    );

    if (!primaryImage) {
      publication.action = "IMAGE_CREATE";
      if (!dryRun) {
        let uploaded;
        try {
          uploaded = await uploadProductImage(match.productId, arcoreImageUrl, client);
        } catch (error) {
          publication.action = "IMAGE_UPLOAD_FAILED";
          publication.errors.push({
            code: "IMAGE_UPLOAD_FAILED",
            ...serializeError(error),
          });
          return publication;
        }

        publication.imageId = uploaded.id || null;
        publication.updated = true;
      }
      return publication;
    }

    try {
      publication.tiendanubeHash = await calculateImageHash(primaryImage.src);
    } catch (error) {
      publication.action = "IMAGE_DOWNLOAD_FAILED";
      publication.errors.push({
        code: "IMAGE_DOWNLOAD_FAILED",
        ...serializeError(error),
      });
      return publication;
    }

    if (publication.tiendanubeHash === arcoreHash) {
      publication.action = "IMAGE_NO_CHANGE";
      return publication;
    }

    publication.action = "IMAGE_REPLACE";

    if (dryRun) return publication;

    let uploaded;
    try {
      uploaded = await uploadProductImage(match.productId, arcoreImageUrl, client);
    } catch (error) {
      publication.action = "IMAGE_UPLOAD_FAILED";
      publication.errors.push({
        code: "IMAGE_UPLOAD_FAILED",
        ...serializeError(error),
      });
      return publication;
    }

    if (!uploaded || !uploaded.id) {
      publication.action = "IMAGE_UPLOAD_FAILED";
      publication.errors.push({
        code: "IMAGE_UPLOAD_FAILED",
        message: "Tiendanube no devolvio id para la nueva imagen.",
      });
      return publication;
    }

    await deleteProductImage(match.productId, primaryImage.id, client);
    publication.imageId = uploaded.id;
    publication.updated = true;
    return publication;
  } catch (error) {
    publication.action = publication.action || "ERROR";
    publication.errors.push(serializeError(error));
    return publication;
  }
}

function buildBaseResult(sourceSku, dryRun) {
  return {
    sourceSku,
    normalizedSku: normalizeSku(sourceSku),
    type: "",
    productId: null,
    variantId: null,
    arcoreImageUrl: null,
    tiendanubeImageId: null,
    arcoreHash: null,
    tiendanubeHash: null,
    action: "",
    dryRun,
    updated: false,
    warnings: [],
    errors: [],
    publications: [],
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const sourceSku = process.argv[2] || process.env.TIENDANUBE_TEST_SKU || "";
  const dryRun = isDryRun();
  const result = buildBaseResult(sourceSku, dryRun);

  try {
    ensureOutputDir();

    if (!sourceSku.trim()) {
      throw new Error(
        "Falta SKU. Ejecuta: npm run tiendanube:test-image -- \"4150768090\"",
      );
    }

    getTiendanubeConfig();
    const client = createTiendanubeClient();

    console.log("=== SINCRONIZACION DE IMAGEN ===\n");
    console.log("SKU solicitado:");
    console.log(`- sourceSku: ${sourceSku}`);
    console.log(`- normalizedSku: ${result.normalizedSku}`);
    console.log(`- dryRun: ${dryRun}`);

    const arcoreProduct = await getArcoreProduct(sourceSku);
    result.arcoreImageUrl = arcoreProduct.imageUrl || null;

    console.log("\nArcore:");
    console.log(`- matchedCode: ${arcoreProduct.matchedCode || arcoreProduct.codigo}`);
    console.log(`- imageUrl: ${result.arcoreImageUrl || "sin imagen"}`);

    if (!looksLikeRealImage(result.arcoreImageUrl)) {
      result.type = getLegacySkuGroup(result.normalizedSku) ? "LEGACY_GROUP" : "SINGLE";
      result.action = "NO_SOURCE_IMAGE";
      result.warnings.push({
        code: "NO_SOURCE_IMAGE",
        message: "Arcore no devolvio una imagen valida. No se elimina nada en Tiendanube.",
      });
      console.log("\nDecision:");
      console.log("- accion requerida: NO_SOURCE_IMAGE");
      console.log("No se realizaron modificaciones.");
      writeResult(result);
      process.exitCode = 0;
      return;
    }

    try {
      result.arcoreHash = await calculateImageHash(result.arcoreImageUrl, {
        withArcoreAuth: true,
      });
      console.log(`- hash Arcore: ${result.arcoreHash}`);
    } catch (error) {
      result.action = "IMAGE_DOWNLOAD_FAILED";
      result.errors.push({
        code: "IMAGE_DOWNLOAD_FAILED",
        ...serializeError(error),
      });
      console.log("\nDecision:");
      console.log("- accion requerida: IMAGE_DOWNLOAD_FAILED");
      console.log("No se realizaron modificaciones.");
      writeResult(result);
      process.exitCode = 1;
      return;
    }

    const group = getLegacySkuGroup(result.normalizedSku);
    let matches = [];

    if (group) {
      result.type = "LEGACY_GROUP";
      const legacy = await getLegacyGroupMatches(group, client);
      const currentSkuMatches = await findSkuMatches(group.normalizedSku, client);
      const validation = validateLegacyGroup({
        group,
        legacy,
        currentSkuMatches,
      });

      result.expectedMatches = validation.expectedMatches;
      result.actualMatches = validation.actualMatches;
      result.registeredProductIdsCount = validation.registeredProductIdsCount;
      result.registeredVariantIdsCount = validation.registeredVariantIdsCount;

      console.log("\nTiendanube:");
      console.log("- type: LEGACY_GROUP");
      console.log(`- expectedMatches: ${validation.expectedMatches}`);
      console.log(`- actualMatches: ${validation.actualMatches}`);
      console.log(`- productIds registrados: ${validation.registeredProductIdsCount}`);
      console.log(`- variantIds registrados: ${validation.registeredVariantIdsCount}`);

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
        console.log("No se realizaron modificaciones.");
        writeResult(result);
        process.exitCode = 1;
        return;
      }

      matches = legacy.matches;
    } else {
      result.type = "SINGLE";
      const skuMatches = await findSkuMatches(sourceSku, client);

      console.log("\nTiendanube:");
      console.log("- type: SINGLE");
      console.log(`- matches por SKU normalizado: ${skuMatches.matches.length}`);

      if (skuMatches.matches.length !== 1) {
        result.action = "MANUAL_REVIEW";
        result.errors.push({
          code: "MANUAL_REVIEW",
          message:
            "La sincronizacion de imagen SINGLE requiere exactamente un match seguro.",
          matches: skuMatches.matches,
        });
        console.log("\nDecision:");
        console.log("- accion requerida: MANUAL_REVIEW");
        console.log("No se realizaron modificaciones.");
        writeResult(result);
        process.exitCode = 1;
        return;
      }

      matches = skuMatches.matches;
      result.productId = matches[0].productId;
      result.variantId = matches[0].variantId;
    }

    console.log("\nAnalizando imagenes Tiendanube:");
    for (const match of matches) {
      const publication = await analyzePublication({
        match,
        arcoreImageUrl: result.arcoreImageUrl,
        arcoreHash: result.arcoreHash,
        client,
        dryRun,
      });
      result.publications.push(publication);

      console.log(
        `  hash TN principal: ${publication.tiendanubeHash || "sin imagen principal"}`,
      );
      console.log(`  accion: ${publication.action}`);
      if (publication.warnings.some((warning) => warning.code === "MULTIPLE_TN_IMAGES")) {
        console.log("  advertencia: MULTIPLE_TN_IMAGES");
      }
    }

    if (result.type === "SINGLE") {
      const publication = result.publications[0];
      result.tiendanubeImageId = publication.imageId;
      result.tiendanubeHash = publication.tiendanubeHash;
      result.action = publication.action;
      result.updated = publication.updated;
    } else {
      result.action = aggregatePublicationAction(result.publications);
      result.updated = result.publications.some((item) => item.updated);
    }

    for (const publication of result.publications) {
      result.warnings.push(...publication.warnings);
      result.errors.push(...publication.errors);
    }

    console.log("\nDecision:");
    console.log(`- accion calculada: ${result.action}`);
    console.log(`- requeriria escritura en ejecucion real: ${actionWouldWrite(result.action)}`);
    console.log(`- escritura ejecutada: ${!dryRun && actionWouldWrite(result.action)}`);
    console.log(`\nDry Run: ${dryRun}`);
    if (dryRun) {
      console.log("No se realizaron escrituras.");
    }

    writeResult(result);
    process.exitCode = result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    result.action = "ERROR";
    result.errors.push({
      code: "ERROR",
      ...serializeError(error),
    });
    writeResult(result);

    console.error("\nError en tiendanube:test-image:");
    console.error(`- mensaje: ${error.message}`);
    if (error.response) {
      console.error(`- status HTTP: ${error.response.status}`);
      console.error("- respuesta Tiendanube:");
      console.error(JSON.stringify(error.response.data, null, 2));
    }
    console.error("\nNo se imprime el access token, password, cookies ni storageState.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
