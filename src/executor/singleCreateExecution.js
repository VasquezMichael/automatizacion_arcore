const { moneyEquals } = require("../pricing/priceCalculator");
const { normalizeSku } = require("../tiendanube/sku");

const AUTOMATIC_RESOLUTIONS = new Set(["EXACT", "SAFE_TRANSFORM"]);
const ALLOWED_IMAGE_SOURCE_TYPES = new Set([
  "COVER_FULL",
  "COVER_THUMBNAIL_FALLBACK",
]);
const DEFAULT_INDEX_DELAYS_MS = Object.freeze([0, 1000, 2000, 3000, 5000]);

function safeError(error, fallbackCode) {
  return {
    code: error.code || fallbackCode,
    message: error.message,
    status: error.response?.status || error.status || null,
    ...(error.causeCode ? { causeCode: error.causeCode } : {}),
  };
}

function initializeTrace(action, normalizedSku) {
  action.normalizedSku = normalizedSku;
  action.preWriteMatchCount = null;
  action.createAttempted = false;
  action.createSucceeded = false;
  action.createdProductId = null;
  action.createdVariantId = null;
  action.postCreateMatchCount = null;
  action.indexLookupAttempts = 0;
  action.indexWaitMs = 0;
  action.indexEventuallyConsistent = false;
  action.verifiedByDirectGet = false;
  action.payloadFields = [];
  action.imageIncluded = false;
  action.writeAttempted = false;
  action.writeSucceeded = false;
  action.verified = false;
  action.updated = false;
  action.errors = action.errors || [];
  action.warnings = action.warnings || [];
}

function blockAction(action, code, message, details) {
  action.simulationResult = "BLOCKED";
  action.executionResult = "BLOCKED";
  action.errors.push({ code, message, ...(details ? { details } : {}) });
  return action;
}

function failAction(action, executionResult, error) {
  action.simulationResult = "FAILED";
  action.executionResult = executionResult;
  action.errors.push(error);
  return action;
}

function localizedText(value) {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (!value || typeof value !== "object") return "";
  const preferred = value.es || value.pt || value.en;
  const fallback = preferred || Object.values(value).find((item) => typeof item === "string");
  return typeof fallback === "string" ? fallback.replace(/\s+/g, " ").trim() : "";
}

function validImageUrl(value) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function hasValidSupplierIdentity(plan) {
  const sourceCode = normalizeSku(plan?.supplierResolution?.sourceCode);
  const matchedCode = normalizeSku(
    plan?.supplierResolution?.matchedCode || plan?.matchedCode,
  );
  if (
    !sourceCode ||
    !matchedCode ||
    sourceCode !== plan?.normalizedSku ||
    matchedCode !== normalizeSku(plan?.matchedCode)
  ) {
    return false;
  }
  if (plan.supplierResolution.type === "EXACT") return matchedCode === sourceCode;
  return (
    plan.supplierResolution.type === "SAFE_TRANSFORM" &&
    plan.supplierResolution.rule === "APPEND_TRAILING_ZERO" &&
    matchedCode === `${sourceCode}0`
  );
}

function buildCreatePayload(plan, action) {
  const desired = action.desiredState || {};
  const name = String(desired.name || "").replace(/\s+/g, " ").trim();
  const normalizedSku = normalizeSku(desired.sku);
  const price = Number(desired.price);
  const imageUrl = desired.primaryImage;

  if (
    !name ||
    !normalizedSku ||
    normalizedSku !== plan.normalizedSku ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isInteger(price) ||
    typeof desired.published !== "boolean"
  ) {
    const error = new Error("El payload minimo de CREATE_SINGLE es invalido.");
    error.code = "CREATE_PAYLOAD_INVALID";
    throw error;
  }

  if (
    imageUrl &&
    (!ALLOWED_IMAGE_SOURCE_TYPES.has(plan.supplier?.imageSourceType) ||
      !validImageUrl(imageUrl))
  ) {
    const error = new Error("La fuente de imagen de CREATE_SINGLE no es valida.");
    error.code = "CREATE_PAYLOAD_INVALID";
    throw error;
  }

  return {
    name,
    published: desired.published,
    variants: [{ sku: normalizedSku, price: String(price) }],
    ...(imageUrl ? { images: [{ src: imageUrl, position: 1 }] } : {}),
  };
}

