const { runBatchSync } = require("../batch/batchSync");
const { ArcoreCatalogSource } = require("../catalog/arcoreCatalogSource");
const { syncProduct } = require("../sync/syncProduct");
const { createTiendanubeReadOnlyClient } = require("../tiendanube/readOnlyClient");
const { loadClientScope } = require("./clientScope");
const {
  createClientScopeIdentity,
  persistClientScopeReport,
} = require("./clientScopeOutput");

class ClientScopeRunError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ClientScopeRunError";
    this.code = code;
    if (details) this.details = details;
  }
}

function compareClientOccurrences(scopeItem, batchItem) {
  const legacy = batchItem.tiendanube?.legacyGroup;
  const matchCount = batchItem.tiendanube?.matchCount;
  let status;

  if (batchItem.classification === "LEGACY_GROUP" && legacy?.valid === true) {
    status =
      matchCount === scopeItem.occurrenceCount
        ? "CLIENT_AND_LEGACY_COUNTS_MATCH"
        : "CLIENT_AND_LEGACY_COUNTS_DIFFER";
  } else if (batchItem.classification === "MANUAL_REVIEW" && matchCount > 1) {
    status = "TIENDANUBE_MULTIPLE_NOT_VALID_LEGACY";
  } else if (batchItem.classification === "SINGLE") {
    status = "CLIENT_MULTIPLE_TIENDANUBE_SINGLE";
  } else if (batchItem.classification === "CREATE_SINGLE") {
    status = "CLIENT_MULTIPLE_TIENDANUBE_NO_MATCH";
  } else {
    status = "NOT_COMPARABLE";
  }

  return {
    clientOccurrenceCount: scopeItem.occurrenceCount,
    tiendanubeMatchCount: matchCount,
    legacyExpectedMatches: legacy?.expectedMatches ?? null,
    legacyValid: legacy?.valid ?? null,
    status,
  };
}

function assertReportReadOnly(batch) {
  const attempted = batch.items.filter((item) => item.result?.writeAttempted === true);
  if (batch.metadata?.writesAllowed !== false || attempted.length > 0) {
    throw new ClientScopeRunError(
      "CLIENT_SCOPE_READ_ONLY_INVARIANT_VIOLATION",
      "El batch del scope intento habilitar una escritura.",
      { attemptedSkus: attempted.map((item) => item.normalizedSku) },
    );
  }
}

function assertBatchMatchesScope(batch, scopeItems) {
  const expected = scopeItems.map((item) => item.normalizedSku);
  const actual = batch.items.map((item) => item.normalizedSku);
  if (
    batch.summary?.processedCount !== scopeItems.length ||
    actual.length !== expected.length ||
    new Set(actual).size !== expected.length ||
    actual.some((normalizedSku, index) => normalizedSku !== expected[index])
  ) {
    throw new ClientScopeRunError(
      "CLIENT_SCOPE_BATCH_MISMATCH",
      "El batch no devolvio exactamente los 85 SKU del scope en orden estable.",
      { expectedCount: expected.length, actualCount: actual.length },
    );
  }
}

function itemCodes(item) {
  return new Set(
    [...(item.warnings || []), ...(item.errors || [])]
      .map((entry) => entry?.code)
      .filter(Boolean),
  );
}

function functionalProblemCodes(item) {
  const codes = itemCodes(item);
  const problems = [];
  if (codes.has("ZERO_SUPPLIER_PRICE")) problems.push("ZERO_SUPPLIER_PRICE");
  else if (codes.has("INVALID_SUPPLIER_PRICE")) problems.push("SUPPLIER_PRICE_UNAVAILABLE");
  if (item.supplierResolution?.type === "AMBIGUOUS") problems.push("AMBIGUOUS");
  if (item.supplierResolution?.type === "NOT_FOUND") problems.push("NOT_FOUND");
  if (codes.has("ARCORE_DOM_CARD_UNAVAILABLE")) problems.push("ARCORE_DOM_CARD_UNAVAILABLE");
  if (codes.has("NO_SOURCE_IMAGE")) problems.push("NO_SOURCE_IMAGE");
  if (item.tiendanube?.legacyGroup?.valid === false) problems.push("LEGACY_MISMATCH");
  if (
    item.classification === "MANUAL_REVIEW" &&
    item.tiendanube?.matchCount > 1 &&
    !item.tiendanube?.legacyGroup
  ) {
    problems.push("TIENDANUBE_DUPLICATE");
  }
  if (item.availability === "UNKNOWN") problems.push("AVAILABILITY_UNKNOWN");
  if (item.requiresManualReview && problems.length === 0) problems.push("OTHER");
  return [...new Set(problems)];
}

function groupFunctionalProblems(items) {
  const groups = {};
  for (const item of items) {
    for (const code of functionalProblemCodes(item)) {
      const group = groups[code] || { count: 0, examples: [] };
      group.count += 1;
      if (group.examples.length < 10) group.examples.push(item.inputSku);
      groups[code] = group;
    }
  }
  return groups;
}

function summarizeClientComparisons(items) {
  const summary = {};
  for (const item of items) {
    const status = item.clientVsTiendanube.status;
    summary[status] = (summary[status] || 0) + 1;
  }
  return summary;
}

function increment(summary, key) {
  summary[key] = (summary[key] || 0) + 1;
}

function planActions(plan) {
  if (Array.isArray(plan?.publications) && plan.publications.length > 0) {
    return plan.publications.map((publication) => publication.action).filter(Boolean);
  }
  return plan?.action ? [plan.action] : [];
}

