const { loadClientScope } = require("../clientScope/clientScope");
const { normalizeSku } = require("../tiendanube/sku");

const DOMAIN_ORDER = Object.freeze(["PRICE", "STATUS", "IMAGE", "CREATE"]);
const STOP_CONDITIONS = Object.freeze([
  "PRECONDITION_CHANGED",
  "WRITE_BUDGET_EXHAUSTED",
  "WRITE_OUTSIDE_ALLOWLIST",
  "WRITE_OUTSIDE_ENABLED_DOMAIN",
  "WRITE_FAILED",
  "WRITE_VERIFICATION_FAILED",
  "CHECKPOINT_INCONSISTENT",
  "RESUME_INCONSISTENT",
]);

class MutableBatchPlanError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "MutableBatchPlanError";
    this.code = code;
    if (details) this.details = details;
  }
}

function selectedDomains(options = {}) {
  return DOMAIN_ORDER.filter((domain) => options[`enable${domain}`] === true);
}

function prepareAllowlist(skus, scopeFile) {
  if (!Array.isArray(skus) || skus.length === 0) {
    throw new MutableBatchPlanError(
      "MUTABLE_ALLOWLIST_REQUIRED",
      "La ejecucion requiere al menos un --sku o --sku-file explicito.",
    );
  }
  const loaded = loadClientScope(scopeFile);
  const scopeByNormalized = new Map(
    loaded.scope.items.map((item) => [item.normalizedSku, item]),
  );
  const seen = new Set();
  const items = skus.map((inputSku, index) => {
    const normalizedSku = normalizeSku(inputSku);
    if (!normalizedSku) {
      throw new MutableBatchPlanError(
        "MUTABLE_ALLOWLIST_INVALID_SKU",
        `SKU invalido en posicion ${index}.`,
      );
    }
    if (seen.has(normalizedSku)) {
      throw new MutableBatchPlanError(
        "MUTABLE_ALLOWLIST_DUPLICATE",
        `El SKU ${normalizedSku} esta duplicado en la allowlist.`,
      );
    }
    const scopeItem = scopeByNormalized.get(normalizedSku);
    if (!scopeItem) {
      throw new MutableBatchPlanError(
        "SKU_OUTSIDE_CLIENT_SCOPE",
        `El SKU ${inputSku} no pertenece a config/client-scope-skus.json.`,
      );
    }
    seen.add(normalizedSku);
    return {
      inputSku: scopeItem.sourceSku,
      requestedSku: String(inputSku),
      normalizedSku,
      scopeItem,
    };
  });
  return { items, loaded };
}

function sortedPairs(values = []) {
  return values
    .map((item) => ({
      productId: item.productId ?? null,
      variantId: item.variantId ?? null,
      sku: item.sku ?? null,
      published: item.published ?? null,
      price: item.price ?? null,
      imageId: item.imageId ?? null,
      imageCount: item.imageCount ?? null,
      imageIds: [...(item.imageIds || [])].map(String).sort(),
      action: item.action ?? null,
      desiredPublished: item.desiredPublished ?? null,
      calculatedPrice: item.calculatedPrice ?? null,
    }))
    .sort((a, b) => `${a.productId}:${a.variantId}`.localeCompare(`${b.productId}:${b.variantId}`));
}

function sortedIdentityPairs(values = []) {
  return values
    .map((item) => ({
      productId: item.productId ?? null,
      variantId: item.variantId ?? null,
      sku: item.sku ?? null,
    }))
    .sort((a, b) => `${a.productId}:${a.variantId}`.localeCompare(`${b.productId}:${b.variantId}`));
}

function sortedDomainPairs(values = [], domain) {
  return sortedPairs(values).map((item) => {
    const identity = {
      productId: item.productId,
      variantId: item.variantId,
      sku: item.sku,
      action: item.action,
    };
    if (domain === "STATUS") {
      return {
        ...identity,
        published: item.published,
        desiredPublished: item.desiredPublished,
      };
    }
    if (domain === "PRICE") {
      return {
        ...identity,
        price: item.price,
        calculatedPrice: item.calculatedPrice,
      };
    }
    if (domain === "IMAGE") {
      return {
        ...identity,
        imageId: item.imageId,
        imageCount: item.imageCount,
        imageIds: item.imageIds,
      };
    }
    return item;
  });
}

