const { loadClientScope } = require("../clientScope/clientScope");
const { moneyEquals, parseMoney } = require("../pricing/priceCalculator");
const { normalizeSku } = require("../tiendanube/sku");

const DOMAIN_ORDER = Object.freeze(["PRICE", "STATUS", "IMAGE", "CREATE"]);
const STOP_CONDITIONS = Object.freeze([
  "PRECONDITION_CHANGED",
  "PRICE_TARGET_DRIFT",
  "PRICE_APPROVED_SNAPSHOT_INCOMPLETE",
  "IMAGE_PRECONDITION_CHANGED",
  "IMAGE_SOURCE_DRIFT",
  "IMAGE_TARGET_STATE_DRIFT",
  "IMAGE_APPROVED_SNAPSHOT_INCOMPLETE",
  "WRITE_BUDGET_EXHAUSTED",
  "WRITE_OUTSIDE_ALLOWLIST",
  "WRITE_OUTSIDE_ENABLED_DOMAIN",
  "WRITE_FAILED",
  "WRITE_VERIFICATION_FAILED",
  "CHECKPOINT_INCONSISTENT",
  "RESUME_INCONSISTENT",
  "MUTABLE_DOMAIN_SET_MISMATCH",
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
      currentPrice: item.currentPrice ?? null,
      requestedPrice: item.requestedPrice ?? null,
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

function sortedDomainPairs(
  values = [],
  domain,
  approvedTargetPrice = null,
  context = {},
) {
  if (domain === "IMAGE") {
    return values
      .map((item) => {
        const match = (context.matches || []).find(
          (candidate) =>
            String(candidate.productId) === String(item.productId) &&
            String(candidate.variantId) === String(item.variantId),
        );
        const sku = item.sku ?? match?.sku ?? null;
        return {
          productId: item.productId ?? null,
          variantId: item.variantId ?? null,
          normalizedSku: normalizeSku(sku ?? context.normalizedSku),
          sku,
          approvedImageIds: [...(item.tiendanubeImageIds || [])]
            .map(String)
            .sort(),
          approvedImageCount: Number.isInteger(Number(item.tiendanubeImageCount))
            ? Number(item.tiendanubeImageCount)
            : null,
          approvedPrimaryImageId: item.imageId === null || item.imageId === undefined
            ? null
            : String(item.imageId),
          approvedCurrentHash:
            item.tiendanubeHash || item.comparison?.targetExactHash || null,
          approvedCurrentFingerprint:
            item.comparison?.targetPerceptualHash || null,
          approvedSourceUrl: context.sourceImageUrl || null,
          approvedSourceType: context.sourceImageType || null,
          approvedSourceHash:
            context.sourceHash || item.sourceHash || item.comparison?.sourceExactHash || null,
          approvedSourceFingerprint:
            item.comparison?.sourcePerceptualHash || null,
          approvedPerceptualDistance: Number.isFinite(Number(item.comparison?.distance))
            ? Number(item.comparison.distance)
            : null,
          approvedThreshold: Number.isFinite(Number(item.comparison?.threshold))
            ? Number(item.comparison.threshold)
            : null,
          approvedAction: item.action || null,
        };
      })
      .sort((a, b) =>
        `${a.productId}:${a.variantId}`.localeCompare(`${b.productId}:${b.variantId}`),
      );
  }
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
        approvedCurrentPrice: parseMoney(item.currentPrice),
        approvedTargetPrice: parseMoney(
          item.requestedPrice ?? item.calculatedPrice ?? approvedTargetPrice,
        ),
      };
    }
    return item;
  });
}

function buildPreconditionSnapshot(plan, domain) {
  const domainKey = domain.toLowerCase();
  const domainPlan = plan?.plans?.[domainKey] || null;
  const priceCalculation = plan?.plans?.price?.calculation || null;
  const supplierPrice = ["PRICE", "CREATE"].includes(domain)
    ? parseMoney(plan?.supplier?.supplierPrice)
    : null;
  const approvedTargetPrice = ["PRICE", "CREATE"].includes(domain)
    ? parseMoney(priceCalculation?.calculatedPrice)
    : null;
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
    supplierPrice,
    approvedTargetPrice,
    pricingResult: ["PRICE", "CREATE"].includes(domain)
      ? {
          supplierPrice: parseMoney(priceCalculation?.supplierPrice ?? supplierPrice),
          category: priceCalculation?.category ?? null,
          multiplier: priceCalculation?.multiplier ?? null,
          baseCalculatedPrice: parseMoney(priceCalculation?.baseCalculatedPrice),
          calculatedPrice: approvedTargetPrice,
        }
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
    publications: sortedDomainPairs(
      domainPlan?.publications,
      domain,
      approvedTargetPrice,
      {
        normalizedSku: plan?.normalizedSku || null,
        sourceImageUrl: plan?.plans?.image?.sourceImageUrl || null,
        sourceImageType: plan?.supplier?.imageSourceType || null,
        sourceHash: plan?.plans?.image?.sourceHash || null,
        matches: plan?.tiendanube?.matches || [],
      },
    ),
  };
}

