const { moneyEquals, parseMoney } = require("../pricing/priceCalculator");
const { normalizeSku } = require("../tiendanube/sku");

const AUTOMATIC_RESOLUTIONS = new Set(["EXACT", "SAFE_TRANSFORM"]);

function safeError(error, code) {
  return {
    code,
    message: error.message,
    status: error.response?.status || error.status || null,
  };
}

function failAction(action, executionResult, error) {
  action.executionResult = executionResult;
  action.errors.push(error);
  return action;
}

function blockAction(action, code, message, details) {
  action.simulationResult = "BLOCKED";
  return failAction(action, "BLOCKED", {
    code,
    message,
    ...(details ? { details } : {}),
  });
}

function findProductVariant(product, variantId) {
  return (product?.variants || []).find(
    (variant) => String(variant.id) === String(variantId),
  );
}

function validateIdentity({ product, variant, action, normalizedSku }) {
  const productIdMatches = String(product?.id || "") === String(action.productId);
  const productVariant = findProductVariant(product, action.variantId);
  const variantIdMatches = String(variant?.id || "") === String(action.variantId);
  const variantProductId = variant?.product_id ?? variant?.productId;
  const parentMatches =
    variantProductId === undefined ||
    variantProductId === null ||
    String(variantProductId) === String(action.productId);
  const productSkuMatches = normalizeSku(productVariant?.sku) === normalizedSku;
  const variantSkuMatches = normalizeSku(variant?.sku) === normalizedSku;

  if (
    productIdMatches &&
    productVariant &&
    variantIdMatches &&
    parentMatches &&
    productSkuMatches &&
    variantSkuMatches
  ) {
    return null;
  }

  return {
    expectedProductId: action.productId,
    actualProductId: product?.id ?? null,
    expectedVariantId: action.variantId,
    productVariantId: productVariant?.id ?? null,
    actualVariantId: variant?.id ?? null,
    variantProductId: variantProductId ?? null,
    expectedNormalizedSku: normalizedSku,
    productNormalizedSku: normalizeSku(productVariant?.sku),
    variantNormalizedSku: normalizeSku(variant?.sku),
  };
}

function isEligibleSinglePriceUpdate(plan, revalidation, action) {
  const supplierPrice = parseMoney(plan?.supplier?.supplierPrice);
  const targetPrice = parseMoney(action?.desiredState?.price);
  const currentPricePlan = revalidation?.plans?.price;
  const currentMatches = revalidation?.matches || [];
  const currentMatch = currentMatches[0];
  const currentPublication = (currentPricePlan?.publications || []).find(
    (publication) =>
      String(publication.productId) === String(action?.productId) &&
      String(publication.variantId) === String(action?.variantId),
  );

  return (
    plan?.classification === "SINGLE" &&
    AUTOMATIC_RESOLUTIONS.has(plan?.supplierResolution?.type) &&
    revalidation?.ok === true &&
    currentMatches.length === 1 &&
    String(currentMatch?.productId) === String(action?.productId) &&
    String(currentMatch?.variantId) === String(action?.variantId) &&
    normalizeSku(currentMatch?.sku) === plan?.normalizedSku &&
    action?.type === "PRICE" &&
    action?.plannedAction === "PRICE_UPDATE" &&
    action?.simulationResult === "WOULD_UPDATE" &&
    currentPricePlan?.action === "PRICE_UPDATE" &&
    currentPublication?.action === "PRICE_UPDATE" &&
    supplierPrice !== null &&
    supplierPrice > 0 &&
    targetPrice !== null &&
    targetPrice > 0 &&
    Number.isInteger(targetPrice)
  );
}

async function executePricePublication({ plan, action, adapter }) {
  const targetPrice = parseMoney(action.desiredState.price);
  let product;
  let variant;

  try {
    [product, variant] = await Promise.all([
      adapter.getProduct(action.productId),
      adapter.getProductVariant(action.productId, action.variantId),
    ]);
  } catch (error) {
    return blockAction(
      action,
      "PRICE_PREWRITE_READ_FAILED",
      "No se pudo revalidar el producto y la variante inmediatamente antes del PUT.",
      safeError(error, "PRICE_PREWRITE_READ_FAILED"),
    );
  }

  const identityIssue = validateIdentity({
    product,
    variant,
    action,
    normalizedSku: plan.normalizedSku,
  });
  if (identityIssue) {
    return blockAction(
      action,
      "PRICE_PREWRITE_IDENTITY_MISMATCH",
      "La identidad productId/variantId/SKU cambio antes del PUT.",
      identityIssue,
    );
  }

  const currentPrice = parseMoney(variant.price);
  action.preWriteState = { price: currentPrice };
  if (moneyEquals(currentPrice, targetPrice)) {
    action.simulationResult = "SKIPPED_ALREADY_APPLIED";
    action.executionResult = "SKIPPED_ALREADY_APPLIED";
    action.verifiedState = { price: currentPrice };
    action.verified = true;
    return action;
  }
  if (!moneyEquals(currentPrice, action.currentState.price)) {
    return blockAction(
      action,
      "PRICE_PREWRITE_STATE_CHANGED",
      "El precio cambio antes del PUT y no coincide con el valor planificado ni con el objetivo.",
      {
        plannedCurrentPrice: action.currentState.price,
        actualCurrentPrice: currentPrice,
        targetPrice,
      },
    );
  }

  action.writeAttempted = true;
  try {
    await adapter.updateVariantPrice(action.productId, action.variantId, targetPrice);
    action.writeSucceeded = true;
  } catch (error) {
    return failAction(
      action,
      "WRITE_FAILED",
      safeError(error, "PRICE_WRITE_FAILED"),
    );
  }

  let verifiedVariant;
  try {
    verifiedVariant = await adapter.getProductVariant(
      action.productId,
      action.variantId,
    );
  } catch (error) {
    return failAction(
      action,
      "WRITE_VERIFICATION_FAILED",
      safeError(error, "PRICE_WRITE_VERIFICATION_FAILED"),
    );
  }

  const verifiedIdentityIssue = validateIdentity({
    product,
    variant: verifiedVariant,
    action,
    normalizedSku: plan.normalizedSku,
  });
  const verifiedPrice = parseMoney(verifiedVariant.price);
  action.verifiedState = { price: verifiedPrice };

  if (!verifiedIdentityIssue && moneyEquals(verifiedPrice, targetPrice)) {
    action.executionResult = "WRITE_SUCCEEDED";
    action.verified = true;
    action.updated = true;
    return action;
  }

  return failAction(action, "WRITE_VERIFICATION_FAILED", {
    code: "PRICE_WRITE_VERIFICATION_FAILED",
    message: "El PUT respondio exitosamente, pero el GET posterior no confirmo el precio.",
    details: {
      targetPrice,
      verifiedPrice,
      identity: verifiedIdentityIssue,
    },
  });
}

async function executeSinglePriceUpdate({ plan, action, adapter }) {
  return executePricePublication({ plan, action, adapter });
}

module.exports = {
  executePricePublication,
  executeSinglePriceUpdate,
  isEligibleSinglePriceUpdate,
  validateIdentity,
};
