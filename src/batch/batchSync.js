const { ensureAuthenticatedSession } = require("../extractByCodesTest");
const { executeSyncPlan } = require("../executor/executeSyncPlan");
const { getTiendanubeConfig } = require("../tiendanube/client");
const { createTiendanubeReadOnlyClient } = require("../tiendanube/readOnlyClient");
const { createBatchIdentity } = require("./batchOutput");
const { prepareBatchInput } = require("./batchInput");
const { buildBatchSummary } = require("./batchSummary");

const MAX_CONCURRENCY = 3;
const FORCED_READ_ONLY_ENV = Object.freeze({
  TIENDANUBE_DRY_RUN: "true",
  TIENDANUBE_EXECUTION_ENABLED: "false",
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "false",
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "false",
  TIENDANUBE_IMAGE_EXECUTION_ENABLED: "false",
  TIENDANUBE_CREATE_EXECUTION_ENABLED: "false",
});

class BatchFatalError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BatchFatalError";
    this.code = code;
    if (details) this.details = details;
  }
}

function validateOptions(options) {
  if (options.mode && options.mode !== "READ_ONLY") {
    throw new BatchFatalError(
      "BATCH_MODE_NOT_ALLOWED",
      "Este batch solo admite mode=READ_ONLY.",
    );
  }
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new BatchFatalError(
      "BATCH_CONCURRENCY_INVALID",
      `La concurrencia debe ser un entero entre 1 y ${MAX_CONCURRENCY}.`,
    );
  }
  return { concurrency };
}

async function initializeDefaultDependencies() {
  getTiendanubeConfig();
  await ensureAuthenticatedSession();
  return { client: createTiendanubeReadOnlyClient() };
}

function readOnlyExecutionDependencies(client, supplied = {}) {
  const allowed = {};
  for (const key of ["syncProduct", "revalidateSyncPlan", "revalidationDependencies", "now"]) {
    if (supplied[key] !== undefined) allowed[key] = supplied[key];
  }
  return {
    ...allowed,
    ...(client ? { client } : {}),
    env: { ...FORCED_READ_ONLY_ENV },
    persist: false,
  };
}

function assertReadOnlyExecution(execution) {
  const unsafe =
    execution?.globalWriteRequested ||
    execution?.priceWriteRequested ||
    execution?.statusWriteRequested ||
    execution?.imageWriteRequested ||
    execution?.createWriteRequested ||
    execution?.writeOperationsAvailable ||
    execution?.result?.writeAttempted;
  if (unsafe) {
    throw new BatchFatalError(
      "BATCH_READ_ONLY_INVARIANT_VIOLATION",
      "El executor reporto una operacion mutable en un batch read-only.",
    );
  }
}

