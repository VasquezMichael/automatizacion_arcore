const { buildImagePlan } = require("../sync/imagePlan");
const { buildPricePlan } = require("../sync/pricePlan");
const { buildStatusPlan } = require("../sync/statusPlan");
const { getLegacySkuGroup } = require("../tiendanube/legacySkuGroups");
const { validateLegacyGroup } = require("../tiendanube/legacyGroupValidation");
const {
  findSkuMatches,
  getLegacyGroupMatches,
} = require("../tiendanube/products");
const { createTiendanubeReadOnlyClient } = require("../tiendanube/readOnlyClient");
const { normalizeSku } = require("../tiendanube/sku");
const { validateExecutionPlan } = require("./executionGuards");

function pairKey(match) {
  return `${match.productId}:${match.variantId}`;
}

function safeMatch(match) {
  return {
    productId: match.productId,
    variantId: match.variantId,
    sku: match.sku,
    normalizedSku: normalizeSku(match.sku),
    name: match.name,
    published: match.published,
    price: match.price,
    promotionalPrice: match.promotionalPrice,
    visibility: match.visibility,
  };
}

function revalidationIssue(code, message, details) {
  return { code, message, ...(details ? { details } : {}) };
}

async function buildCurrentPlans(plan, matches, client, dependencies) {
  const statusBuilder = dependencies.buildStatusPlan || buildStatusPlan;
  const priceBuilder = dependencies.buildPricePlan || buildPricePlan;
  const imageBuilder = dependencies.buildImagePlan || buildImagePlan;

  return {
    status: statusBuilder({
      classification: plan.classification,
      matches,
      availability: plan.supplier.availability,
    }),
    price: priceBuilder({
      classification: plan.classification,
      matches,
      supplierPrice: plan.supplier.supplierPrice,
    }),
    image: await imageBuilder({
      classification: plan.classification,
      matches,
      sourceImageUrl: plan.supplier.imageUrl,
      client,
    }),
  };
}

function validateRevalidatedPlans(plan, plans) {
  return validateExecutionPlan({
    ...plan,
    plans,
    errors: [
      ...(plans.price?.errors || []),
      ...(plans.image?.errors || []),
    ],
  });
}

async function revalidateSingle(plan, client, dependencies) {
  const lookup = await (dependencies.findSkuMatches || findSkuMatches)(
    plan.normalizedSku,
    client,
  );
  const matches = lookup.matches || [];
  const issues = [];

  if (matches.length !== 1) {
    issues.push(
      revalidationIssue(
        "SINGLE_MATCH_COUNT_CHANGED",
        `SINGLE esperaba 1 coincidencia y ahora encontro ${matches.length}.`,
      ),
    );
  }

  const expected = plan.tiendanube?.matches?.[0];
  const current = matches[0];
  if (matches.length === 1 && expected && pairKey(current) !== pairKey(expected)) {
    issues.push(
      revalidationIssue("SINGLE_IDENTITY_CHANGED", "Cambio productId/variantId del SINGLE.", {
        expected: pairKey(expected),
        actual: pairKey(current),
      }),
    );
  }
  if (current && normalizeSku(current.sku) !== plan.normalizedSku) {
    issues.push(
      revalidationIssue("SINGLE_SKU_CHANGED", "El SKU actual ya no coincide normalizado."),
    );
  }

  if (issues.length > 0) return { ok: false, issues, matches };
  const plans = await buildCurrentPlans(plan, matches, client, dependencies);
  const planValidation = validateRevalidatedPlans(plan, plans);
  if (!planValidation.ok) issues.push(...planValidation.issues);
  return {
    ok: issues.length === 0,
    issues,
    matches,
    plans,
    domainBlocks: planValidation.domainBlocks,
  };
}

