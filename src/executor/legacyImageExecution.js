const { normalizeSku } = require("../tiendanube/sku");
const { executeSingleImageReplace } = require("./singleImageExecution");

const AUTOMATIC_RESOLUTIONS = new Set(["EXACT", "SAFE_TRANSFORM"]);
const IMAGE_ACTIONS = new Set(["IMAGE_NO_CHANGE", "IMAGE_REPLACE"]);
const IMAGE_RESULTS = new Set(["SKIPPED_ALREADY_APPLIED", "WOULD_REPLACE"]);
const IMAGE_SOURCE_TYPES = new Set([
  "COVER_FULL",
  "COVER_THUMBNAIL_FALLBACK",
]);
const CRITICAL_IMAGE_CODES = new Set([
  "IMAGE_PREWRITE_READ_FAILED",
  "IMAGE_PREWRITE_IDENTITY_MISMATCH",
  "IMAGE_PREWRITE_PRIMARY_CHANGED",
  "IMAGE_PRIMARY_AMBIGUOUS",
  "IMAGE_PRIMARY_NOT_FOUND",
  "IMAGE_SET_AMBIGUOUS",
  "IMAGE_SUPPLIER_DRIFT",
]);

function pairKey(item) {
  return `${item?.productId}:${item?.variantId}`;
}

function issue(code, message, details) {
  return { code, message, ...(details ? { details } : {}) };
}

function samePairs(actual, expected) {
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set(expected.map(pairKey));
  const actualPairs = actual.map(pairKey);
  return (
    expectedSet.size === expected.length &&
    new Set(actualPairs).size === actualPairs.length &&
    actualPairs.every((pair) => expectedSet.has(pair))
  );
}

function expectedPairs(productIds, variantIds) {
  return (productIds || []).map((productId, index) => ({
    productId,
    variantId: variantIds?.[index],
  }));
}

function sameImageIds(first, second) {
  const normalize = (items) =>
    (Array.isArray(items) ? items : []).map(String).sort();
  return JSON.stringify(normalize(first)) === JSON.stringify(normalize(second));
}

function publicationMap(group) {
  return new Map(
    (group?.publications || []).map((publication) => [
      pairKey(publication),
      publication,
    ]),
  );
}