function buildPreconditionSnapshot(plan, domain) {
  const domainKey = domain.toLowerCase();
  const domainPlan = plan?.plans?.[domainKey] || null;
  return {
    sourceSku: plan?.sourceSku || null,
    normalizedSku: plan?.normalizedSku || null,
    matchedCode: plan?.matchedCode || null,
    supplierResolution: plan?.supplierResolution?.type || null,
    classification: plan?.classification || null,
    supplierCode: plan?.supplier?.codigo || null,
    availability: ["STATUS", "CREATE"].includes(domain)
      ? plan?.supplier?.availability || null
      : null,
    supplierPrice: ["PRICE", "CREATE"].includes(domain)
      ? plan?.supplier?.supplierPrice ?? null
      : null,
    calculatedPrice: ["PRICE", "CREATE"].includes(domain)
      ? plan?.plans?.price?.calculation?.calculatedPrice ?? null
      : null,
    sourceImageUrl: ["IMAGE", "CREATE"].includes(domain)
      ? plan?.plans?.image?.sourceImageUrl || null
      : null,
    sourceHash: ["IMAGE", "CREATE"].includes(domain)
      ? plan?.plans?.image?.sourceHash || null
      : null,
    matchCount: plan?.tiendanube?.matchCount ?? null,
    productIds: [...(plan?.tiendanube?.productIds || [])].map(String).sort(),
    variantIds: [...(plan?.tiendanube?.variantIds || [])].map(String).sort(),
    legacy: plan?.tiendanube?.legacyGroup
      ? {
          valid: plan.tiendanube.legacyGroup.valid,
          expectedMatches: plan.tiendanube.legacyGroup.expectedMatches,
          actualMatches: plan.tiendanube.legacyGroup.actualMatches,
        }
      : null,
    matches: sortedIdentityPairs(plan?.tiendanube?.matches),
    domain,
    domainAction: domainPlan?.action || null,
    desiredPublished: domainPlan?.desiredPublished ?? null,
    publications: sortedDomainPairs(domainPlan?.publications, domain),
  };
}

function domainActions(execution, domain) {
  const type = domain === "CREATE" ? "CREATE_PRODUCT" : domain;
  return (execution?.executionPlan?.actions || []).filter((action) => action.type === type);
}

function actionNeedsWrite(domain, action) {
  if (domain === "PRICE") return action.plannedAction === "PRICE_UPDATE";
  if (domain === "STATUS") return ["PUBLISH", "UNPUBLISH"].includes(action.plannedAction);
  if (domain === "IMAGE") return action.plannedAction === "IMAGE_REPLACE";
  if (domain === "CREATE") return action.plannedAction === "CREATE_SINGLE";
  return false;
}

function expectedWritesForAction(domain, action) {
  if (!actionNeedsWrite(domain, action)) return 0;
  return domain === "IMAGE" ? 2 : 1;
}

function buildDomainPlan(execution, domain) {
  const actions = domainActions(execution, domain);
  const blockedActions = actions.filter((action) =>
    ["BLOCKED", "NOT_EXECUTABLE", "REVALIDATION_FAILED"].includes(
      action.executionResult || action.simulationResult,
    ),
  );
  return {
    action: actions.length === 1
      ? actions[0].plannedAction
      : actions.map((action) => action.plannedAction).join("+") || "NOT_APPLICABLE",
    actions: actions.map((action) => ({
      productId: action.productId ?? null,
      variantId: action.variantId ?? null,
      plannedAction: action.plannedAction,
      simulationResult: action.simulationResult,
      expectedWrites: expectedWritesForAction(domain, action),
    })),
    expectedWrites: actions.reduce(
      (total, action) => total + expectedWritesForAction(domain, action),
      0,
    ),
    blocked: blockedActions.length > 0,
    blockedReasons: blockedActions.flatMap((action) =>
      (action.errors || []).length > 0
        ? action.errors
        : [{
            code: action.plannedAction || "DOMAIN_ACTION_BLOCKED",
            message: `La accion ${action.plannedAction || domain} no es ejecutable.`,
          }],
    ),
    snapshot: buildPreconditionSnapshot(execution.originalPlan, domain),
  };
}

function buildPlanItem(allowItem, execution, domains) {
  if (execution.normalizedSku !== allowItem.normalizedSku) {
    throw new MutableBatchPlanError(
      "MUTABLE_PLAN_NORMALIZATION_MISMATCH",
      `El executor devolvio un normalizedSku distinto para ${allowItem.inputSku}.`,
      { expected: allowItem.normalizedSku, actual: execution.normalizedSku },
    );
  }
  return {
    inputSku: allowItem.inputSku,
    requestedSku: allowItem.requestedSku,
    normalizedSku: allowItem.normalizedSku,
    matchedCode: execution.matchedCode,
    supplierResolution: execution.supplierResolution?.type || null,
    classification: execution.classification,
    revalidation: execution.revalidation?.status || "NOT_RUN",
    domains: Object.fromEntries(
      domains.map((domain) => [domain, buildDomainPlan(execution, domain)]),
    ),
    warnings: execution.warnings || [],
    errors: execution.errors || [],
  };
}

function assertSnapshotUnchanged(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new MutableBatchPlanError(
      "PRECONDITION_CHANGED",
      "El estado actual difiere del plan inicial para el dominio habilitado.",
      { expected, actual },
    );
  }
}

module.exports = {
  DOMAIN_ORDER,
  MutableBatchPlanError,
  STOP_CONDITIONS,
  assertSnapshotUnchanged,
  buildDomainPlan,
  buildPlanItem,
  buildPreconditionSnapshot,
  prepareAllowlist,
  selectedDomains,
};
