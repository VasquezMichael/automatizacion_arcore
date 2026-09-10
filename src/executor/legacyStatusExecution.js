const { desiredPublishedForAvailability } = require("../sync/statusPlan");
const { normalizeSku } = require("../tiendanube/sku");
const { executeStatusPublication } = require("./singleStatusExecution");

const AUTOMATIC_RESOLUTIONS = new Set(["EXACT", "SAFE_TRANSFORM"]);
const STATUS_ACTIONS = new Set(["STATUS_NO_CHANGE", "PUBLISH", "UNPUBLISH"]);
const STATUS_RESULTS = new Set(["SKIPPED_ALREADY_APPLIED", "WOULD_UPDATE"]);

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

function validateLegacyStatusExecution(plan, revalidation, actions) {
  const issues = [];
  const legacy = plan?.tiendanube?.legacyGroup;
  const currentLegacy = revalidation?.legacyGroup;
  const productIds = plan?.tiendanube?.productIds || [];
  const variantIds = plan?.tiendanube?.variantIds || [];
  const statusPlan = plan?.plans?.status;
  const currentStatusPlan = revalidation?.plans?.status;
  const statusActions = (actions || []).filter((action) => action.type === "STATUS");
  const expectedMatches = Number(legacy?.expectedMatches || 0);
  const registeredPairs = expectedPairs(productIds, variantIds);
  const targetPublished = desiredPublishedForAvailability(
    plan?.supplier?.availability,
  );

  if (plan?.classification !== "LEGACY_GROUP") {
    issues.push(issue("LEGACY_STATUS_CLASSIFICATION_INVALID", "La clasificacion no es LEGACY_GROUP."));
  }
  if (!AUTOMATIC_RESOLUTIONS.has(plan?.supplierResolution?.type)) {
    issues.push(issue("LEGACY_STATUS_SUPPLIER_RESOLUTION_INVALID", "La resolucion Arcore no permite escritura automatica."));
  }
  if (legacy?.valid !== true || currentLegacy?.ok !== true) {
    issues.push(issue("LEGACY_GROUP_INVALID", "El registro legacy no supero la validacion historica actual."));
  }
  if (revalidation?.ok !== true || revalidation?.status !== "PASSED") {
    issues.push(issue("LEGACY_STATUS_REVALIDATION_FAILED", "La revalidacion previa no finalizo en PASSED."));
  }
  if (
    !plan?.normalizedSku ||
    legacy?.normalizedSku !== plan.normalizedSku ||
    currentLegacy?.normalizedSku !== plan.normalizedSku
  ) {
    issues.push(issue("LEGACY_STATUS_NORMALIZED_SKU_MISMATCH", "El SKU normalizado no coincide con el registro legacy."));
  }
  if (!Number.isInteger(expectedMatches) || expectedMatches <= 0) {
    issues.push(issue("LEGACY_STATUS_EXPECTED_MATCHES_INVALID", "expectedMatches no es un entero positivo."));
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
    statusPublications: (statusPlan?.publications || []).length,
    currentStatusPublications: (currentStatusPlan?.publications || []).length,
    statusActions: statusActions.length,
  };
  for (const [name, count] of Object.entries(countChecks)) {
    if (count !== expectedMatches) {
      issues.push(issue("LEGACY_STATUS_COUNT_MISMATCH", `${name} no coincide con expectedMatches.`, {
        name,
        expectedMatches,
        actual: count,
      }));
    }
  }

  const pairCollections = [
    ["plan.matches", plan?.tiendanube?.matches || []],
    ["revalidation.matches", revalidation?.matches || []],
    ["status.publications", statusPlan?.publications || []],
    ["currentStatus.publications", currentStatusPlan?.publications || []],
    ["status.actions", statusActions],
  ];
  for (const [name, collection] of pairCollections) {
    if (!samePairs(collection, registeredPairs)) {
      issues.push(issue("LEGACY_STATUS_PAIR_MISMATCH", `${name} no contiene exactamente los pares registrados.`, { name }));
    }
  }

  for (const match of [
    ...(plan?.tiendanube?.matches || []),
    ...(revalidation?.matches || []),
  ]) {
    if (normalizeSku(match?.sku) !== plan?.normalizedSku) {
      issues.push(issue("LEGACY_STATUS_PUBLICATION_SKU_MISMATCH", "Una publicacion contiene un SKU normalizado distinto.", {
        productId: match?.productId,
        variantId: match?.variantId,
      }));
    }
  }

  if (typeof targetPublished !== "boolean") {
    issues.push(issue("LEGACY_STATUS_AVAILABILITY_UNKNOWN", "La disponibilidad no permite calcular un published objetivo."));
  }
  if (
    typeof targetPublished === "boolean" &&
    (statusPlan?.desiredPublished !== targetPublished ||
      currentStatusPlan?.desiredPublished !== targetPublished ||
      !STATUS_ACTIONS.has(statusPlan?.action) ||
      !STATUS_ACTIONS.has(currentStatusPlan?.action))
  ) {
    issues.push(issue("LEGACY_STATUS_TARGET_MISMATCH", "El published objetivo no coincide entre plan y revalidacion."));
  }

  for (const action of statusActions) {
    if (
      !STATUS_ACTIONS.has(action.plannedAction) ||
      !STATUS_RESULTS.has(action.simulationResult) ||
      action?.desiredState?.published !== targetPublished
    ) {
      issues.push(issue("LEGACY_STATUS_ACTION_INVALID", "Una accion STATUS no es ejecutable para el grupo legacy.", {
        productId: action.productId,
        variantId: action.variantId,
        plannedAction: action.plannedAction,
        simulationResult: action.simulationResult,
      }));
    }
  }

  for (const publication of currentStatusPlan?.publications || []) {
    if (
      !STATUS_ACTIONS.has(publication.action) ||
      publication.desiredPublished !== targetPublished
    ) {
      issues.push(issue("LEGACY_STATUS_CURRENT_ACTION_INVALID", "Una publicacion revalidada no conserva una accion STATUS permitida.", {
        productId: publication.productId,
        variantId: publication.variantId,
        action: publication.action,
      }));
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    expectedMatches,
    statusActions,
    targetPublished,
  };
}

function statusActionIntegrityFailed(action) {
  return (action?.errors || []).some(
    (error) =>
      error.code === "STATUS_PREWRITE_READ_FAILED" ||
      error.code === "STATUS_PREWRITE_IDENTITY_MISMATCH" ||
      (error.code === "STATUS_WRITE_VERIFICATION_FAILED" && error.details?.identity),
  );
}

function blockRemaining(actions, startIndex, sourceAction) {
  const issueDetails = issue(
    "GROUP_INTEGRITY_FAILED",
    "La ejecucion STATUS del grupo se detuvo por una inconsistencia critica de identidad.",
    {
      sourceProductId: sourceAction.productId,
      sourceVariantId: sourceAction.variantId,
    },
  );
  for (const action of actions.slice(startIndex)) {
    action.simulationResult = "BLOCKED";
    action.executionResult = "BLOCKED";
    action.errors = action.errors || [];
    action.errors.push(issueDetails);
  }
  return issueDetails;
}

async function executeLegacyStatusUpdates({ plan, actions, adapter }) {
  const issues = [];
  let groupIntegrityFailed = false;

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    await executeStatusPublication({ plan, action, adapter });
    if (statusActionIntegrityFailed(action)) {
      groupIntegrityFailed = true;
      issues.push(blockRemaining(actions, index + 1, action));
      break;
    }
  }

  return { issues, groupIntegrityFailed };
}

module.exports = {
  executeLegacyStatusUpdates,
  statusActionIntegrityFailed,
  validateLegacyStatusExecution,
};
