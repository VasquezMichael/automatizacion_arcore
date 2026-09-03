const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const dotenv = require("dotenv");
const { loadStorageState } = require("../session");
const { ensureAuthenticatedSession, extractCode } = require("../extractByCodesTest");
const { normalizeProduct } = require("../normalizer/productNormalizer");
const { createTiendanubeClient, getTiendanubeConfig } = require("./client");
const {
  findSkuMatches,
  getProductVariantById,
  getLegacyGroupMatches,
  updateVariantPrice,
} = require("./products");
const { getLegacySkuGroup } = require("./legacySkuGroups");
const { normalizeSku } = require("./sku");
const {
  calculateSalePrice,
  moneyDifference,
  moneyEquals,
  parseMoney,
} = require("../pricing/priceCalculator");

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "output");
const RESULT_FILE = path.resolve(OUTPUT_DIR, "tiendanube-test-price.json");

function isDryRun() {
  const value = String(process.env.TIENDANUBE_DRY_RUN || "true").trim().toLowerCase();
  return value !== "false";
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function writeResult(result) {
  ensureOutputDir();
  fs.writeFileSync(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
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
      code: error.code || undefined,
      value: error.value,
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

function decidePriceAction({ calculatedPrice, currentPrice }) {
  if (currentPrice === null) {
    return {
      action: "MANUAL_REVIEW",
      difference: null,
      reason: "Tiendanube no devolvio un precio utilizable para comparar.",
    };
  }

  const difference = moneyDifference(calculatedPrice, currentPrice);
  if (moneyEquals(calculatedPrice, currentPrice)) {
    return {
      action: "PRICE_NO_CHANGE",
      difference,
      reason: "El precio actual coincide normalizado a 2 decimales.",
    };
  }

  return {
    action: "PRICE_UPDATE",
    difference,
    reason: "El precio actual difiere del precio calculado.",
  };
}

function analyzePublicationPrice(match, calculatedPrice) {
  const currentPrice = parseMoney(match.price);
  const decision = decidePriceAction({ calculatedPrice, currentPrice });

  return {
    productId: match.productId,
    variantId: match.variantId,
    sku: match.sku,
    name: pickName(match.name),
    published: match.published,
    currentPrice,
    rawCurrentPrice: match.price,
    oldPrice: currentPrice,
    requestedPrice: calculatedPrice,
    verifiedPrice: null,
    difference: decision.difference,
    action: decision.action,
    reason: decision.reason,
    writeAttempted: false,
    writeSucceeded: false,
    verified: decision.action === "PRICE_NO_CHANGE",
    updated: false,
    errors: [],
  };
}

function aggregatePublicationAction(publications) {
  const actions = publications.map((publication) => publication.action);
  const updatedCount = publications.filter((publication) => publication.updated).length;
  const failedCount = publications.filter((publication) =>
    ["MANUAL_REVIEW", "PRICE_UPDATE_FAILED", "PRICE_UPDATE_VERIFICATION_FAILED"].includes(
      publication.action,
    ),
  ).length;

  if (actions.includes("PRICE_WRITE_BLOCKED")) return "PRICE_WRITE_BLOCKED";
  if (updatedCount > 0 && failedCount > 0) return "LEGACY_PRICE_PARTIAL_FAILURE";
  if (actions.includes("MANUAL_REVIEW")) return "MANUAL_REVIEW";
  if (actions.includes("PRICE_UPDATE")) return "PRICE_UPDATE";
  if (actions.includes("PRICE_UPDATE_FAILED")) return "PRICE_UPDATE_FAILED";
  if (actions.includes("PRICE_UPDATE_VERIFICATION_FAILED")) {
    return "PRICE_UPDATE_VERIFICATION_FAILED";
  }
  if (actions.includes("PRICE_UPDATED")) return "PRICE_UPDATED";
  if (actions.length > 0 && actions.every((action) => action === "PRICE_NO_CHANGE")) {
    return "PRICE_NO_CHANGE";
  }
  return "MANUAL_REVIEW";
}

function calculatePublicationCounters(publications) {
  return {
    totalPublications: publications.length,
    noChangeCount: publications.filter(
      (publication) => publication.action === "PRICE_NO_CHANGE",
    ).length,
    updatedCount: publications.filter((publication) => publication.updated).length,
    failedCount: publications.filter((publication) =>
      [
        "MANUAL_REVIEW",
        "PRICE_UPDATE_FAILED",
        "PRICE_UPDATE_VERIFICATION_FAILED",
      ].includes(publication.action),
    ).length,
  };
}

function applyAggregateTrace(result) {
  const attemptedPublications = result.publications.filter(
    (publication) => publication.writeAttempted,
  );
  const counters = calculatePublicationCounters(result.publications);

  result.writeAttempted = attemptedPublications.length > 0;
  result.anyWriteSucceeded = result.publications.some(
    (publication) => publication.writeSucceeded,
  );
  result.allWritesSucceeded =
    attemptedPublications.length > 0 &&
    attemptedPublications.every((publication) => publication.writeSucceeded);
  result.allVerified =
    result.publications.length > 0 &&
    result.publications.every((publication) => publication.verified);
  result.anyUpdated = result.publications.some((publication) => publication.updated);

  if (result.type === "LEGACY_GROUP") {
    // LEGACY_GROUP root flags describe the whole group, not partial success.
    result.writeSucceeded = result.allWritesSucceeded;
    result.verified = result.allVerified;
    result.updated = result.allVerified && result.anyUpdated && counters.failedCount === 0;
  } else {
    result.writeSucceeded = result.anyWriteSucceeded;
    result.verified = result.allVerified;
    result.updated = result.anyUpdated;
  }

  Object.assign(result, counters);
}

function printKnownWriteState(result, writer = console.log) {
  if (result.action === "LEGACY_PRICE_PARTIAL_FAILURE") {
    writer("El grupo quedo parcialmente sincronizado. Revisar publicaciones fallidas.");
    return;
  }

  if (result.action === "PRICE_UPDATED") {
    writer("Precio de variante actualizado y verificado.");
    return;
  }

  if (result.action === "PRICE_NO_CHANGE") {
    writer("Todas las publicaciones ya coincidian con el precio calculado.");
    return;
  }

  if (result.action === "PRICE_UPDATE_FAILED") {
    writer("Fallo la actualizacion de precio. Revisar detalle de errores.");
    return;
  }

  if (result.action === "PRICE_UPDATE_VERIFICATION_FAILED") {
    writer(
      "El PUT fue exitoso, pero la verificacion posterior no confirmo el precio solicitado.",
    );
    return;
  }

  if (result.action === "MANUAL_REVIEW") {
    writer("El resultado requiere revision manual. No se confirma sincronizacion completa.");
    return;
  }

  if (result.writeSucceeded) {
    writer(
      "El PUT fue exitoso, pero la actualizacion no quedo verificada como exitosa.",
    );
  } else if (result.writeAttempted) {
    writer("Se intento escritura, pero el PUT no quedo registrado como exitoso.");
  } else {
    writer("No se realizaron escrituras.");
  }
}

function initResult(sourceSku, dryRun) {
  return {
    sourceSku,
    normalizedSku: normalizeSku(sourceSku),
    type: "",
    productId: null,
    variantId: null,
    supplierPrice: null,
    category: null,
    multiplier: null,
    baseCalculatedPrice: null,
    calculatedPrice: null,
    currentPrice: null,
    oldPrice: null,
    requestedPrice: null,
    verifiedPrice: null,
    difference: null,
    action: "",
    dryRun,
    writeAttempted: false,
    writeSucceeded: false,
    verified: false,
    updated: false,
    totalPublications: 0,
    noChangeCount: 0,
    updatedCount: 0,
    failedCount: 0,
    warnings: [],
    errors: [],
    publications: [],
    timestamp: new Date().toISOString(),
  };
}

function applyPricingResult(result, pricing) {
  result.supplierPrice = pricing.supplierPrice;
  result.category = pricing.category;
  result.multiplier = pricing.multiplier;
  result.baseCalculatedPrice = pricing.baseCalculatedPrice;
  result.calculatedPrice = pricing.calculatedPrice;

  if (pricing.supplierPrice === 0) {
    result.warnings.push({
      code: "ZERO_SUPPLIER_PRICE",
      message:
        "El precio proveedor es 0. El motor lo calcula, pero requiere revision comercial antes de escrituras reales.",
    });
  }
}

async function revalidatePublicationBeforeWrite({
  publication,
  expectedNormalizedSku,
  client,
}) {
  let variant;
  try {
    variant = await getProductVariantById(
      publication.productId,
      publication.variantId,
      client,
    );
  } catch (error) {
    publication.action = "MANUAL_REVIEW";
    publication.reason = "No se pudo revalidar la variante antes del PUT.";
    publication.errors.push({
      code: "PRICE_WRITE_REVALIDATION_FAILED",
      productId: publication.productId,
      variantId: publication.variantId,
      expectedNormalizedSku,
      ...serializeError(error),
    });
    return false;
  }

  const actualVariantId = variant?.id;
  const actualProductId = variant?.product_id || variant?.productId || null;
  const actualNormalizedSku = normalizeSku(variant?.sku);

  if (
    !variant ||
    String(actualVariantId) !== String(publication.variantId) ||
    (actualProductId !== null && String(actualProductId) !== String(publication.productId)) ||
    actualNormalizedSku !== expectedNormalizedSku
  ) {
    publication.action = "MANUAL_REVIEW";
    publication.reason = "La variante cambio entre la validacion inicial y el PUT.";
    publication.errors.push({
      code: "PRICE_WRITE_REVALIDATION_FAILED",
      productId: publication.productId,
      actualProductId,
      expectedVariantId: publication.variantId,
      actualVariantId: actualVariantId || null,
      expectedNormalizedSku,
      actualNormalizedSku,
    });
    return false;
  }

  return true;
}

async function writePublicationPrice({ publication, expectedNormalizedSku, client }) {
  const revalidated = await revalidatePublicationBeforeWrite({
    publication,
    expectedNormalizedSku,
    client,
  });
  if (!revalidated) return;

  publication.writeAttempted = true;

  try {
    await updateVariantPrice(
      publication.productId,
      publication.variantId,
      publication.requestedPrice,
      client,
    );
  } catch (error) {
    publication.action = "PRICE_UPDATE_FAILED";
    publication.errors.push({
      code: "PRICE_UPDATE_FAILED",
      ...serializeError(error),
    });
    return;
  }

  publication.writeSucceeded = true;

  let verifiedVariant;
  try {
    verifiedVariant = await getProductVariantById(
      publication.productId,
      publication.variantId,
      client,
    );
  } catch (error) {
    publication.action = "PRICE_UPDATE_VERIFICATION_FAILED";
    publication.errors.push({
      code: "PRICE_UPDATE_VERIFICATION_FAILED",
      oldPrice: publication.oldPrice,
      requestedPrice: publication.requestedPrice,
      verifiedPrice: null,
      ...serializeError(error),
    });
    return;
  }

  const verifiedPrice = parseMoney(verifiedVariant?.price);
  publication.verifiedPrice = verifiedPrice;

  if (moneyEquals(verifiedPrice, publication.requestedPrice)) {
    publication.action = "PRICE_UPDATED";
    publication.verified = true;
    publication.updated = true;
    return;
  }

  publication.action = "PRICE_UPDATE_VERIFICATION_FAILED";
  publication.errors.push({
    code: "PRICE_UPDATE_VERIFICATION_FAILED",
    message: "El PUT respondio OK, pero el precio verificado no coincide.",
    oldPrice: publication.oldPrice,
    requestedPrice: publication.requestedPrice,
    verifiedPrice,
  });
}

async function writeSinglePriceIfAllowed({ result, publication, client, dryRun }) {
  result.oldPrice = publication.oldPrice;
  result.requestedPrice = publication.requestedPrice;

  if (result.supplierPrice === 0) {
    result.action = "PRICE_WRITE_BLOCKED";
    publication.action = "PRICE_WRITE_BLOCKED";
    publication.reason =
      "Precio proveedor cero. Requiere revision antes de habilitar escritura real.";
    result.warnings.push({
      code: "ZERO_SUPPLIER_PRICE",
      message:
        "Precio proveedor cero. No se actualiza Tiendanube hasta revision manual.",
    });
    return;
  }

  if (publication.action !== "PRICE_UPDATE" || dryRun) {
    return;
  }

  await writePublicationPrice({
    publication,
    expectedNormalizedSku: result.normalizedSku,
    client,
  });

  result.writeAttempted = publication.writeAttempted;
  result.writeSucceeded = publication.writeSucceeded;
  result.verified = publication.verified;
  result.updated = publication.updated;
  result.verifiedPrice = publication.verifiedPrice;
  result.action = publication.action;
  result.errors.push(...publication.errors);
}

function blockZeroPriceWrites(result) {
  result.action = "PRICE_WRITE_BLOCKED";
  result.warnings.push({
    code: "ZERO_SUPPLIER_PRICE",
    message: "Precio proveedor cero. No se actualiza Tiendanube hasta revision manual.",
  });

  for (const publication of result.publications) {
    publication.action = "PRICE_WRITE_BLOCKED";
    publication.reason =
      "Precio proveedor cero. Requiere revision antes de habilitar escritura real.";
    publication.verified = false;
  }

  result.writeAttempted = false;
  result.writeSucceeded = false;
  result.verified = false;
  result.updated = false;
}

async function writeLegacyGroupPricesIfAllowed({ result, client, dryRun }) {
  if (result.supplierPrice === 0) {
    blockZeroPriceWrites(result);
    applyAggregateTrace(result);
    return;
  }

  if (dryRun) {
    applyAggregateTrace(result);
    return;
  }

  for (const publication of result.publications) {
    if (publication.action !== "PRICE_UPDATE") continue;

    await writePublicationPrice({
      publication,
      expectedNormalizedSku: result.normalizedSku,
      client,
    });
  }

  for (const publication of result.publications) {
    result.errors.push(...publication.errors);
  }

  result.action = aggregatePublicationAction(result.publications);
  applyAggregateTrace(result);
}

async function main() {
  const sourceSku = process.argv[2] || process.env.TIENDANUBE_TEST_SKU || "";
  const dryRun = isDryRun();
  const result = initResult(sourceSku, dryRun);

  try {
    ensureOutputDir();

    if (!sourceSku.trim()) {
      throw new Error(
        "Falta SKU. Ejecuta: npm run tiendanube:test-price -- \"415 0549 10\"",
      );
    }

    getTiendanubeConfig();
    const client = createTiendanubeClient();

    console.log("=== POC DE PRECIOS ===\n");
    console.log("Proteccion:");
    console.log("- Escritura real habilitable solo para SINGLE seguro.");
    console.log("- LEGACY_GROUP escribe solo si valida exactamente el registro historico.");
    console.log(`- dryRun: ${dryRun}\n`);
    console.log("SKU solicitado:");
    console.log(`- sourceSku: ${sourceSku}`);
    console.log(`- normalizedSku: ${result.normalizedSku}`);

    const arcoreProduct = await getArcoreProduct(sourceSku);

    console.log("\nArcore:");
    console.log(`- matchedCode: ${arcoreProduct.matchedCode || arcoreProduct.codigo}`);
    console.log(`- precio proveedor: ${arcoreProduct.precio}`);

    let pricing;
    try {
      pricing = calculateSalePrice(arcoreProduct.precio);
      applyPricingResult(result, pricing);
    } catch (error) {
      result.action = error.code || "INVALID_SUPPLIER_PRICE";
      result.errors.push({
        code: error.code || "INVALID_SUPPLIER_PRICE",
        ...serializeError(error),
      });
      console.log("\nDecision:");
      console.log(`- accion requerida: ${result.action}`);
      console.log("- No se realizaron escrituras.");
      writeResult(result);
      process.exitCode = 1;
      return;
    }

    console.log(`- categoria: ${pricing.category}`);
    console.log(`- coeficiente: ${pricing.multiplier}`);
    console.log(`- precio base calculado: ${pricing.baseCalculatedPrice}`);
    console.log(`- precio final redondeado: ${pricing.calculatedPrice}`);

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
        console.log("- No se realizaron escrituras.");
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
          message: "El POC de precio SINGLE requiere exactamente un match seguro.",
          matches: skuMatches.matches,
        });
        console.log("\nDecision:");
        console.log("- accion requerida: MANUAL_REVIEW");
        console.log("- No se realizaron escrituras.");
        writeResult(result);
        process.exitCode = 1;
        return;
      }

      matches = skuMatches.matches;
      result.productId = matches[0].productId;
      result.variantId = matches[0].variantId;
    }

    console.log("\nComparando precios:");
    for (const match of matches) {
      const publication = analyzePublicationPrice(match, pricing.calculatedPrice);
      result.publications.push(publication);
      console.log(
        `- productId: ${publication.productId} | variantId: ${publication.variantId} | actual: ${publication.currentPrice} | diferencia: ${publication.difference} | accion: ${publication.action}`,
      );
    }

    if (result.type === "SINGLE") {
      const publication = result.publications[0];
      result.currentPrice = publication.currentPrice;
      result.oldPrice = publication.oldPrice;
      result.requestedPrice = publication.requestedPrice;
      result.difference = publication.difference;
      result.action = publication.action;
      await writeSinglePriceIfAllowed({ result, publication, client, dryRun });
      applyAggregateTrace(result);
    } else {
      result.action = aggregatePublicationAction(result.publications);
      await writeLegacyGroupPricesIfAllowed({ result, client, dryRun });
    }

    console.log("\nDecision:");
    console.log(`- accion calculada: ${result.action}`);
    console.log(`- escritura intentada: ${result.writeAttempted}`);
    console.log(`- PUT exitoso: ${result.writeSucceeded}`);
    console.log(`- verificacion exitosa: ${result.verified}`);
    console.log(`- actualizacion confirmada: ${result.updated}`);
    if (result.type === "LEGACY_GROUP") {
      console.log(`- algun PUT exitoso: ${result.anyWriteSucceeded}`);
      console.log(`- todos los PUT intentados exitosos: ${result.allWritesSucceeded}`);
      console.log(`- todas las publicaciones verificadas: ${result.allVerified}`);
      console.log(`- alguna publicacion actualizada: ${result.anyUpdated}`);
    }
    console.log(`\nDry Run: ${dryRun}`);
    printKnownWriteState(result);

    writeResult(result);
    process.exitCode = result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    result.action = error.code || "ERROR";
    result.errors.push({
      code: error.code || "ERROR",
      ...serializeError(error),
    });
    writeResult(result);

    console.error("\nError en tiendanube:test-price:");
    console.error(`- mensaje: ${error.message}`);
    if (error.response) {
      console.error(`- status HTTP: ${error.response.status}`);
      console.error("- respuesta Tiendanube:");
      console.error(JSON.stringify(error.response.data, null, 2));
    }
    console.error("\nNo se imprime el access token por seguridad.");
    console.error(`- escritura intentada: ${result.writeAttempted}`);
    console.error(`- PUT exitoso: ${result.writeSucceeded}`);
    console.error(`- verificacion exitosa: ${result.verified}`);
    console.error(`- actualizacion confirmada: ${result.updated}`);
    printKnownWriteState(result, console.error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  aggregatePublicationAction,
  applyAggregateTrace,
  analyzePublicationPrice,
  calculatePublicationCounters,
  decidePriceAction,
  main,
  printKnownWriteState,
};