function validateLegacyImageExecution(plan, revalidation, actions) {
  const issues = [];
  const legacy = plan?.tiendanube?.legacyGroup;
  const currentLegacy = revalidation?.legacyGroup;
  const productIds = plan?.tiendanube?.productIds || [];
  const variantIds = plan?.tiendanube?.variantIds || [];
  const registeredPairs = expectedPairs(productIds, variantIds);
  const expectedMatches = Number(legacy?.expectedMatches || 0);
  const imagePlan = plan?.plans?.image;
  const currentImagePlan = revalidation?.plans?.image;
  const imageActions = (actions || []).filter((action) => action.type === "IMAGE");

  if (plan?.classification !== "LEGACY_GROUP") {
    issues.push(
      issue(
        "LEGACY_IMAGE_CLASSIFICATION_INVALID",
        "La clasificacion no es LEGACY_GROUP.",
      ),
    );
  }
  if (!AUTOMATIC_RESOLUTIONS.has(plan?.supplierResolution?.type)) {
    issues.push(
      issue(
        "LEGACY_IMAGE_SUPPLIER_RESOLUTION_INVALID",
        "La resolucion Arcore no permite escritura automatica de imagen.",
      ),
    );
  }
  if (legacy?.valid !== true || currentLegacy?.ok !== true) {
    issues.push(
      issue(
        "LEGACY_IMAGE_GROUP_INVALID",
        "El registro legacy no supero la validacion historica actual.",
      ),
    );
  }
  if (revalidation?.ok !== true || revalidation?.status !== "PASSED") {
    issues.push(
      issue(
        "LEGACY_IMAGE_REVALIDATION_FAILED",
        "La revalidacion previa no finalizo en PASSED.",
      ),
    );
  }
  if (
    !plan?.normalizedSku ||
    legacy?.normalizedSku !== plan.normalizedSku ||
    currentLegacy?.normalizedSku !== plan.normalizedSku
  ) {
    issues.push(
      issue(
        "LEGACY_IMAGE_NORMALIZED_SKU_MISMATCH",
        "El SKU normalizado no coincide con el registro legacy.",
      ),
    );
  }
  if (!Number.isInteger(expectedMatches) || expectedMatches <= 0) {
    issues.push(
      issue(
        "LEGACY_IMAGE_EXPECTED_MATCHES_INVALID",
        "expectedMatches no es un entero positivo.",
      ),
    );
  }

  const countChecks = {
    actualMatches: Number(legacy?.actualMatches),
    currentActualMatches: Number(currentLegacy?.actualMatches),
    currentExpectedMatches: Number(currentLegacy?.expectedMatches),
    matchCount: Number(plan?.tiendanube?.matchCount),
    planMatches: (plan?.tiendanube?.matches || []).length,
    productIds: productIds.length,
    variantIds: variantIds.length,
    registeredProductIds: Number(currentLegacy?.registeredProductIdsCount),
    registeredVariantIds: Number(currentLegacy?.registeredVariantIdsCount),
    revalidatedMatches: (revalidation?.matches || []).length,
    imagePublications: (imagePlan?.publications || []).length,
    currentImagePublications: (currentImagePlan?.publications || []).length,
    imageActions: imageActions.length,
  };
  for (const [name, count] of Object.entries(countChecks)) {
    if (count !== expectedMatches) {
      issues.push(
        issue(
          "LEGACY_IMAGE_COUNT_MISMATCH",
          `${name} no coincide con expectedMatches.`,
          { name, expectedMatches, actual: count },
        ),
      );
    }
  }

  for (const [name, collection] of [
    ["plan.matches", plan?.tiendanube?.matches || []],
    ["revalidation.matches", revalidation?.matches || []],
    ["image.publications", imagePlan?.publications || []],
    ["currentImage.publications", currentImagePlan?.publications || []],
    ["image.actions", imageActions],
  ]) {
    if (!samePairs(collection, registeredPairs)) {
      issues.push(
        issue(
          "LEGACY_IMAGE_PAIR_MISMATCH",
          `${name} no contiene exactamente los pares registrados.`,
          { name },
        ),
      );
    }
  }

  for (const match of [
    ...(plan?.tiendanube?.matches || []),
    ...(revalidation?.matches || []),
  ]) {
    if (normalizeSku(match?.sku) !== plan?.normalizedSku) {
      issues.push(
        issue(
          "LEGACY_IMAGE_PUBLICATION_SKU_MISMATCH",
          "Una publicacion contiene un SKU normalizado distinto.",
          { productId: match?.productId, variantId: match?.variantId },
        ),
      );
    }
  }

  if (!IMAGE_SOURCE_TYPES.has(plan?.supplier?.imageSourceType)) {
    issues.push(
      issue(
        "LEGACY_IMAGE_SOURCE_TYPE_INVALID",
        "La fuente debe provenir de cover.foto o del fallback cover.thumbnail.",
      ),
    );
  }
  if (
    typeof imagePlan?.sourceImageUrl !== "string" ||
    imagePlan.sourceImageUrl.trim() === "" ||
    imagePlan.sourceImageUrl !== plan?.supplier?.imageUrl ||
    currentImagePlan?.sourceImageUrl !== imagePlan.sourceImageUrl ||
    typeof imagePlan?.sourceHash !== "string" ||
    imagePlan.sourceHash.length === 0 ||
    currentImagePlan?.sourceHash !== imagePlan.sourceHash
  ) {
    issues.push(
      issue(
        "LEGACY_IMAGE_SOURCE_MISMATCH",
        "La URL o el hash fuente no coincide entre plan y revalidacion.",
      ),
    );
  }

  if (
    !IMAGE_ACTIONS.has(imagePlan?.action) ||
    !IMAGE_ACTIONS.has(currentImagePlan?.action)
  ) {
    issues.push(
      issue(
        "LEGACY_IMAGE_ACTION_INVALID",
        "El grupo solo permite IMAGE_REPLACE o IMAGE_NO_CHANGE.",
      ),
    );
  }

  const plannedPublications = publicationMap(imagePlan);
  const currentPublications = publicationMap(currentImagePlan);
  for (const action of imageActions) {
    const planned = plannedPublications.get(pairKey(action));
    const current = currentPublications.get(pairKey(action));
    if (
      !planned ||
      !current ||
      !IMAGE_ACTIONS.has(action.plannedAction) ||
      !IMAGE_ACTIONS.has(planned.action) ||
      !IMAGE_ACTIONS.has(current.action) ||
      !IMAGE_RESULTS.has(action.simulationResult) ||
      action.plannedAction !== planned.action ||
      planned.sourceHash !== imagePlan?.sourceHash ||
      current.sourceHash !== imagePlan?.sourceHash ||
      action.desiredState?.exactHash !== imagePlan?.sourceHash ||
      String(action.currentState?.imageId || "") !==
        String(current.imageId || "") ||
      Number(action.currentState?.imageCount) !==
        Number(current.tiendanubeImageCount) ||
      !sameImageIds(
        action.currentState?.imageIds,
        current.tiendanubeImageIds,
      )
    ) {
      issues.push(
        issue(
          "LEGACY_IMAGE_PUBLICATION_PLAN_MISMATCH",
          "Una publicacion IMAGE no coincide con el plan revalidado.",
          {
            productId: action.productId,
            variantId: action.variantId,
          },
        ),
      );
    }
  }

  const order = new Map(
    registeredPairs.map((pair, index) => [pairKey(pair), index]),
  );
  imageActions.sort(
    (first, second) => order.get(pairKey(first)) - order.get(pairKey(second)),
  );

  if (issues.length > 0) {
    issues.unshift(
      issue(
        "GROUP_INTEGRITY_FAILED",
        "IMAGE no puede ejecutarse porque el grupo legacy no coincide con el plan validado.",
        { domain: "IMAGE" },
      ),
    );
  }

  return {
    ok: issues.length === 0,
    issues,
    expectedMatches,
    actualMatches: (revalidation?.matches || []).length,
    imageActions,
  };
}

