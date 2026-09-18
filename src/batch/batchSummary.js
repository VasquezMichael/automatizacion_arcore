const CLASSIFICATION_KEYS = ["SINGLE", "LEGACY_GROUP", "CREATE_SINGLE", "MANUAL_REVIEW"];
const RESOLUTION_KEYS = ["EXACT", "SAFE_TRANSFORM", "NOT_FOUND", "AMBIGUOUS"];

function initializedCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function increment(counts, key) {
  const safeKey = key || "UNKNOWN";
  counts[safeKey] = (counts[safeKey] || 0) + 1;
}

function domainActions(plan) {
  if (!plan) return [];
  if (Array.isArray(plan.publications) && plan.publications.length > 0) {
    return plan.publications.map((publication) => publication.action).filter(Boolean);
  }
  return plan.action ? [plan.action] : [];
}

function countStatus(summary, item) {
  const actions = domainActions(item.plans?.status);
  if (actions.length === 0) {
    increment(summary.statusActions, item.status === "SUCCEEDED" ? "notApplicable" : "blocked");
    return;
  }
  for (const action of actions) {
    if (action === "PUBLISH") increment(summary.statusActions, "publish");
    else if (action === "UNPUBLISH") increment(summary.statusActions, "unpublish");
    else if (action === "STATUS_NO_CHANGE") increment(summary.statusActions, "noChange");
    else if (action === "STATUS_FOR_CREATION") increment(summary.statusActions, "notApplicable");
    else increment(summary.statusActions, "blocked");
  }
}

function countPrice(summary, item) {
  const actions = domainActions(item.plans?.price);
  if (actions.length === 0) {
    increment(summary.priceActions, item.status === "SUCCEEDED" ? "notApplicable" : "blocked");
    return;
  }
  for (const action of actions) {
    if (action === "PRICE_UPDATE") increment(summary.priceActions, "update");
    else if (action === "PRICE_NO_CHANGE") increment(summary.priceActions, "noChange");
    else if (action === "PRICE_FOR_CREATION") increment(summary.priceActions, "notApplicable");
    else increment(summary.priceActions, "blocked");
  }
}

function countImage(summary, item) {
  const actions = domainActions(item.plans?.image);
  if (actions.length === 0) {
    increment(summary.imageActions, item.status === "SUCCEEDED" ? "notApplicable" : "blocked");
    return;
  }
  for (const action of actions) {
    if (action === "IMAGE_REPLACE") increment(summary.imageActions, "replace");
    else if (action === "IMAGE_CREATE") increment(summary.imageActions, "create");
    else if (action === "IMAGE_NO_CHANGE") increment(summary.imageActions, "noChange");
    else if (action === "NO_SOURCE_IMAGE") increment(summary.imageActions, "noSourceImage");
    else if (action === "IMAGE_FOR_CREATION") increment(summary.imageActions, "notApplicable");
    else increment(summary.imageActions, "blocked");
  }
}

function countCreate(summary, item) {
  if (item.classification === "CREATE_SINGLE") {
    const result = item.plans?.create?.simulationResult || item.plans?.create?.executionResult;
    increment(summary.createActions, result === "BLOCKED" ? "blocked" : "createSingle");
  } else if (item.classification === "MANUAL_REVIEW") {
    increment(summary.createActions, "blocked");
  } else {
    increment(summary.createActions, "notApplicable");
  }
}

function reasonCodes(item) {
  const codes = new Set();
  for (const entry of [...(item.warnings || []), ...(item.errors || [])]) {
    if (entry?.code) codes.add(entry.code);
  }
  if (item.supplierResolution?.type === "NOT_FOUND") codes.add("NOT_FOUND");
  if (item.supplierResolution?.type === "AMBIGUOUS") codes.add("AMBIGUOUS");
  if (item.classification === "MANUAL_REVIEW") codes.add("MANUAL_REVIEW");
  if (codes.size === 0 && item.status === "BLOCKED") codes.add("BLOCKED");
  return [...codes].sort();
}

function actionTotal(counts) {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

function buildBatchSummary(input, items) {
  const summary = {
    inputCount: input.inputCount,
    uniqueSkuCount: input.uniqueSkuCount,
    duplicateInputCount: input.duplicateInputCount,
    processedCount: items.length,
    succeededCount: 0,
    failedCount: 0,
    blockedCount: 0,
    manualReviewCount: 0,
    warningCount: 0,
    errorCount: 0,
    warningCodes: {},
    errorCodes: {},
    classifications: initializedCounts(CLASSIFICATION_KEYS),
    supplierResolutions: initializedCounts(RESOLUTION_KEYS),
    statusActions: initializedCounts([
      "publish",
      "unpublish",
      "noChange",
      "blocked",
      "notApplicable",
    ]),
    priceActions: initializedCounts(["update", "noChange", "blocked", "notApplicable"]),
    imageActions: initializedCounts([
      "replace",
      "create",
      "noChange",
      "noSourceImage",
      "blocked",
      "notApplicable",
    ]),
    createActions: initializedCounts(["createSingle", "notApplicable", "blocked"]),
    manualReviewItems: [],
  };

  for (const item of items) {
    if (item.status === "FAILED") summary.failedCount += 1;
    else if (item.status === "BLOCKED") summary.blockedCount += 1;
    else summary.succeededCount += 1;

    increment(summary.classifications, item.classification);
    increment(summary.supplierResolutions, item.supplierResolution?.type);
    summary.warningCount += item.warnings?.length || 0;
    summary.errorCount += item.errors?.length || 0;
    for (const warning of item.warnings || []) increment(summary.warningCodes, warning.code);
    for (const error of item.errors || []) increment(summary.errorCodes, error.code);
    countStatus(summary, item);
    countPrice(summary, item);
    countImage(summary, item);
    countCreate(summary, item);

    if (item.requiresManualReview) {
      summary.manualReviewItems.push({
        sku: item.inputSku,
        normalizedSku: item.normalizedSku,
        reasonCodes: reasonCodes(item),
      });
    }
  }

  summary.manualReviewCount = summary.manualReviewItems.length;
  summary.statusActions.total = actionTotal(summary.statusActions);
  summary.priceActions.total = actionTotal(summary.priceActions);
  summary.imageActions.total = actionTotal(summary.imageActions);
  summary.createActions.total = actionTotal(summary.createActions);
  return summary;
}

module.exports = {
  buildBatchSummary,
  domainActions,
};
