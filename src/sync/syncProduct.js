const fs = require("fs");
const path = require("path");
const { extractArcoreProduct } = require("./arcoreProduct");
const { buildImagePlan } = require("./imagePlan");
const { buildPricePlan } = require("./pricePlan");
const { buildStatusPlan } = require("./statusPlan");
const { getTiendanubeConfig } = require("../tiendanube/client");
const { getLegacySkuGroup } = require("../tiendanube/legacySkuGroups");
const { validateLegacyGroup } = require("../tiendanube/legacyGroupValidation");
const {
  findSkuMatches,
  getLegacyGroupMatches,
} = require("../tiendanube/products");
const { createTiendanubeReadOnlyClient } = require("../tiendanube/readOnlyClient");
const { normalizeSku } = require("../tiendanube/sku");

const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "output");
const RESULT_FILE = path.resolve(OUTPUT_DIR, "sync-test.json");

function serializeError(error) {
  return {
    code: error.code || "ERROR",
    message: error.message,
    status: error.response?.status || error.status || null,
    data: error.response?.data,
    details: error.details,
  };
}

function writeResult(result) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
}

function basicMatch(match) {
  return {
    productId: match.productId,
    variantId: match.variantId,
    sku: match.sku,
    name: match.name,
    published: match.published,
    price: match.price,
    promotionalPrice: match.promotionalPrice,
    visibility: match.visibility,
  };
}

async function classifyTiendanube(sourceSku, normalizedSku, client) {
  const group = getLegacySkuGroup(normalizedSku);

  if (group) {
    const [legacy, currentSkuMatches] = await Promise.all([
      getLegacyGroupMatches(group, client),
      findSkuMatches(normalizedSku, client),
    ]);
    const validation = validateLegacyGroup({ group, legacy, currentSkuMatches });

    return {
      classification: validation.ok ? "LEGACY_GROUP" : "MANUAL_REVIEW",
      matches: validation.ok ? legacy.matches : [],
      reportedMatches: currentSkuMatches.matches,
      legacyGroup: {
        normalizedSku: group.normalizedSku,
        expectedMatches: validation.expectedMatches,
        actualMatches: validation.actualMatches,
        registeredProductIdsCount: validation.registeredProductIdsCount,
        registeredVariantIdsCount: validation.registeredVariantIdsCount,
        valid: validation.ok,
        issues: validation.issues,
        registeredPublications: legacy.matches.map(basicMatch),
        missing: legacy.missing,
      },
    };
  }

  const skuMatches = await findSkuMatches(sourceSku, client);
  if (skuMatches.matches.length === 0) {
    return {
      classification: "CREATE_SINGLE",
      matches: [],
      reportedMatches: [],
      legacyGroup: null,
    };
  }

  if (skuMatches.matches.length === 1) {
    return {
      classification: "SINGLE",
      matches: skuMatches.matches,
      reportedMatches: skuMatches.matches,
      legacyGroup: null,
    };
  }

  return {
    classification: "MANUAL_REVIEW",
    matches: [],
    reportedMatches: skuMatches.matches,
    legacyGroup: null,
  };
}

function buildSummary(classification, plans) {
  const statusActions = plans.status.publications.map((item) => item.action);
  const reviewActions = new Set([
    "ERROR",
    "IMAGE_DOWNLOAD_FAILED",
    "INVALID_SUPPLIER_PRICE",
    "MANUAL_REVIEW",
    "PRICE_CALCULATION_FAILED",
    "PRICE_WRITE_BLOCKED",
  ]);
  return {
    requiresStatusChange:
      statusActions.includes("PUBLISH") || statusActions.includes("UNPUBLISH"),
    requiresPriceChange: plans.price.action === "PRICE_UPDATE",
    requiresImageChange:
      plans.image.action === "IMAGE_CREATE" || plans.image.action === "IMAGE_REPLACE",
    requiresCreation: classification === "CREATE_SINGLE",
    requiresManualReview:
      classification === "MANUAL_REVIEW" ||
      reviewActions.has(plans.status.action) ||
      reviewActions.has(plans.price.action) ||
      reviewActions.has(plans.image.action),
  };
}

