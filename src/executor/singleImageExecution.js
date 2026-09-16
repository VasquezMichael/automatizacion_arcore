const {
  calculateExactImageHash,
  compareImageBuffers,
  downloadImageBuffer,
} = require("../tiendanube/imageFingerprint");
const { normalizeSku } = require("../tiendanube/sku");

const AUTOMATIC_RESOLUTIONS = new Set(["EXACT", "SAFE_TRANSFORM"]);

function safeError(error, fallbackCode) {
  return {
    code: error.code || fallbackCode,
    message: error.message,
    status: error.response?.status || error.status || null,
    contentType: error.contentType || null,
    url: error.url || null,
    hostname: error.hostname || null,
  };
}

function operationError(error, code) {
  const serialized = safeError(error, code);
  return {
    ...serialized,
    code,
    ...(serialized.code !== code ? { causeCode: serialized.code } : {}),
  };
}

function initializeTrace(action) {
  action.oldImageId = action.currentState?.imageId ?? null;
  action.newImageId = null;
  action.uploadAttempted = false;
  action.uploadSucceeded = false;
  action.uploadVerified = false;
  action.deleteAttempted = false;
  action.deleteSucceeded = false;
  action.finalVerified = false;
  action.partial = false;
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

function findVariant(product, variantId) {
  return (product?.variants || []).find(
    (variant) => String(variant.id) === String(variantId),
  );
}

function validateProductIdentity(product, action, normalizedSku) {
  const variant = findVariant(product, action.variantId);
  if (
    String(product?.id || "") === String(action.productId) &&
    variant &&
    normalizeSku(variant.sku) === normalizedSku
  ) {
    return null;
  }

  return {
    expectedProductId: action.productId,
    actualProductId: product?.id ?? null,
    expectedVariantId: action.variantId,
    actualVariantId: variant?.id ?? null,
    expectedNormalizedSku: normalizedSku,
    actualNormalizedSku: normalizeSku(variant?.sku),
  };
}

function resolvePrimaryImage(images) {
  if (!Array.isArray(images) || images.length === 0) {
    const error = new Error("No existe una imagen primaria identificable.");
    error.code = "IMAGE_PRIMARY_NOT_FOUND";
    throw error;
  }

  const ids = images.map((image) => String(image?.id || ""));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    const error = new Error("El conjunto de imagenes contiene IDs invalidos o duplicados.");
    error.code = "IMAGE_SET_AMBIGUOUS";
    throw error;
  }

  if (images.length === 1) return images[0];

  const positioned = images.map((image) => ({
    image,
    hasPosition:
      image.position !== null &&
      image.position !== undefined &&
      String(image.position).trim() !== "",
    position: Number(image.position),
  }));
  if (positioned.some((item) => !item.hasPosition || !Number.isFinite(item.position))) {
    const error = new Error("No se puede identificar la imagen primaria por posicion.");
    error.code = "IMAGE_PRIMARY_AMBIGUOUS";
    throw error;
  }

  const minimum = Math.min(...positioned.map((item) => item.position));
  const primaryCandidates = positioned.filter((item) => item.position === minimum);
  if (primaryCandidates.length !== 1) {
    const error = new Error("Varias imagenes comparten la posicion primaria.");
    error.code = "IMAGE_PRIMARY_AMBIGUOUS";
    throw error;
  }
  return primaryCandidates[0].image;
}

function containsImage(images, imageId) {
  return (images || []).some((image) => String(image.id) === String(imageId));
}

function secondaryImageIds(images, primaryImageId) {
  return images
    .filter((image) => String(image.id) !== String(primaryImageId))
    .map((image) => String(image.id));
}

