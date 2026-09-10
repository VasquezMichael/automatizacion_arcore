const { parseMoney } = require("../pricing/priceCalculator");
const { normalizeSku } = require("../tiendanube/sku");
const { executePricePublication } = require("./singlePriceExecution");

const AUTOMATIC_RESOLUTIONS = new Set(["EXACT", "SAFE_TRANSFORM"]);
const ALLOWED_PRICE_ACTIONS = new Set(["PRICE_NO_CHANGE", "PRICE_UPDATE"]);
const ALLOWED_SIMULATION_RESULTS = new Set([
  "SKIPPED_ALREADY_APPLIED",
  "WOULD_UPDATE",
]);

function pairKey(item) {
  return `${item?.productId}:${item?.variantId}`;
}

function issue(code, message, details) {
  return { code, message, ...(details ? { details } : {}) };
}

function hasExactPairs(expectedPairs, items) {
  const actualPairs = items.map(pairKey);
  return (
    actualPairs.length === expectedPairs.size &&
    new Set(actualPairs).size === actualPairs.length &&
    actualPairs.every((pair) => expectedPairs.has(pair))
  );
}

function validateLegacyPriceExecution(plan, revalidation, actions) {
  const issues = [];
  const legacy = plan?.tiendanube?.legacyGroup;
  const currentLegacy = revalidation?.legacyGroup;
  const expectedMatches = Number(legacy?.expectedMatches);
  const productIds = plan?.tiendanube?.productIds || [];
  const variantIds = plan?.tiendanube?.variantIds || [];
  const planMatches = plan?.tiendanube?.matches || [];
  const currentMatches = revalidation?.matches || [];
  const priceActions = actions.filter((action) => action.type === "PRICE");
  const currentPricePublications = revalidation?.plans?.price?.publications || [];
  const registeredPairs = new Set(
    productIds.map((productId, index) =>
      pairKey({ productId, variantId: variantIds[index] }),
    ),
  );
  const supplierPrice = parseMoney(plan?.supplier?.supplierPrice);
  const targetPrice = parseMoney(plan?.plans?.price?.calculation?.calculatedPrice);
  const currentTargetPrice = parseMoney(
    revalidation?.plans?.price?.calculation?.calculatedPrice,
  );

  if (plan?.classification !== "LEGACY_GROUP") {
    issues.push(
      issue(
        "LEGACY_CLASSIFICATION_REQUIRED",
        "La clasificacion ya no es LEGACY_GROUP.",
      ),
    );
  }
  if (!AUTOMATIC_RESOLUTIONS.has(plan?.supplierResolution?.type)) {
    issues.push(
      issue(
        "LEGACY_SUPPLIER_RESOLUTION_BLOCKED",
        "La resolucion Arcore no es automatizable.",
      ),
    );
  }
  if (legacy?.valid !== true || currentLegacy?.ok !== true || revalidation?.ok !== true) {
    issues.push(
      issue(
        "LEGACY_GROUP_INVALID",
        "El grupo legacy no supero todas las validaciones.",
      ),
    );
  }
  if (
    legacy?.normalizedSku !== plan?.normalizedSku ||
    currentLegacy?.normalizedSku !== plan?.normalizedSku
  ) {
    issues.push(
      issue(
        "LEGACY_GROUP_NORMALIZED_SKU_MISMATCH",
        "El registro legacy ya no corresponde al SKU esperado.",
      ),
    );
  }
  if (!Number.isInteger(expectedMatches) || expectedMatches <= 0) {
    issues.push(issue("LEGACY_EXPECTED_MATCHES_INVALID", "expectedMatches no es valido."));
  }

  const countChecks = {
    actualMatches: Number(legacy?.actualMatches),
    currentActualMatches: Number(currentLegacy?.actualMatches),
    currentExpectedMatches: Number(currentLegacy?.expectedMatches),
    matchCount: Number(plan?.tiendanube?.matchCount),
    planMatches: planMatches.length,
    productIds: productIds.length,
    registeredProductIds: Number(currentLegacy?.registeredProductIdsCount),
    registeredVariantIds: Number(currentLegacy?.registeredVariantIdsCount),
    revalidatedMatches: currentMatches.length,
    variantIds: variantIds.length,
    priceActions: priceActions.length,
    currentPricePublications: currentPricePublications.length,
  };
  if (Object.values(countChecks).some((count) => count !== expectedMatches)) {
    issues.push(
      issue(
        "LEGACY_GROUP_COUNT_MISMATCH",
        "Los conteos actuales no coinciden exactamente con expectedMatches.",
        { expectedMatches, ...countChecks },
      ),
    );
  }

  if (
    registeredPairs.size !== expectedMatches ||
    !hasExactPairs(registeredPairs, planMatches) ||
    !hasExactPairs(registeredPairs, currentMatches) ||
    !hasExactPairs(registeredPairs, priceActions) ||
    !hasExactPairs(registeredPairs, currentPricePublications)
  ) {
    issues.push(
      issue(
        "LEGACY_GROUP_PAIR_MISMATCH",
        "Los pares productId/variantId ya no coinciden con el grupo registrado.",
      ),
    );
  }

  const invalidSku = [...planMatches, ...currentMatches].find(
    (item) => normalizeSku(item.sku) !== plan?.normalizedSku,
  );
  if (invalidSku) {
    issues.push(
      issue(
        "LEGACY_GROUP_SKU_MISMATCH",
        "Un SKU actual no coincide con el SKU normalizado esperado.",
        { pair: pairKey(invalidSku) },
      ),
    );
  }

  const invalidAction = priceActions.find(
    (action) =>
      !ALLOWED_PRICE_ACTIONS.has(action.plannedAction) ||
      !ALLOWED_SIMULATION_RESULTS.has(action.simulationResult),
  );
  const invalidCurrentAction = currentPricePublications.find(
    (publication) => !ALLOWED_PRICE_ACTIONS.has(publication.action),
  );
  if (
    invalidAction ||
    invalidCurrentAction ||
    !ALLOWED_PRICE_ACTIONS.has(plan?.plans?.price?.action) ||
    !ALLOWED_PRICE_ACTIONS.has(revalidation?.plans?.price?.action)
  ) {
    issues.push(
      issue(
        "LEGACY_PRICE_ACTION_INVALID",
        "Todas las publicaciones deben seguir en PRICE_UPDATE o PRICE_NO_CHANGE.",
      ),
    );
  }

  if (supplierPrice === null || supplierPrice <= 0) {
    issues.push(
      issue(
        "INVALID_SUPPLIER_PRICE",
        "El precio proveedor debe ser valido y mayor que cero.",
      ),
    );
  }
  if (targetPrice === null || targetPrice <= 0 || !Number.isInteger(targetPrice)) {
    issues.push(
      issue(
        "INVALID_CALCULATED_PRICE",
        "El precio objetivo debe ser un entero valido y mayor que cero.",
      ),
    );
  }
  if (
    currentTargetPrice !== targetPrice ||
    priceActions.some(
      (action) => parseMoney(action.desiredState?.price) !== targetPrice,
    ) ||
    currentPricePublications.some(
      (publication) => parseMoney(publication.requestedPrice) !== targetPrice,
    )
  ) {
    issues.push(
      issue(
        "LEGACY_TARGET_PRICE_MISMATCH",
        "Las publicaciones no comparten el mismo precio objetivo.",
      ),
    );
  }

  return {
    ok: issues.length === 0,
    issues,
    expectedMatches,
    priceActions,
    targetPrice,
  };
}