function imageSnapshotIssues(snapshot, requirePublications = true) {
  const issues = [];
  if (snapshot?.domain !== "IMAGE") issues.push("domain");
  if (!snapshot?.normalizedSku) issues.push("normalizedSku");
  if (!snapshot?.classification) issues.push("classification");
  if (!snapshot?.supplierResolution) issues.push("supplierResolution");
  const publications = snapshot?.publications || [];
  if (requirePublications && publications.length === 0) issues.push("publications");

  for (const publication of publications) {
    if (publication.approvedAction !== "IMAGE_REPLACE") continue;
    const imageIds = publication.approvedImageIds;
    if (publication.productId === null || publication.productId === undefined) {
      issues.push("productId");
    }
    if (publication.variantId === null || publication.variantId === undefined) {
      issues.push("variantId");
    }
    if (publication.normalizedSku !== snapshot.normalizedSku) {
      issues.push("publicationNormalizedSku");
    }
    if (
      !Array.isArray(imageIds) ||
      imageIds.length === 0 ||
      new Set(imageIds.map(String)).size !== imageIds.length
    ) {
      issues.push("approvedImageIds");
    }
    if (
      !Number.isInteger(publication.approvedImageCount) ||
      publication.approvedImageCount <= 0 ||
      publication.approvedImageCount !== imageIds?.length
    ) {
      issues.push("approvedImageCount");
    }
    if (
      !publication.approvedPrimaryImageId ||
      !imageIds?.map(String).includes(String(publication.approvedPrimaryImageId))
    ) {
      issues.push("approvedPrimaryImageId");
    }
    for (const field of [
      "approvedCurrentHash",
      "approvedCurrentFingerprint",
      "approvedSourceUrl",
      "approvedSourceType",
      "approvedSourceHash",
      "approvedSourceFingerprint",
    ]) {
      if (typeof publication[field] !== "string" || publication[field].length === 0) {
        issues.push(field);
      }
    }
    if (!Number.isFinite(publication.approvedPerceptualDistance)) {
      issues.push("approvedPerceptualDistance");
    }
    if (!Number.isFinite(publication.approvedThreshold)) {
      issues.push("approvedThreshold");
    }
    if (
      Number.isFinite(publication.approvedPerceptualDistance) &&
      Number.isFinite(publication.approvedThreshold) &&
      publication.approvedPerceptualDistance <= publication.approvedThreshold
    ) {
      issues.push("approvedComparisonDoesNotRequireReplace");
    }
  }
  return [...new Set(issues)];
}

function assertImageApprovedSnapshotComplete(snapshot, options = {}) {
  const issues = imageSnapshotIssues(
    snapshot,
    options.requirePublications !== false,
  );
  if (issues.length > 0) {
    throw new MutableBatchPlanError(
      "IMAGE_APPROVED_SNAPSHOT_INCOMPLETE",
      "El plan IMAGE no conserva una precondicion aprobada completa.",
      { issues },
    );
  }
  return snapshot;
}

function assertPlanImageSnapshotsComplete(plan) {
  for (const item of plan?.items || []) {
    const imagePlan = item?.domains?.IMAGE;
    if (!imagePlan || imagePlan.expectedWrites <= 0) continue;
    try {
      assertImageApprovedSnapshotComplete(imagePlan.snapshot);
    } catch (error) {
      if (error.code === "IMAGE_APPROVED_SNAPSHOT_INCOMPLETE") {
        error.details = {
          ...(error.details || {}),
          normalizedSku: item.normalizedSku,
        };
      }
      throw error;
    }
  }
  return plan;
}

function imagePair(item) {
  return `${item.productId}:${item.variantId}`;
}