function sameImageIds(images, expectedIds) {
  if (!Array.isArray(expectedIds)) return false;
  const actual = images.map((image) => String(image.id)).sort();
  const expected = expectedIds.map(String).sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function readProductImageState(adapter, action) {
  const product = await adapter.getProduct(action.productId);
  const images = await adapter.listProductImages(action.productId);
  return { product, images, primaryImage: resolvePrimaryImage(images) };
}

function isEligibleSingleImageReplace(plan, revalidation, action) {
  const currentMatches = revalidation?.matches || [];
  const currentMatch = currentMatches[0];
  const currentImagePlan = revalidation?.plans?.image;
  const currentPublication = (currentImagePlan?.publications || []).find(
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
    plan?.plans?.image?.action === "IMAGE_REPLACE" &&
    currentImagePlan?.action === "IMAGE_REPLACE" &&
    action?.type === "IMAGE" &&
    action?.plannedAction === "IMAGE_REPLACE" &&
    action?.simulationResult === "WOULD_REPLACE" &&
    currentPublication?.action === "IMAGE_REPLACE" &&
    String(currentPublication?.imageId || "") ===
      String(action?.currentState?.imageId || "") &&
    typeof plan?.plans?.image?.sourceImageUrl === "string" &&
    plan.plans.image.sourceImageUrl.trim() !== "" &&
    typeof plan?.plans?.image?.sourceHash === "string" &&
    plan.plans.image.sourceHash.length > 0 &&
    currentImagePlan.sourceHash === plan.plans.image.sourceHash
  );
}

async function executeSingleImageReplace({
  plan,
  action,
  adapter,
  imageTools = {},
}) {
  initializeTrace(action);
  const tools = {
    calculateExactImageHash,
    compareImageBuffers,
    downloadImageBuffer,
    ...imageTools,
  };
  const sourceImageUrl = plan.plans.image.sourceImageUrl;
  let preWrite;

  try {
    preWrite = await readProductImageState(adapter, action);
  } catch (error) {
    return blockAction(
      action,
      error.code || "IMAGE_PREWRITE_READ_FAILED",
      "No se pudo obtener un estado de imagen inequivoco antes del upload.",
      safeError(error, "IMAGE_PREWRITE_READ_FAILED"),
    );
  }

  const identityIssue = validateProductIdentity(
    preWrite.product,
    action,
    plan.normalizedSku,
  );
  if (identityIssue) {
    return blockAction(
      action,
      "IMAGE_PREWRITE_IDENTITY_MISMATCH",
      "La identidad productId/variantId/SKU cambio antes del upload.",
      identityIssue,
    );
  }

  if (
    String(preWrite.primaryImage.id) !== String(action.oldImageId) ||
    preWrite.images.length !== Number(action.currentState.imageCount) ||
    !sameImageIds(preWrite.images, action.currentState.imageIds)
  ) {
    return blockAction(
      action,
      "IMAGE_PREWRITE_PRIMARY_CHANGED",
      "La imagen primaria o la cantidad de imagenes cambio antes del upload.",
      {
        expectedImageId: action.oldImageId,
        actualImageId: preWrite.primaryImage.id,
        expectedImageCount: action.currentState.imageCount,
        actualImageCount: preWrite.images.length,
        expectedImageIds: action.currentState.imageIds,
        actualImageIds: preWrite.images.map((image) => image.id),
      },
    );
  }

  const preservedSecondaryIds = secondaryImageIds(
    preWrite.images,
    preWrite.primaryImage.id,
  );
  let sourceBuffer;
  let primaryBuffer;
  let preWriteComparison;

  try {
    [sourceBuffer, primaryBuffer] = await Promise.all([
      tools.downloadImageBuffer(sourceImageUrl, { withArcoreAuth: true }),
      tools.downloadImageBuffer(preWrite.primaryImage.src),
    ]);
    preWriteComparison = await tools.compareImageBuffers(
      sourceBuffer,
      primaryBuffer,
    );
  } catch (error) {
    return blockAction(
      action,
      error.code || "IMAGE_DOWNLOAD_FAILED",
      "No se pudieron descargar y validar las imagenes antes del upload.",
      safeError(error, "IMAGE_DOWNLOAD_FAILED"),
    );
  }

  action.preWriteComparison = preWriteComparison;
  if (preWriteComparison.exactMatch || preWriteComparison.perceptualMatch) {
    action.simulationResult = "SKIPPED_ALREADY_APPLIED";
    action.executionResult = "SKIPPED_ALREADY_APPLIED";
    action.verified = true;
    action.finalVerified = true;
    action.verifiedState = { imageId: preWrite.primaryImage.id };
    return action;
  }

  const currentSourceHash = tools.calculateExactImageHash(sourceBuffer);
  if (currentSourceHash !== action.desiredState.exactHash) {
    return blockAction(
      action,
      "IMAGE_SUPPLIER_DRIFT",
      "La imagen proveedor cambio desde la revalidacion.",
      {
        expectedSourceHash: action.desiredState.exactHash,
        actualSourceHash: currentSourceHash,
      },
    );
  }
  if (preWriteComparison.targetExactHash !== action.currentState.exactHash) {
    return blockAction(
      action,
      "IMAGE_TARGET_DRIFT",
      "El contenido de la imagen primaria cambio desde la revalidacion.",
      {
        expectedTargetHash: action.currentState.exactHash,
        actualTargetHash: preWriteComparison.targetExactHash,
      },
    );
  }

  let uploaded;
  action.uploadAttempted = true;
  action.writeAttempted = true;
  try {
    uploaded = await adapter.uploadProductImage(action.productId, {
      src: sourceImageUrl,
      position: 1,
    });
    action.uploadSucceeded = true;
    action.writeSucceeded = true;
    action.newImageId = uploaded?.id ?? null;
  } catch (error) {
    action.writeSucceeded = false;
    return failAction(
      action,
      "WRITE_FAILED",
      operationError(error, "IMAGE_WRITE_FAILED"),
    );
  }

  if (!action.newImageId || String(action.newImageId) === String(action.oldImageId)) {
    return failAction(action, "WRITE_VERIFICATION_FAILED", {
      code: "IMAGE_WRITE_VERIFICATION_FAILED",
      message: "El upload no devolvio un newImageId valido y diferente.",
    });
  }

  let uploadedState;
  try {
    uploadedState = await readProductImageState(adapter, action);
    const uploadedIdentityIssue = validateProductIdentity(
      uploadedState.product,
      action,
      plan.normalizedSku,
    );
    const uploadedImage = uploadedState.images.find(
      (image) => String(image.id) === String(action.newImageId),
    );
    const secondaryImagesPreserved = preservedSecondaryIds.every((imageId) =>
      containsImage(uploadedState.images, imageId),
    );
    if (
      uploadedIdentityIssue ||
      !uploadedImage?.src ||
      !containsImage(uploadedState.images, action.oldImageId) ||
      !secondaryImagesPreserved ||
      String(uploadedState.primaryImage.id) !== String(action.newImageId)
    ) {
      const error = new Error("El GET posterior no confirmo la nueva imagen esperada.");
      error.code = "IMAGE_WRITE_VERIFICATION_FAILED";
      error.details = {
        identity: uploadedIdentityIssue,
        newImagePresent: Boolean(uploadedImage),
        oldImagePresent: containsImage(uploadedState.images, action.oldImageId),
        secondaryImagesPreserved,
        primaryImageId: uploadedState.primaryImage?.id ?? null,
      };
      throw error;
    }
    const uploadedBuffer = await tools.downloadImageBuffer(uploadedImage.src);
    const uploadedComparison = await tools.compareImageBuffers(
      sourceBuffer,
      uploadedBuffer,
    );
    action.uploadComparison = uploadedComparison;
    if (!uploadedComparison.exactMatch && !uploadedComparison.perceptualMatch) {
      const error = new Error("La imagen subida no es equivalente a la fuente.");
      error.code = "IMAGE_WRITE_VERIFICATION_FAILED";
      throw error;
    }
    action.uploadVerified = true;
  } catch (error) {
    return failAction(
      action,
      "WRITE_VERIFICATION_FAILED",
      {
        ...operationError(error, "IMAGE_WRITE_VERIFICATION_FAILED"),
        ...(error.details ? { details: error.details } : {}),
      },
    );
  }

  action.deleteAttempted = true;
  try {
    await adapter.deleteProductImage(action.productId, action.oldImageId);
    action.deleteSucceeded = true;
  } catch (error) {
    action.writeSucceeded = false;
    action.updated = true;
    action.partial = true;
    return failAction(
      action,
      "PARTIAL_FAILURE",
      operationError(error, "IMAGE_OLD_DELETE_FAILED"),
    );
  }

  try {
    const finalState = await readProductImageState(adapter, action);
    const finalIdentityIssue = validateProductIdentity(
      finalState.product,
      action,
      plan.normalizedSku,
    );
    const secondaryImagesPreserved = preservedSecondaryIds.every((imageId) =>
      containsImage(finalState.images, imageId),
    );
    const validFinalState =
      !finalIdentityIssue &&
      containsImage(finalState.images, action.newImageId) &&
      !containsImage(finalState.images, action.oldImageId) &&
      secondaryImagesPreserved &&
      String(finalState.primaryImage.id) === String(action.newImageId) &&
      finalState.images.length === preWrite.images.length;

    action.verifiedState = {
      primaryImageId: finalState.primaryImage?.id ?? null,
      imageCount: finalState.images.length,
      oldImagePresent: containsImage(finalState.images, action.oldImageId),
      secondaryImagesPreserved,
    };
    if (!validFinalState) {
      return failAction(action, "WRITE_VERIFICATION_FAILED", {
        code: "IMAGE_WRITE_VERIFICATION_FAILED",
        message: "El GET final no confirmo el reemplazo seguro de la imagen.",
        details: { identity: finalIdentityIssue, ...action.verifiedState },
      });
    }
  } catch (error) {
    if (action.executionResult === "WRITE_VERIFICATION_FAILED") return action;
    return failAction(
      action,
      "WRITE_VERIFICATION_FAILED",
      operationError(error, "IMAGE_WRITE_VERIFICATION_FAILED"),
    );
  }

  action.finalVerified = true;
  action.verified = true;
  action.updated = true;
  action.executionResult = "WRITE_SUCCEEDED";
  return action;
}

module.exports = {
  executeSingleImageReplace,
  isEligibleSingleImageReplace,
  resolvePrimaryImage,
  validateProductIdentity,
};