function actionIntegrityFailed(action) {
  return (action.errors || []).some((error) => {
    if (
      ["PRICE_PREWRITE_IDENTITY_MISMATCH", "PRICE_PREWRITE_READ_FAILED"].includes(
        error.code,
      )
    ) {
      return true;
    }
    return (
      error.code === "PRICE_WRITE_VERIFICATION_FAILED" &&
      Boolean(error.details?.identity)
    );
  });
}

function blockRemainingAction(action, failedPair) {
  action.simulationResult = "BLOCKED";
  action.executionResult = "BLOCKED";
  action.errors = action.errors || [];
  action.errors.push(
    issue(
      "GROUP_INTEGRITY_FAILED",
      "No se ejecuta la publicacion porque fallo la integridad del grupo legacy.",
      { failedPair },
    ),
  );
}

async function executeLegacyPriceUpdates({ plan, actions, adapter }) {
  let failedPair = null;

  for (const action of actions) {
    if (failedPair) {
      blockRemainingAction(action, failedPair);
      continue;
    }

    await executePricePublication({ plan, action, adapter });
    if (actionIntegrityFailed(action)) {
      failedPair = pairKey(action);
    }
  }

  return {
    groupIntegrityFailed: Boolean(failedPair),
    issues: failedPair
      ? [
          issue(
            "GROUP_INTEGRITY_FAILED",
            "La identidad del grupo legacy no pudo mantenerse durante la ejecucion.",
            { failedPair },
          ),
        ]
      : [],
  };
}

module.exports = {
  actionIntegrityFailed,
  executeLegacyPriceUpdates,
  validateLegacyPriceExecution,
};