function uniqueEntries(entries) {
  const seen = new Set();
  return (entries || []).filter((entry) => {
    const key = JSON.stringify([entry?.code || null, entry?.message || null]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function itemStatus(execution) {
  const status = execution?.result?.executionStatus;
  if (["FAILED", "PARTIAL_FAILURE"].includes(status)) return "FAILED";
  if (status === "BLOCKED") return "BLOCKED";
  return "SUCCEEDED";
}

function requiresManualReview(execution, status) {
  if (execution?.classification === "MANUAL_REVIEW") return true;
  if (status === "FAILED" || status === "BLOCKED") return true;
  return (execution?.executionPlan?.actions || []).some((action) =>
    ["BLOCKED", "NOT_EXECUTABLE", "REVALIDATION_FAILED"].includes(
      action.executionResult || action.simulationResult,
    ),
  );
}

function buildBatchItemResult(inputItem, execution) {
  const plan = execution.originalPlan || {};
  const status = itemStatus(execution);
  const createAction = (execution.executionPlan?.actions || []).find(
    (action) => action.type === "CREATE_PRODUCT",
  );
  return {
    inputSku: inputItem.inputSku,
    normalizedSku: execution.normalizedSku || inputItem.normalizedSku,
    matchedCode: execution.matchedCode || null,
    supplierResolution: execution.supplierResolution || null,
    classification: execution.classification || null,
    availability: plan.supplier?.availability || null,
    tiendanube: {
      matchCount: plan.tiendanube?.matchCount ?? null,
      legacyGroup: plan.tiendanube?.legacyGroup || null,
    },
    status,
    requiresManualReview: requiresManualReview(execution, status),
    result: {
      executionStatus: execution.result?.executionStatus || "FAILED",
      revalidationStatus: execution.revalidation?.status || "NOT_RUN",
      wouldWrite: execution.result?.wouldWrite || 0,
      blockedActions: execution.result?.blockedActions || 0,
      failedActions: execution.result?.failedActions || 0,
      writeAttempted: false,
      readOnly: true,
    },
    plans: {
      status: plan.plans?.status || null,
      price: plan.plans?.price || null,
      image: plan.plans?.image || null,
      create: createAction || null,
    },
    warnings: uniqueEntries(execution.warnings),
    errors: uniqueEntries(execution.errors),
  };
}

function failedBatchItem(inputItem, error, stage = "EXECUTION") {
  return {
    inputSku: inputItem.inputSku,
    normalizedSku: inputItem.normalizedSku,
    matchedCode: null,
    supplierResolution: null,
    classification: null,
    availability: null,
    tiendanube: { matchCount: null, legacyGroup: null },
    status: "FAILED",
    requiresManualReview: true,
    result: {
      executionStatus: "FAILED",
      revalidationStatus: "NOT_RUN",
      wouldWrite: 0,
      blockedActions: 0,
      failedActions: 1,
      writeAttempted: false,
      readOnly: true,
    },
    plans: { status: null, price: null, image: null, create: null },
    warnings: [],
    errors: [
      {
        code: error.code || "BATCH_ITEM_FAILED",
        message: error.message || "Fallo no identificado durante el procesamiento del SKU.",
        stage,
      },
    ],
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
  );
  return results;
}

async function runBatchSync({ skus, mode = "READ_ONLY", dependencies = {}, options = {} }) {
  const input = prepareBatchInput(skus);
  const { concurrency } = validateOptions({ ...options, mode });
  const now = options.now || new Date();
  const identity = options.batchId
    ? { batchId: options.batchId, timestamp: now.toISOString() }
    : createBatchIdentity(now);

  let initialized = {};
  if (input.items.length > 0) {
    try {
      const initialize = dependencies.initialize || initializeDefaultDependencies;
      initialized = (await initialize()) || {};
    } catch (error) {
      throw new BatchFatalError(
        "BATCH_INITIALIZATION_FAILED",
        "No se pudieron inicializar las dependencias globales del batch.",
        { causeCode: error.code || "ERROR", causeMessage: error.message },
      );
    }
  }

  const execute = dependencies.executeSyncPlan || executeSyncPlan;
  const client = dependencies.client || initialized.client;
  const executionDependencies = readOnlyExecutionDependencies(
    client,
    dependencies.executionDependencies,
  );

  const items = await mapWithConcurrency(input.items, concurrency, async (inputItem) => {
    try {
      const execution = await execute(inputItem.inputSku, executionDependencies);
      assertReadOnlyExecution(execution);
      return buildBatchItemResult(inputItem, execution);
    } catch (error) {
      if (error.code === "BATCH_READ_ONLY_INVARIANT_VIOLATION") throw error;
      return failedBatchItem(inputItem, error);
    }
  });

  const completedAt = options.completedAt || new Date().toISOString();
  return {
    metadata: {
      batchId: identity.batchId,
      startedAt: identity.timestamp,
      completedAt,
      mode: "READ_ONLY",
      concurrency,
      writesAllowed: false,
      itemOrder: input.items.map((item) => item.normalizedSku),
    },
    input: {
      inputCount: input.inputCount,
      uniqueSkuCount: input.uniqueSkuCount,
      duplicateInputCount: input.duplicateInputCount,
      duplicates: input.duplicates,
    },
    summary: buildBatchSummary(input, items),
    items,
  };
}

module.exports = {
  BatchFatalError,
  FORCED_READ_ONLY_ENV,
  MAX_CONCURRENCY,
  assertReadOnlyExecution,
  buildBatchItemResult,
  failedBatchItem,
  mapWithConcurrency,
  readOnlyExecutionDependencies,
  runBatchSync,
  validateOptions,
};