function addPlanMessages(result) {
  result.warnings.push(...(result.plans.image.warnings || []));
  result.errors.push(...(result.plans.price.errors || []));
  result.errors.push(...(result.plans.image.errors || []));

  if (result.supplier.matchType === "closestCandidate") {
    result.warnings.push({
      code: "ARCORE_CLOSEST_CANDIDATE_USED",
      message: "No hubo coincidencia exacta en Arcore; se utilizo el candidato mas cercano.",
      sourceSku: result.sourceSku,
      matchedCode: result.matchedCode,
    });
  }

  if (result.supplier.availability === "UNKNOWN") {
    result.warnings.push({
      code: "UNKNOWN_AVAILABILITY",
      message: "La disponibilidad Arcore es UNKNOWN; no se planifica cambio de publicacion.",
    });
  }
}

function printPublicationPlans(result) {
  const publicationIds = new Set([
    ...result.plans.status.publications,
    ...result.plans.price.publications,
    ...result.plans.image.publications,
  ].map((item) => `${item.productId}:${item.variantId}`));

  if (publicationIds.size === 0) return;

  console.log("\nPlanes por publicacion:");
  for (const key of publicationIds) {
    const [productId, variantId] = key.split(":");
    const status = result.plans.status.publications.find(
      (item) => String(item.productId) === productId && String(item.variantId) === variantId,
    );
    const price = result.plans.price.publications.find(
      (item) => String(item.productId) === productId && String(item.variantId) === variantId,
    );
    const image = result.plans.image.publications.find(
      (item) => String(item.productId) === productId && String(item.variantId) === variantId,
    );
    console.log(
      `- productId ${productId} | variantId ${variantId} | estado ${status?.action || "N/A"} | precio ${price?.action || "N/A"} | imagen ${image?.action || "N/A"}`,
    );
  }
}

function printResult(result) {
  console.log("\nResultado:");
  console.log(`- sourceSku: ${result.sourceSku}`);
  console.log(`- matchedCode: ${result.matchedCode || "NO_ENCONTRADO"}`);
  console.log(`- matchType Arcore: ${result.matchType || "NO_ENCONTRADO"}`);
  console.log(`- normalizedSku: ${result.normalizedSku}`);
  console.log(`- classification: ${result.classification}`);
  console.log(`- matchCount Tiendanube: ${result.tiendanube.matchCount}`);

  if (result.tiendanube.legacyGroup) {
    const legacy = result.tiendanube.legacyGroup;
    console.log(`- expectedMatches: ${legacy.expectedMatches}`);
    console.log(`- actualMatches: ${legacy.actualMatches}`);
    console.log(`- validacion historica: ${legacy.valid ? "OK" : "FALLO"}`);
  }

  console.log("\nProveedor:");
  console.log(`- disponibilidad: ${result.supplier.availability}`);
  console.log(
    `- fuente disponibilidad: ${result.supplier.availabilitySource?.source || "NO_ENCONTRADA"}`,
  );
  console.log(
    `- status stock HTTP: ${result.supplier.availabilitySource?.httpStatus ?? "N/A"}`,
  );
  console.log(`- precio: ${result.supplier.supplierPrice}`);
  console.log(`- fuente precio: ${result.supplier.priceSourceLabel || "NO_ENCONTRADO"}`);
  console.log(`- imagen: ${result.supplier.imageUrl || "SIN_IMAGEN"}`);

  console.log("\nPlan agregado:");
  console.log(`- estado: ${result.plans.status.action}`);
  console.log(`- precio: ${result.plans.price.action}`);
  console.log(`- imagen: ${result.plans.image.action}`);
  printPublicationPlans(result);

  console.log("\nResumen:");
  for (const [key, value] of Object.entries(result.summary)) {
    console.log(`- ${key}: ${value}`);
  }
  console.log(`- warnings: ${result.warnings.length}`);
  console.log(`- errors: ${result.errors.length}`);
  console.log(`\nResultado guardado en: ${RESULT_FILE}`);
  console.log("NO SE REALIZARON ESCRITURAS.");
}