function actionHasIdentityDetails(action) {
  return (action?.errors || []).some(
    (error) =>
      error.code === "IMAGE_WRITE_VERIFICATION_FAILED" &&
      Boolean(error.details?.identity),
  );
}

function imageActionIntegrityFailed(action) {
  return (
    (action?.errors || []).some((error) =>
      CRITICAL_IMAGE_CODES.has(error.code),
    ) || actionHasIdentityDetails(action)
  );
}

function prepareTrace(action, plan) {
  action.imageCount = Number(action.currentState?.imageCount) || 0;
  action.secondaryImageIds = (action.currentState?.imageIds || [])
    .filter((imageId) => String(imageId) !== String(action.currentState?.imageId))
    .map(String);
  const publication = (plan?.plans?.image?.publications || []).find(
    (item) => pairKey(item) === pairKey(action),
  );
  action.warnings = [...(publication?.warnings || [])];
}

function blockRemaining(actions, startIndex, sourceAction, plan) {
  const groupIssue = issue(
    "GROUP_INTEGRITY_FAILED",
    "La ejecucion IMAGE del grupo se detuvo por una inconsistencia critica.",
    {
      sourceProductId: sourceAction.productId,
      sourceVariantId: sourceAction.variantId,
    },
  );
  for (const action of actions.slice(startIndex)) {
    prepareTrace(action, plan);
    action.simulationResult = "BLOCKED";
    action.executionResult = "BLOCKED";
    action.errors = action.errors || [];
    action.warnings = action.warnings || [];
    action.errors.push(groupIssue);
  }
  return groupIssue;
}

async function executeLegacyImageUpdates({
  plan,
  actions,
  adapter,
  imageTools,
  stopOnAnyFailure = false,
}) {
  const issues = [];
  let groupIntegrityFailed = false;

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    prepareTrace(action, plan);
    await executeSingleImageReplace({
      plan,
      action,
      adapter,
      imageTools,
    });
    if (
      imageActionIntegrityFailed(action) ||
      (stopOnAnyFailure &&
        ["BLOCKED", "WRITE_FAILED", "WRITE_VERIFICATION_FAILED"].includes(
          action.executionResult,
        ))
    ) {
      groupIntegrityFailed = true;
      issues.push(blockRemaining(actions, index + 1, action, plan));
      break;
    }
  }

  return { issues, groupIntegrityFailed };
}

module.exports = {
  executeLegacyImageUpdates,
  imageActionIntegrityFailed,
  validateLegacyImageExecution,
};