function isEligibleSingleCreate(plan, revalidation, action) {
  const normalizedSku = normalizeSku(plan?.normalizedSku);
  const revalidatedMatches = revalidation?.matches || [];
  const planMatches = plan?.tiendanube?.matches || [];
  const calculatedPrice = Number(plan?.plans?.price?.calculation?.calculatedPrice);
  const name = String(plan?.supplier?.name || "").trim();

  return (
    plan?.classification === "CREATE_SINGLE" &&
    AUTOMATIC_RESOLUTIONS.has(plan?.supplierResolution?.type) &&
    revalidation?.ok === true &&
    revalidation?.status === "PASSED" &&
    Number(plan?.tiendanube?.matchCount) === 0 &&
    planMatches.length === 0 &&
    revalidatedMatches.length === 0 &&
    normalizedSku !== "" &&
    normalizedSku === plan.normalizedSku &&
    normalizeSku(action?.desiredState?.sku) === normalizedSku &&
    action?.type === "CREATE_PRODUCT" &&
    action?.plannedAction === "CREATE_SINGLE" &&
    action?.simulationResult === "WOULD_CREATE" &&
    name !== "" &&
    hasValidSupplierIdentity(plan) &&
    Number(plan?.supplier?.supplierPrice) > 0 &&
    Number.isFinite(calculatedPrice) &&
    calculatedPrice > 0 &&
    Number.isInteger(calculatedPrice) &&
    action?.desiredState?.price === plan.plans.price.calculation.calculatedPrice &&
    typeof action?.desiredState?.published === "boolean" &&
    plan?.supplier?.availability !== "UNKNOWN" &&
    (!action?.desiredState?.primaryImage ||
      (ALLOWED_IMAGE_SOURCE_TYPES.has(plan?.supplier?.imageSourceType) &&
        validImageUrl(action.desiredState.primaryImage) &&
        typeof plan?.plans?.image?.sourceHash === "string" &&
        plan.plans.image.sourceHash.length > 0)) &&
    plan?.tiendanube?.legacyGroup == null
  );
}

function responseVariant(product, normalizedSku) {
  const matches = (product?.variants || []).filter(
    (variant) => normalizeSku(variant.sku) === normalizedSku,
  );
  return matches.length === 1 ? matches[0] : null;
}

function validResourceId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCreatedSkuIndex({
  adapter,
  normalizedSku,
  delaysMs = DEFAULT_INDEX_DELAYS_MS,
  sleepFn = sleep,
}) {
  let indexWaitMs = 0;
  let indexLookupAttempts = 0;
  let sawEmptyIndex = false;

  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await sleepFn(delayMs);
      indexWaitMs += delayMs;
    }
    let lookup;
    try {
      lookup = await adapter.findSkuMatches(normalizedSku);
    } catch (error) {
      error.indexLookupAttempts = indexLookupAttempts + 1;
      error.indexWaitMs = indexWaitMs;
      throw error;
    }
    const matches = lookup?.matches || [];
    indexLookupAttempts += 1;
    if (matches.length === 0) {
      sawEmptyIndex = true;
      continue;
    }
    return {
      matches,
      indexLookupAttempts,
      indexWaitMs,
      indexEventuallyConsistent: sawEmptyIndex && matches.length === 1,
    };
  }

  return {
    matches: [],
    indexLookupAttempts,
    indexWaitMs,
    indexEventuallyConsistent: false,
  };
}

async function verifyProductById({
  adapter,
  productId,
  expectedVariantId,
  normalizedSku,
  payload,
}) {
  if (!validResourceId(productId)) {
    const error = new Error("CREATE no devolvio un productId valido.");
    error.code = "CREATE_IDENTITY_MISMATCH";
    throw error;
  }

  const product = await adapter.getProduct(productId);
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const relevantVariants = variants.filter(
    (variant) => normalizeSku(variant.sku) === normalizedSku,
  );
  const variant = relevantVariants[0];
  const identityOk =
    String(product?.id || "") === String(productId) &&
    variants.length === 1 &&
    relevantVariants.length === 1 &&
    validResourceId(variant?.id) &&
    (!expectedVariantId || String(variant.id) === String(expectedVariantId)) &&
    normalizeSku(variant?.sku) === normalizedSku;

  if (!identityOk) {
    const error = new Error("El GET posterior no confirmo productId, variantId y SKU unicos.");
    error.code = "CREATE_IDENTITY_MISMATCH";
    throw error;
  }
  if (!moneyEquals(variant.price, payload.variants[0].price)) {
    const error = new Error("El GET posterior no confirmo el precio creado.");
    error.code = "CREATE_WRITE_VERIFICATION_FAILED";
    throw error;
  }
  if (product.published !== payload.published) {
    const error = new Error("El GET posterior no confirmo published.");
    error.code = "CREATE_WRITE_VERIFICATION_FAILED";
    throw error;
  }
  if (localizedText(product.name) !== localizedText(payload.name)) {
    const error = new Error("El GET posterior no confirmo el nombre enviado.");
    error.code = "CREATE_WRITE_VERIFICATION_FAILED";
    throw error;
  }
  if (payload.images) {
    const images = await adapter.listProductImages(product.id);
    const primary = Array.isArray(images)
      ? images.filter((image) => Number(image?.position) === 1)
      : [];
    if (
      !Array.isArray(images) ||
      images.length !== 1 ||
      primary.length !== 1 ||
      !validResourceId(primary[0]?.id)
    ) {
      const error = new Error("El GET posterior no confirmo la imagen primaria enviada.");
      error.code = "CREATE_WRITE_VERIFICATION_FAILED";
      throw error;
    }
  }

  return { product, variant };
}