function summarizePlannedActions(items) {
  const summary = { status: {}, price: {}, image: {}, create: {} };
  for (const item of items) {
    for (const domain of ["status", "price", "image"]) {
      const actions = planActions(item.plans?.[domain]);
      if (actions.length === 0) increment(summary[domain], "NOT_APPLICABLE");
      else for (const action of actions) increment(summary[domain], action);
    }

    if (item.classification !== "CREATE_SINGLE") {
      increment(summary.create, "NOT_APPLICABLE");
    } else if (item.plans?.create?.simulationResult === "WOULD_CREATE") {
      increment(summary.create, "WOULD_CREATE");
    } else {
      increment(summary.create, "BLOCKED");
    }
  }
  return summary;
}

function summarizeAvailability(items) {
  const summary = {};
  for (const item of items) increment(summary, item.availability ?? "null");
  return summary;
}

function summarizeTiendanube(items) {
  return {
    single: items.filter((item) => item.classification === "SINGLE").length,
    legacyGroup: items.filter((item) => item.classification === "LEGACY_GROUP").length,
    createSingle: items.filter((item) => item.classification === "CREATE_SINGLE").length,
    manualReview: items.filter((item) => item.classification === "MANUAL_REVIEW").length,
    confirmedNoMatch: items.filter(
      (item) => item.classification === "CREATE_SINGLE" && item.tiendanube?.matchCount === 0,
    ).length,
    multipleMatchesNotWhitelisted: items.filter(
      (item) =>
        item.classification === "MANUAL_REVIEW" &&
        item.tiendanube?.matchCount > 1 &&
        !item.tiendanube?.legacyGroup,
    ).length,
  };
}

function buildClientScopeReport({ identity, loaded, batch, sourceMetrics, completedAt }) {
  const scopeByNormalized = new Map(
    loaded.scope.items.map((item) => [item.normalizedSku, item]),
  );
  const items = batch.items.map((item) => {
    const scopeItem = scopeByNormalized.get(item.normalizedSku);
    return {
      ...item,
      clientScope: {
        sourceSku: scopeItem.sourceSku,
        occurrenceCount: scopeItem.occurrenceCount,
        publicationIds: scopeItem.publicationIds,
        productIds: scopeItem.productIds,
        sourcePages: scopeItem.sourcePages,
      },
      clientVsTiendanube: compareClientOccurrences(scopeItem, item),
    };
  });

  const enrichedItems = items;
  return {
    metadata: {
      runId: identity.runId,
      startedAt: identity.timestamp,
      completedAt,
      mode: "READ_ONLY",
      concurrency: 1,
      writesAllowed: false,
      scopeFile: loaded.filePath,
      sourceMetrics,
    },
    scopeSummary: loaded.summary,
    batchSummary: batch.summary,
    items: enrichedItems,
    manualReview: enrichedItems.filter((item) => item.requiresManualReview),
    functionalProblems: groupFunctionalProblems(enrichedItems),
    availabilitySummary: summarizeAvailability(enrichedItems),
    tiendanubeSummary: summarizeTiendanube(enrichedItems),
    plannedActions: summarizePlannedActions(enrichedItems),
    clientVsTiendanubeSummary: summarizeClientComparisons(enrichedItems),
    missingSkuRows: loaded.scope.missingSkuRows,
    security: {
      globalWriteRequested: false,
      createWriteRequested: false,
      priceWriteRequested: false,
      statusWriteRequested: false,
      imageWriteRequested: false,
      writeAttempted: 0,
    },
  };
}

async function runClientScope(options = {}, dependencies = {}) {
  const loaded = loadClientScope(options.scopeFile);
  const identity = options.runId
    ? { runId: options.runId, timestamp: (options.now || new Date()).toISOString() }
    : createClientScopeIdentity(options.now || new Date());
  const runBatch = dependencies.runBatchSync || runBatchSync;
  let source = dependencies.source || null;
  let client = dependencies.client || null;
  let batch;

  try {
    if (!dependencies.runBatchSync) {
      source = source || new ArcoreCatalogSource(dependencies.sourceOptions);
      await source.open();
      client = client || createTiendanubeReadOnlyClient();
    }

    const batchDependencies = dependencies.runBatchSync
      ? dependencies.batchDependencies || {}
      : {
          initialize: async () => ({ client }),
          executionDependencies: {
            syncProduct: (sourceSku, executionDependencies = {}) =>
              syncProduct(sourceSku, {
                client: executionDependencies.client || client,
                extractArcoreProduct: (sku) => source.extractProduct(sku),
              }),
          },
        };

    batch = await runBatch({
      skus: loaded.scope.items.map((item) => item.sourceSku),
      mode: "READ_ONLY",
      dependencies: batchDependencies,
      options: { concurrency: 1 },
    });
    assertReportReadOnly(batch);
    assertBatchMatchesScope(batch, loaded.scope.items);
  } finally {
    if (source?.close) await source.close();
  }

  const report = buildClientScopeReport({
    identity,
    loaded,
    batch,
    sourceMetrics: source?.metrics ? { ...source.metrics } : null,
    completedAt: new Date().toISOString(),
  });
  const persist = dependencies.persistClientScopeReport || persistClientScopeReport;
  const outputFile = options.persist === false ? null : persist(report, options.outputDir);
  return { ...report, outputFile };
}

module.exports = {
  ClientScopeRunError,
  assertBatchMatchesScope,
  assertReportReadOnly,
  buildClientScopeReport,
  compareClientOccurrences,
  functionalProblemCodes,
  groupFunctionalProblems,
  summarizeAvailability,
  summarizePlannedActions,
  summarizeTiendanube,
  runClientScope,
};
