const { desiredPublishedForAvailability } = require("../sync/statusPlan");
const { normalizeSku } = require("../tiendanube/sku");

const AUTOMATIC_RESOLUTIONS = new Set(["EXACT", "SAFE_TRANSFORM"]);
const STATUS_UPDATE_ACTIONS = new Set(["PUBLISH", "UNPUBLISH"]);

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

function validateStatusIdentity({ product, action, normalizedSku }) {
  const productVariant = findProductVariant(product, action.variantId);
  const valid =
    String(product?.id || "") === String(action.productId) &&
    productVariant &&
    String(productVariant.id) === String(action.variantId) &&
    normalizeSku(productVariant.sku) === normalizedSku;

  if (valid) return null;

  return {
    expectedProductId: action.productId,
    actualProductId: product?.id ?? null,
    expectedVariantId: action.variantId,
    actualVariantId: productVariant?.id ?? null,
    expectedNormalizedSku: normalizedSku,
    actualNormalizedSku: normalizeSku(productVariant?.sku),
  };
}

function isEligibleSingleStatusUpdate(plan, revalidation, action) {
  const desiredPublished = desiredPublishedForAvailability(
    plan?.supplier?.availability,
  );
  const currentMatches = revalidation?.matches || [];
  const currentMatch = currentMatches[0];
  const currentStatusPlan = revalidation?.plans?.status;
  const currentPublication = (currentStatusPlan?.publications || []).find(
    (publication) =>
      String(publication.productId) === String(action?.productId) &&
      String(publication.variantId) === String(action?.variantId),
  );

  return (
    plan?.classification === "SINGLE" &&
    AUTOMATIC_RESOLUTIONS.has(plan?.supplierResolution?.type) &&
    revalidation?.ok === true &&
    revalidation?.status === "PASSED" &&
    currentMatches.length === 1 &&
    String(currentMatch?.productId) === String(action?.productId) &&
    String(currentMatch?.variantId) === String(action?.variantId) &&
    normalizeSku(currentMatch?.sku) === plan?.normalizedSku &&
    action?.type === "STATUS" &&
    STATUS_UPDATE_ACTIONS.has(action?.plannedAction) &&
    action?.simulationResult === "WOULD_UPDATE" &&
    STATUS_UPDATE_ACTIONS.has(currentStatusPlan?.action) &&
    STATUS_UPDATE_ACTIONS.has(currentPublication?.action) &&
    typeof desiredPublished === "boolean" &&
    action?.desiredState?.published === desiredPublished &&
    currentPublication?.desiredPublished === desiredPublished
  );
}

async function executeStatusPublication({ plan, action, adapter }) {
  const targetPublished = action.desiredState.published;
  let product;

  try {
    product = await adapter.getProduct(action.productId);
  } catch (error) {
    return blockAction(
      action,
      "STATUS_PREWRITE_READ_FAILED",
      "No se pudo revalidar el producto inmediatamente antes del PUT.",
      safeError(error, "STATUS_PREWRITE_READ_FAILED"),
    );
  }

  const identityIssue = validateStatusIdentity({
    product,
    action,
    normalizedSku: plan.normalizedSku,
  });
  if (identityIssue) {
    return blockAction(
      action,
      "STATUS_PREWRITE_IDENTITY_MISMATCH",
      "La identidad productId/variantId/SKU cambio antes del PUT.",
      identityIssue,
    );
  }

  const currentPublished = product.published;
  action.preWriteState = { published: currentPublished };
  if (currentPublished === targetPublished) {
    action.simulationResult = "SKIPPED_ALREADY_APPLIED";
    action.executionResult = "SKIPPED_ALREADY_APPLIED";
    action.verifiedState = { published: currentPublished };
    action.verified = true;
    return action;
  }
  if (
    typeof currentPublished !== "boolean" ||
    currentPublished !== action.currentState.published
  ) {
    return blockAction(
      action,
      "STATUS_PREWRITE_STATE_CHANGED",
      "El estado published cambio antes del PUT y no coincide con el valor planificado ni con el objetivo.",
      {
        plannedCurrentPublished: action.currentState.published,
        actualCurrentPublished: currentPublished,
        targetPublished,
      },
    );
  }

  action.writeAttempted = true;
  try {
    await adapter.updateProductPublished(action.productId, targetPublished);
    action.writeSucceeded = true;
  } catch (error) {
    return failAction(
      action,
      "WRITE_FAILED",
      safeError(error, "STATUS_WRITE_FAILED"),
    );
  }

  let verifiedProduct;
  try {
    verifiedProduct = await adapter.getProduct(action.productId);
  } catch (error) {
    return failAction(
      action,
      "WRITE_VERIFICATION_FAILED",
      safeError(error, "STATUS_WRITE_VERIFICATION_FAILED"),
    );
  }

  const verifiedIdentityIssue = validateStatusIdentity({
    product: verifiedProduct,
    action,
    normalizedSku: plan.normalizedSku,
  });
  const verifiedPublished = verifiedProduct.published;
  action.verifiedState = { published: verifiedPublished };

  if (!verifiedIdentityIssue && verifiedPublished === targetPublished) {
    action.executionResult = "WRITE_SUCCEEDED";
    action.verified = true;
    action.updated = true;
    return action;
  }

  return failAction(action, "WRITE_VERIFICATION_FAILED", {
    code: "STATUS_WRITE_VERIFICATION_FAILED",
    message: "El PUT respondio exitosamente, pero el GET posterior no confirmo published.",
    details: {
      targetPublished,
      verifiedPublished,
      identity: verifiedIdentityIssue,
    },
  });
}

async function executeSingleStatusUpdate(options) {
  return executeStatusPublication(options);
}

module.exports = {
  executeStatusPublication,
  executeSingleStatusUpdate,
  isEligibleSingleStatusUpdate,
  validateStatusIdentity,
};