async function verifyCreatedProduct({
  adapter,
  action,
  payload,
  responseProduct,
  ambiguousWrite,
  polling = {},
}) {
  const normalizedSku = action.normalizedSku;
  const responseProductId = responseProduct?.id ?? null;
  const responseVariantId = responseVariant(responseProduct, normalizedSku)?.id ?? null;
  let directVerification = null;
  let directReadError = null;

  if (responseProductId !== null) {
    action.createdProductId = responseProductId;
    action.createdVariantId = responseVariantId;
    try {
      directVerification = await verifyProductById({
        adapter,
        productId: responseProductId,
        expectedVariantId: responseVariantId,
        normalizedSku,
        payload,
      });
      action.createdProductId = directVerification.product.id;
      action.createdVariantId = directVerification.variant.id;
      action.productId = directVerification.product.id;
      action.variantId = directVerification.variant.id;
      action.verifiedByDirectGet = true;
    } catch (error) {
      if (
        error.code === "CREATE_IDENTITY_MISMATCH" ||
        error.code === "CREATE_WRITE_VERIFICATION_FAILED"
      ) {
        throw error;
      }
      directReadError = error;
    }
  }

  let indexResult;
  try {
    indexResult = await waitForCreatedSkuIndex({
      adapter,
      normalizedSku,
      delaysMs: polling.delaysMs || DEFAULT_INDEX_DELAYS_MS,
      sleepFn: polling.sleepFn || sleep,
    });
  } catch (error) {
    action.indexLookupAttempts = error.indexLookupAttempts || 0;
    action.indexWaitMs = error.indexWaitMs || 0;
    if (directVerification) {
      action.warnings.push({
        code: "CREATE_SKU_INDEX_PENDING",
        message: "El producto fue verificado por GET directo, pero el indice SKU no pudo confirmarse.",
        details: safeError(error, "CREATE_INDEX_LOOKUP_FAILED"),
      });
      return;
    }
    throw error;
  }

  const matches = indexResult.matches;
  action.postCreateMatchCount = matches.length;
  action.indexLookupAttempts = indexResult.indexLookupAttempts;
  action.indexWaitMs = indexResult.indexWaitMs;
  action.indexEventuallyConsistent = indexResult.indexEventuallyConsistent;

  if (matches.length > 1) {
    const error = new Error("Aparecieron multiples publicaciones despues de CREATE.");
    error.code = "CREATE_MULTIPLE_MATCHES_AFTER_WRITE";
    error.details = { matchCount: matches.length };
    throw error;
  }

  if (matches.length === 0) {
    if (directVerification) {
      action.warnings.push({
        code: "CREATE_SKU_INDEX_PENDING",
        message: "El producto fue verificado por GET directo, pero el indice SKU sigue pendiente.",
        details: {
          attempts: action.indexLookupAttempts,
          waitedMs: action.indexWaitMs,
        },
      });
      return;
    }
    const error = new Error("La publicacion creada no aparece en la busqueda por SKU.");
    error.code = ambiguousWrite
      ? "CREATE_WRITE_AMBIGUOUS"
      : "CREATE_WRITE_VERIFICATION_FAILED";
    error.details = {
      matchCount: 0,
      ...(directReadError
        ? { directReadError: safeError(directReadError, "CREATE_DIRECT_GET_FAILED") }
        : {}),
    };
    throw error;
  }

  const match = matches[0];
  if (
    (responseProductId && String(responseProductId) !== String(match.productId)) ||
    (responseVariantId && String(responseVariantId) !== String(match.variantId)) ||
    (directVerification &&
      (String(directVerification.product.id) !== String(match.productId) ||
        String(directVerification.variant.id) !== String(match.variantId)))
  ) {
    const error = new Error("La identidad devuelta por CREATE no coincide con la busqueda por SKU.");
    error.code = "CREATE_IDENTITY_MISMATCH";
    error.details = {
      responseProductId,
      matchedProductId: match.productId,
      responseVariantId,
      matchedVariantId: match.variantId,
    };
    throw error;
  }

  const verified = directVerification || await verifyProductById({
    adapter,
    productId: match.productId,
    expectedVariantId: match.variantId,
    normalizedSku,
    payload,
  });
  action.createdProductId = verified.product.id;
  action.createdVariantId = verified.variant.id;
  action.productId = verified.product.id;
  action.variantId = verified.variant.id;
}