async function revalidateLegacyGroup(plan, client, dependencies) {
  const group = (dependencies.getLegacySkuGroup || getLegacySkuGroup)(plan.normalizedSku);
  if (!group) {
    return {
      ok: false,
      issues: [
        revalidationIssue(
          "LEGACY_GROUP_NOT_REGISTERED",
          "El SKU dejo de estar registrado como LEGACY_GROUP.",
        ),
      ],
      matches: [],
    };
  }

  const [legacy, currentSkuMatches] = await Promise.all([
    (dependencies.getLegacyGroupMatches || getLegacyGroupMatches)(group, client),
    (dependencies.findSkuMatches || findSkuMatches)(plan.normalizedSku, client),
  ]);
  const validation = (dependencies.validateLegacyGroup || validateLegacyGroup)({
    group,
    legacy,
    currentSkuMatches,
  });
  const issues = [...validation.issues];
  const plannedExpectedMatches = Number(plan.tiendanube?.legacyGroup?.expectedMatches);
  if (plannedExpectedMatches !== Number(group.expectedMatches)) {
    issues.push(
      revalidationIssue(
        "LEGACY_EXPECTATION_CHANGED",
        "expectedMatches cambio desde la planificacion.",
        {
          planned: plannedExpectedMatches,
          current: Number(group.expectedMatches),
        },
      ),
    );
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      matches: currentSkuMatches.matches || [],
      legacyGroup: { ...validation, normalizedSku: group.normalizedSku },
    };
  }

  const matches = legacy.matches || [];
  const plans = await buildCurrentPlans(plan, matches, client, dependencies);
  const planValidation = validateRevalidatedPlans(plan, plans);
  if (!planValidation.ok) issues.push(...planValidation.issues);
  return {
    ok: issues.length === 0,
    issues,
    matches,
    plans,
    domainBlocks: planValidation.domainBlocks,
    legacyGroup: { ...validation, normalizedSku: group.normalizedSku },
  };
}

async function revalidateCreation(plan, client, dependencies) {
  const lookup = await (dependencies.findSkuMatches || findSkuMatches)(
    plan.normalizedSku,
    client,
  );
  const matches = lookup.matches || [];
  if (matches.length === 0) {
    return {
      ok: true,
      status: "STILL_ABSENT",
      issues: [],
      matches: [],
      plans: plan.plans,
    };
  }

  const ambiguous = matches.length > 1;
  return {
    ok: false,
    status: ambiguous ? "MANUAL_REVIEW" : "ALREADY_EXISTS",
    issues: [
      revalidationIssue(
        ambiguous ? "CREATE_SKU_NOW_AMBIGUOUS" : "CREATE_SKU_NOW_EXISTS",
        ambiguous
          ? `CREATE_SINGLE encontro ${matches.length} coincidencias actuales.`
          : "CREATE_SINGLE encontro una coincidencia durante la revalidacion.",
        matches.map(safeMatch),
      ),
    ],
    matches,
  };
}

async function revalidateSyncPlan(plan, dependencies = {}) {
  const client = dependencies.client || createTiendanubeReadOnlyClient();
  const checkedAt = new Date().toISOString();

  try {
    let result;
    if (plan.classification === "SINGLE") {
      result = await revalidateSingle(plan, client, dependencies);
    } else if (plan.classification === "LEGACY_GROUP") {
      result = await revalidateLegacyGroup(plan, client, dependencies);
    } else if (plan.classification === "CREATE_SINGLE") {
      result = await revalidateCreation(plan, client, dependencies);
    } else {
      result = {
        ok: false,
        issues: [
          revalidationIssue(
            "REVALIDATION_NOT_ALLOWED",
            `No se revalida la clasificacion ${plan.classification || "VACIA"}.`,
          ),
        ],
        matches: [],
      };
    }

    return {
      checkedAt,
      status: result.ok ? result.status || "PASSED" : result.status || "FAILED",
      ...result,
      matches: (result.matches || []).map(safeMatch),
    };
  } catch (error) {
    return {
      checkedAt,
      ok: false,
      status: "FAILED",
      matches: [],
      issues: [
        revalidationIssue(
          "REVALIDATION_REQUEST_FAILED",
          error.message,
          { status: error.response?.status || error.status || null },
        ),
      ],
    };
  }
}

module.exports = {
  buildCurrentPlans,
  revalidateSyncPlan,
};
