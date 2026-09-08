function legacyPairKey(productId, variantId) {
  return `${productId}:${variantId}`;
}

function validateLegacyGroup({ group, legacy, currentSkuMatches }) {
  const issues = [];
  const expectedMatches = Number(group.expectedMatches) || 0;
  const productIds = Array.isArray(group.productIds) ? group.productIds : [];
  const variantIds = Array.isArray(group.variantIds) ? group.variantIds : [];
  const actualMatches = currentSkuMatches.matches.length;
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

  if (actualMatches !== expectedMatches) {
    issues.push({
      code: "LEGACY_ACTUAL_MATCHES_MISMATCH",
      expectedMatches,
      actualMatches,
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
    registeredProductIdsCount: productIds.length,
    registeredVariantIdsCount: variantIds.length,
    expectedMatches,
    actualMatches,
  };
}

module.exports = {
  validateLegacyGroup,
};