async function executeSingleCreate({ plan, revalidation, action, adapter, polling }) {
  initializeTrace(action, plan.normalizedSku);

  if (!isEligibleSingleCreate(plan, revalidation, action)) {
    return blockAction(
      action,
      "CREATE_NOT_ELIGIBLE",
      "CREATE_SINGLE no cumple todas las condiciones de identidad e integridad.",
    );
  }

  let payload;
  try {
    payload = buildCreatePayload(plan, action);
  } catch (error) {
    return blockAction(action, error.code || "CREATE_PAYLOAD_INVALID", error.message);
  }
  action.payloadFields = Object.keys(payload).sort();
  action.imageIncluded = Boolean(payload.images);

  let preWrite;
  try {
    preWrite = await adapter.findSkuMatches(action.normalizedSku);
  } catch (error) {
    return blockAction(
      action,
      "CREATE_PREWRITE_SEARCH_FAILED",
      "Fallo la busqueda anti-duplicado inmediatamente anterior al POST.",
      safeError(error, "CREATE_PREWRITE_SEARCH_FAILED"),
    );
  }
  const preWriteMatches = preWrite?.matches || [];
  action.preWriteMatchCount = preWriteMatches.length;
  if (preWriteMatches.length === 1) {
    return blockAction(
      action,
      "CREATE_DUPLICATE_GUARD_TRIGGERED",
      "El SKU ya existe al momento de crear; no se ejecuto POST.",
    );
  }
  if (preWriteMatches.length > 1) {
    return blockAction(
      action,
      "CRITICAL_DUPLICATE_STATE",
      "Existen multiples publicaciones para el SKU; CREATE queda bloqueado.",
      { matchCount: preWriteMatches.length },
    );
  }

  let responseProduct = null;
  let ambiguousWrite = false;
  action.createAttempted = true;
  action.writeAttempted = true;
  try {
    responseProduct = await adapter.createProduct(payload);
    action.createSucceeded = true;
    action.createdProductId = responseProduct?.id ?? null;
    action.createdVariantId = responseVariant(
      responseProduct,
      action.normalizedSku,
    )?.id ?? null;
  } catch (error) {
    if (!error.ambiguous && error.code !== "CREATE_WRITE_AMBIGUOUS") {
      return failAction(action, "WRITE_FAILED", safeError(error, "CREATE_WRITE_FAILED"));
    }
    ambiguousWrite = true;
    action.warnings.push(
      safeError(error, "CREATE_WRITE_AMBIGUOUS"),
    );
  }

  try {
    await verifyCreatedProduct({
      adapter,
      action,
      payload,
      responseProduct,
      ambiguousWrite,
      polling,
    });
    action.writeSucceeded = true;
    action.verified = true;
    action.updated = true;
    action.simulationResult = "PASSED";
    action.executionResult = "WRITE_SUCCEEDED";
    if (ambiguousWrite) {
      action.warnings.push({
        code: "CREATE_WRITE_AMBIGUOUS_RECOVERED",
        message: "La respuesta del POST fue ambigua, pero el producto unico fue verificado por SKU y GET.",
      });
    }
    return action;
  } catch (error) {
    const rawCode = error.code || "CREATE_WRITE_VERIFICATION_FAILED";
    const preservedCodes = new Set([
      "CREATE_IDENTITY_MISMATCH",
      "CREATE_MULTIPLE_MATCHES_AFTER_WRITE",
      "CREATE_WRITE_AMBIGUOUS",
      "CREATE_WRITE_VERIFICATION_FAILED",
    ]);
    const code = preservedCodes.has(rawCode)
      ? rawCode
      : "CREATE_WRITE_VERIFICATION_FAILED";
    const serialized = safeError(error, code);
    serialized.code = code;
    if (rawCode !== code) serialized.causeCode = rawCode;
    if (error.details) serialized.details = error.details;
    if (code === "CREATE_MULTIPLE_MATCHES_AFTER_WRITE") {
      return failAction(action, "WRITE_VERIFICATION_FAILED", serialized);
    }
    return failAction(action, "WRITE_VERIFICATION_FAILED", serialized);
  }
}

module.exports = {
  buildCreatePayload,
  executeSingleCreate,
  isEligibleSingleCreate,
  localizedText,
  waitForCreatedSkuIndex,
};