function sameValue(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function imageIsAlreadyCurrent(publication) {
  return (
    publication.approvedAction === "IMAGE_NO_CHANGE" &&
    (publication.approvedCurrentHash === publication.approvedSourceHash ||
      (Number.isFinite(publication.approvedPerceptualDistance) &&
        Number.isFinite(publication.approvedThreshold) &&
        publication.approvedPerceptualDistance <= publication.approvedThreshold))
  );
}

function assertImageSnapshotExecutable(expected, actual) {
  assertImageApprovedSnapshotComplete(expected);
  const identityFields = [
    "sourceSku",
    "normalizedSku",
    "matchedCode",
    "supplierResolution",
    "classification",
    "supplierCode",
    "matchCount",
    "productIds",
    "variantIds",
    "legacy",
    "matches",
    "domain",
  ];
  if (identityFields.some((field) => !sameValue(expected[field], actual?.[field]))) {
    throw new MutableBatchPlanError(
      "IMAGE_PRECONDITION_CHANGED",
      "La identidad IMAGE actual difiere del plan aprobado.",
    );
  }

  const expectedByPair = new Map(expected.publications.map((item) => [imagePair(item), item]));
  const actualByPair = new Map((actual.publications || []).map((item) => [imagePair(item), item]));
  if (
    expectedByPair.size !== expected.publications.length ||
    actualByPair.size !== actual.publications?.length ||
    actualByPair.size !== expectedByPair.size
  ) {
    throw new MutableBatchPlanError(
      "IMAGE_PRECONDITION_CHANGED",
      "La cantidad de publicaciones IMAGE difiere del plan aprobado.",
    );
  }

  const alreadyCurrentPairs = [];
  const writablePairs = [];
  for (const approved of expected.publications) {
    const pair = imagePair(approved);
    const current = actualByPair.get(pair);
    if (
      !current ||
      current.normalizedSku !== approved.normalizedSku ||
      normalizeSku(current.sku) !== normalizeSku(approved.sku)
    ) {
      throw new MutableBatchPlanError(
        "IMAGE_PRECONDITION_CHANGED",
        "Una publicacion IMAGE ya no coincide con el plan aprobado.",
        { pair },
      );
    }
    if (approved.approvedAction !== "IMAGE_REPLACE") continue;

    const sourceFields = [
      "approvedSourceUrl",
      "approvedSourceType",
      "approvedSourceHash",
    ];
    if (sourceFields.some((field) => current[field] !== approved[field])) {
      throw new MutableBatchPlanError(
        "IMAGE_SOURCE_DRIFT",
        "La imagen fuente actual difiere de la fuente aprobada.",
        { pair },
      );
    }
    if (
      current.approvedSourceFingerprint &&
      current.approvedSourceFingerprint !== approved.approvedSourceFingerprint
    ) {
      throw new MutableBatchPlanError(
        "IMAGE_SOURCE_DRIFT",
        "El fingerprint de la imagen fuente difiere del aprobado.",
        { pair },
      );
    }

    if (imageIsAlreadyCurrent(current)) {
      alreadyCurrentPairs.push(pair);
      continue;
    }
    if (current.approvedAction !== "IMAGE_REPLACE") {
      throw new MutableBatchPlanError(
        "IMAGE_PRECONDITION_CHANGED",
        "La accion IMAGE actual ya no justifica el reemplazo aprobado.",
        { pair, approvedAction: approved.approvedAction, actualAction: current.approvedAction },
      );
    }
    const targetFields = [
      "approvedImageIds",
      "approvedImageCount",
      "approvedPrimaryImageId",
      "approvedCurrentHash",
      "approvedCurrentFingerprint",
    ];
    if (targetFields.some((field) => !sameValue(current[field], approved[field]))) {
      throw new MutableBatchPlanError(
        "IMAGE_TARGET_STATE_DRIFT",
        "El estado de imagen Tiendanube difiere del aprobado.",
        { pair },
      );
    }
    if (
      current.approvedThreshold !== approved.approvedThreshold ||
      current.approvedPerceptualDistance !== approved.approvedPerceptualDistance
    ) {
      throw new MutableBatchPlanError(
        "IMAGE_PRECONDITION_CHANGED",
        "La comparacion perceptual IMAGE difiere de la aprobada.",
        { pair },
      );
    }
    writablePairs.push(pair);
  }
  return { alreadyCurrentPairs, writablePairs };
}

function priceSnapshotIssues(snapshot, requirePublications = true) {
  const issues = [];
  const supplierPrice = parseMoney(snapshot?.supplierPrice);
  const approvedTargetPrice = parseMoney(snapshot?.approvedTargetPrice);
  const pricingResult = snapshot?.pricingResult;
  if (snapshot?.domain !== "PRICE") issues.push("domain");
  if (!snapshot?.normalizedSku) issues.push("normalizedSku");
  if (!snapshot?.classification) issues.push("classification");
  if (!snapshot?.supplierResolution) issues.push("supplierResolution");
  if (supplierPrice === null || supplierPrice <= 0) issues.push("supplierPrice");
  if (
    approvedTargetPrice === null ||
    approvedTargetPrice <= 0 ||
    !Number.isInteger(approvedTargetPrice)
  ) {
    issues.push("approvedTargetPrice");
  }
  if (
    !pricingResult ||
    !moneyEquals(pricingResult.supplierPrice, supplierPrice) ||
    !moneyEquals(pricingResult.calculatedPrice, approvedTargetPrice) ||
    !Number.isFinite(Number(pricingResult.category)) ||
    !Number.isFinite(Number(pricingResult.multiplier)) ||
    Number(pricingResult.multiplier) <= 0 ||
    parseMoney(pricingResult.baseCalculatedPrice) === null
  ) {
    issues.push("pricingResult");
  }
  const publications = snapshot?.publications || [];
  if (requirePublications && publications.length === 0) issues.push("publications");
  for (const publication of publications) {
    if (publication.productId === null || publication.productId === undefined) {
      issues.push("productId");
    }
    if (publication.variantId === null || publication.variantId === undefined) {
      issues.push("variantId");
    }
    const current = parseMoney(publication.approvedCurrentPrice);
    const target = parseMoney(publication.approvedTargetPrice);
    if (current === null || current < 0) issues.push("approvedCurrentPrice");
    if (!moneyEquals(target, approvedTargetPrice)) issues.push("publicationTargetPrice");
  }
  return [...new Set(issues)];
}

function assertPriceApprovedSnapshotComplete(snapshot, options = {}) {
  const issues = priceSnapshotIssues(
    snapshot,
    options.requirePublications !== false,
  );
  if (issues.length > 0) {
    throw new MutableBatchPlanError(
      "PRICE_APPROVED_SNAPSHOT_INCOMPLETE",
      "El plan PRICE no conserva una precondicion aprobada completa.",
      { issues },
    );
  }
  return snapshot;
}

function assertPlanPriceSnapshotsComplete(plan) {
  for (const item of plan?.items || []) {
    const pricePlan = item?.domains?.PRICE;
    if (!pricePlan || pricePlan.expectedWrites <= 0) continue;
    try {
      assertPriceApprovedSnapshotComplete(pricePlan.snapshot);
    } catch (error) {
      if (error.code === "PRICE_APPROVED_SNAPSHOT_INCOMPLETE") {
        error.details = {
          ...(error.details || {}),
          normalizedSku: item.normalizedSku,
        };
      }
      throw error;
    }
  }
  return plan;
}

function assertPriceSnapshotExecutable(expected, actual) {
  assertPriceApprovedSnapshotComplete(expected);
  const actualIssues = priceSnapshotIssues(actual, true);
  if (actualIssues.length > 0) {
    throw new MutableBatchPlanError(
      "PRECONDITION_CHANGED",
      "El estado PRICE actual no contiene una precondicion comparable.",
      { issues: actualIssues },
    );
  }

  const identityFields = [
    "sourceSku",
    "normalizedSku",
    "matchedCode",
    "supplierResolution",
    "classification",
    "supplierCode",
    "matchCount",
    "productIds",
    "variantIds",
    "legacy",
    "matches",
    "domain",
  ];
  const identityChanged = identityFields.some(
    (field) => JSON.stringify(expected[field]) !== JSON.stringify(actual[field]),
  );
  if (identityChanged) {
    throw new MutableBatchPlanError(
      "PRECONDITION_CHANGED",
      "La identidad PRICE actual difiere del plan aprobado.",
    );
  }

  const targetChanged =
    !moneyEquals(expected.supplierPrice, actual.supplierPrice) ||
    !moneyEquals(expected.approvedTargetPrice, actual.approvedTargetPrice) ||
    JSON.stringify(expected.pricingResult) !== JSON.stringify(actual.pricingResult);
  if (targetChanged) {
    throw new MutableBatchPlanError(
      "PRICE_TARGET_DRIFT",
      "El precio proveedor o el calculo objetivo difiere del plan aprobado.",
      {
        approvedSupplierPrice: expected.supplierPrice,
        currentSupplierPrice: actual.supplierPrice,
        approvedTargetPrice: expected.approvedTargetPrice,
        currentTargetPrice: actual.approvedTargetPrice,
      },
    );
  }

  const actualByPair = new Map(
    actual.publications.map((item) => [
      `${item.productId}:${item.variantId}`,
      item,
    ]),
  );
  if (
    actualByPair.size !== actual.publications.length ||
    actual.publications.length !== expected.publications.length
  ) {
    throw new MutableBatchPlanError(
      "PRECONDITION_CHANGED",
      "La cantidad de publicaciones PRICE difiere del plan aprobado.",
    );
  }

  const alreadyCurrentPairs = [];
  const writablePairs = [];
  for (const approved of expected.publications) {
    const pair = `${approved.productId}:${approved.variantId}`;
    const current = actualByPair.get(pair);
    if (!current || current.sku !== approved.sku) {
      throw new MutableBatchPlanError(
        "PRECONDITION_CHANGED",
        "Una publicacion PRICE ya no coincide con el plan aprobado.",
        { pair },
      );
    }
    if (!moneyEquals(current.approvedTargetPrice, approved.approvedTargetPrice)) {
      throw new MutableBatchPlanError(
        "PRICE_TARGET_DRIFT",
        "El target PRICE de una publicacion difiere del plan aprobado.",
        { pair },
      );
    }
    if (moneyEquals(current.approvedCurrentPrice, approved.approvedTargetPrice)) {
      alreadyCurrentPairs.push(pair);
      continue;
    }
    if (moneyEquals(current.approvedCurrentPrice, approved.approvedCurrentPrice)) {
      writablePairs.push(pair);
      continue;
    }
    throw new MutableBatchPlanError(
      "PRECONDITION_CHANGED",
      "El precio actual no coincide con el precio aprobado ni con el objetivo.",
      {
        pair,
        approvedCurrentPrice: approved.approvedCurrentPrice,
        actualCurrentPrice: current.approvedCurrentPrice,
        approvedTargetPrice: approved.approvedTargetPrice,
      },
    );
  }

  return { alreadyCurrentPairs, writablePairs };
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
  const snapshot = buildPreconditionSnapshot(execution.originalPlan, domain);
  const approvedByPair = new Map(
    (snapshot.publications || []).map((item) => [
      `${item.productId}:${item.variantId}`,
      item,
    ]),
  );
  return {
    action: actions.length === 1
      ? actions[0].plannedAction
      : actions.map((action) => action.plannedAction).join("+") || "NOT_APPLICABLE",
    actions: actions.map((action) => {
      const approved = approvedByPair.get(
        `${action.productId ?? null}:${action.variantId ?? null}`,
      );
      return {
        productId: action.productId ?? null,
        variantId: action.variantId ?? null,
        plannedAction: action.plannedAction,
        simulationResult: action.simulationResult,
        expectedWrites: expectedWritesForAction(domain, action),
        ...(domain === "PRICE"
          ? {
              normalizedSku: snapshot.normalizedSku,
              classification: snapshot.classification,
              resolution: snapshot.supplierResolution,
              supplierPrice: snapshot.supplierPrice,
              pricingResult: snapshot.pricingResult,
              approvedCurrentPrice: approved?.approvedCurrentPrice ?? null,
              approvedTargetPrice: approved?.approvedTargetPrice ?? null,
            }
          : {}),
      };
    }),
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
    snapshot,
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
  if (expected?.domain === "PRICE" || actual?.domain === "PRICE") {
    return assertPriceSnapshotExecutable(expected, actual);
  }
  if (expected?.domain === "IMAGE" || actual?.domain === "IMAGE") {
    return assertImageSnapshotExecutable(expected, actual);
  }
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
  assertImageApprovedSnapshotComplete,
  assertImageSnapshotExecutable,
  assertPlanImageSnapshotsComplete,
  assertPlanPriceSnapshotsComplete,
  assertPriceApprovedSnapshotComplete,
  assertPriceSnapshotExecutable,
  assertSnapshotUnchanged,
  buildDomainPlan,
  buildPlanItem,
  buildPreconditionSnapshot,
  prepareAllowlist,
  selectedDomains,
};