async function syncProduct(sourceSku, dependencies = {}) {
  const normalizedSku = normalizeSku(sourceSku);
  const result = {
    sourceSku,
    normalizedSku,
    matchedCode: null,
    matchType: null,
    classification: "",
    dryRun: true,
    writeOperationsAvailable: false,
    supplier: null,
    tiendanube: {
      matchCount: 0,
      productIds: [],
      variantIds: [],
      matches: [],
      legacyGroup: null,
    },
    plans: {
      status: null,
      price: null,
      image: null,
    },
    summary: null,
    warnings: [],
    errors: [],
    timestamp: new Date().toISOString(),
  };

  if (!String(sourceSku || "").trim()) {
    const error = new Error('Falta SKU. Ejecuta: npm run sync:test -- "415 0549 10"');
    error.code = "SOURCE_SKU_REQUIRED";
    throw error;
  }

  getTiendanubeConfig();
  const client = dependencies.client || createTiendanubeReadOnlyClient();
  const supplierProduct = await (dependencies.extractArcoreProduct || extractArcoreProduct)(
    sourceSku,
  );

  result.matchedCode = supplierProduct.matchedCode || supplierProduct.codigo || null;
  result.matchType = supplierProduct.matchType || null;
  result.supplier = {
    sourceSku,
    matchedCode: result.matchedCode,
    matchType: result.matchType,
    availability: supplierProduct.estadoDisponibilidad,
    availabilitySource: supplierProduct.availabilitySource || null,
    supplierPrice: supplierProduct.precio,
    priceSourceLabel: supplierProduct.priceSourceLabel || null,
    imageUrl: supplierProduct.imageUrl || null,
  };

  const lookup = await classifyTiendanube(sourceSku, normalizedSku, client);
  result.classification = lookup.classification;
  result.tiendanube = {
    matchCount: lookup.reportedMatches.length,
    productIds: lookup.reportedMatches.map((match) => match.productId),
    variantIds: lookup.reportedMatches.map((match) => match.variantId),
    matches: lookup.reportedMatches.map(basicMatch),
    legacyGroup: lookup.legacyGroup,
  };

  if (lookup.classification === "MANUAL_REVIEW") {
    result.errors.push({
      code: "MANUAL_REVIEW",
      message: lookup.legacyGroup
        ? "El LEGACY_GROUP no coincide exactamente con el registro historico."
        : "El SKU no legacy tiene multiples coincidencias normalizadas.",
      issues: lookup.legacyGroup?.issues,
    });
  }

  result.plans.status = buildStatusPlan({
    classification: lookup.classification,
    matches: lookup.matches,
    availability: supplierProduct.estadoDisponibilidad,
  });
  result.plans.price = buildPricePlan({
    classification: lookup.classification,
    matches: lookup.matches,
    supplierPrice: supplierProduct.precio,
  });
  result.plans.image = await buildImagePlan({
    classification: lookup.classification,
    matches: lookup.matches,
    sourceImageUrl: supplierProduct.imageUrl,
    client,
  });
  result.summary = buildSummary(result.classification, result.plans);
  addPlanMessages(result);

  return result;
}

async function main() {
  const sourceSku = process.argv[2] || "";
  let result = null;

  console.log("=== ORQUESTADOR DRY-RUN - NO SE REALIZARAN ESCRITURAS ===");
  if (String(process.env.TIENDANUBE_DRY_RUN || "").trim().toLowerCase() === "false") {
    console.log("TIENDANUBE_DRY_RUN=false fue ignorado por este comando.");
  }

  try {
    result = await syncProduct(sourceSku);
    writeResult(result);
    printResult(result);
    process.exitCode = result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    result = result || {
      sourceSku,
      normalizedSku: normalizeSku(sourceSku),
      classification: "ERROR",
      dryRun: true,
      writeOperationsAvailable: false,
      warnings: [],
      errors: [],
      timestamp: new Date().toISOString(),
    };
    result.errors.push(serializeError(error));
    writeResult(result);

    console.error("\nError en sync:test:");
    console.error(`- codigo: ${error.code || "ERROR"}`);
    console.error(`- mensaje: ${error.message}`);
    console.error(`- resultado parcial: ${RESULT_FILE}`);
    console.error("NO SE REALIZARON ESCRITURAS.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  RESULT_FILE,
  buildSummary,
  classifyTiendanube,
  main,
  syncProduct,
};
