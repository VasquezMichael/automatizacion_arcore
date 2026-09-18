const path = require("path");
const { runBatchSync } = require("../batch/batchSync");
const { persistBatchResult } = require("../batch/batchOutput");
const { syncProduct } = require("../sync/syncProduct");
const { createTiendanubeReadOnlyClient } = require("../tiendanube/readOnlyClient");
const { normalizeSku } = require("../tiendanube/sku");
const { ArcoreCatalogSource } = require("./arcoreCatalogSource");
const {
  CATALOG_CHECKPOINT_DIR,
  appendCompletedPage,
  initializeCheckpointState,
  loadCheckpoint,
  loadCompletedPages,
  resolveCheckpointStateFile,
  saveCheckpoint,
} = require("./catalogCheckpoint");
const { CATALOG_RUNS_DIR, createCatalogIdentity, persistCatalogRun } = require("./catalogOutput");

const CATALOG_MODE = Object.freeze({
  PLAN_BATCH: "PLAN_BATCH",
  SCAN_ONLY: "SCAN_ONLY",
});
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_PLAN_MAX_ITEMS = 100;
const DEFAULT_HEALTH_CHECK_EVERY_PAGES = 100;
const CATALOG_FINGERPRINT = Object.freeze({
  endpoint: "/api/articulos",
  pageBase: 0,
  sourceSkuField: "codComercial",
  normalization: "normalizeSku-format-only",
});

class CatalogRunnerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CatalogRunnerError";
    this.code = code;
    if (details) this.details = details;
  }
}

function validateRunnerOptions(mode, options) {
  if (!Object.values(CATALOG_MODE).includes(mode)) {
    throw new CatalogRunnerError("CATALOG_MODE_INVALID", `Modo de catalogo invalido: ${mode}.`);
  }
  const full = options.full === true;
  const maxPages = options.maxPages === undefined ? (full ? null : DEFAULT_MAX_PAGES) : options.maxPages;
  if (maxPages === null && !full) {
    throw new CatalogRunnerError(
      "CATALOG_FULL_FLAG_REQUIRED",
      "Un recorrido sin limite requiere --full explicito.",
    );
  }
  if (maxPages !== null && (!Number.isInteger(maxPages) || maxPages < 1)) {
    throw new CatalogRunnerError("CATALOG_MAX_PAGES_INVALID", "maxPages debe ser un entero positivo.");
  }
  const startPage = options.startPage ?? 0;
  if (!Number.isInteger(startPage) || startPage < 0) {
    throw new CatalogRunnerError("CATALOG_START_PAGE_INVALID", "startPage debe ser cero o mayor.");
  }
  const maxItems = options.maxItems ?? DEFAULT_PLAN_MAX_ITEMS;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new CatalogRunnerError("CATALOG_MAX_ITEMS_INVALID", "maxItems debe ser un entero positivo.");
  }
  const healthCheckEveryPages =
    options.healthCheckEveryPages ?? DEFAULT_HEALTH_CHECK_EVERY_PAGES;
  if (!Number.isInteger(healthCheckEveryPages) || healthCheckEveryPages < 1) {
    throw new CatalogRunnerError(
      "CATALOG_HEALTH_INTERVAL_INVALID",
      "healthCheckEveryPages debe ser un entero positivo.",
    );
  }
  return { full, maxPages, startPage, maxItems, healthCheckEveryPages };
}

function addUniqueWarning(warnings, warning) {
  const key = JSON.stringify([warning.code, warning.details || null]);
  if (!warnings.some((item) => JSON.stringify([item.code, item.details || null]) === key)) {
    warnings.push(warning);
  }
}

function createCatalogState() {
  return {
    catalogItemCount: 0,
    validSkuCount: 0,
    invalidItems: [],
    skuByNormalized: new Map(),
    duplicateByNormalized: new Map(),
    firstPageById: new Map(),
    repeatedIds: new Map(),
    warnings: [],
  };
}

function processCatalogArticles(state, articles, page) {
  for (const article of articles) {
    state.catalogItemCount += 1;
    const id = article?.id ? String(article.id) : null;
    const codComercial =
      typeof article?.codComercial === "string" ? article.codComercial.trim() : "";

    if (id) {
      if (state.firstPageById.has(id)) {
        const pages = state.repeatedIds.get(id) || [state.firstPageById.get(id)];
        if (!pages.includes(page)) pages.push(page);
        state.repeatedIds.set(id, pages);
        addUniqueWarning(state.warnings, {
          code: "CATALOG_ID_REPEATED",
          message: "El mismo id Arcore aparecio en multiples paginas.",
          details: { id, pages },
        });
      } else {
        state.firstPageById.set(id, page);
      }
    }

    if (!codComercial) {
      state.invalidItems.push({
        id,
        page,
        code: "CATALOG_ITEM_WITHOUT_COD_COMERCIAL",
      });
      continue;
    }

    const normalizedSku = normalizeSku(codComercial);
    if (!normalizedSku) {
      state.invalidItems.push({
        id,
        codComercial,
        page,
        code: "CATALOG_ITEM_INVALID_COD_COMERCIAL",
      });
      continue;
    }

    state.validSkuCount += 1;
    const existing = state.skuByNormalized.get(normalizedSku);
    if (!existing) {
      state.skuByNormalized.set(normalizedSku, {
        id,
        codComercial,
        normalizedSku,
        page,
      });
      continue;
    }

    const duplicate = state.duplicateByNormalized.get(normalizedSku) || {
      normalizedSku,
      codComercial: existing.codComercial,
      pages: [existing.page],
      ids: existing.id ? [existing.id] : [],
      occurrences: 1,
    };
    duplicate.occurrences += 1;
    if (!duplicate.pages.includes(page)) duplicate.pages.push(page);
    if (id && !duplicate.ids.includes(id)) duplicate.ids.push(id);
    state.duplicateByNormalized.set(normalizedSku, duplicate);

    if (id && existing.id && id !== existing.id) {
      addUniqueWarning(state.warnings, {
        code: "CATALOG_SKU_MULTIPLE_IDS",
        message: "El mismo SKU normalizado aparece con distintos ids Arcore.",
        details: { normalizedSku, ids: [...duplicate.ids] },
      });
    }
  }
}

function restoreCatalogState(records) {
  const state = createCatalogState();
  for (const record of records) processCatalogArticles(state, record.articles || [], record.page);
  return state;
}

function stateSummary(state) {
  return {
    catalogItemCount: state.catalogItemCount,
    validSkuCount: state.validSkuCount,
    uniqueSkuCount: state.skuByNormalized.size,
    duplicateSkuCount: state.validSkuCount - state.skuByNormalized.size,
    duplicateGroupCount: state.duplicateByNormalized.size,
    invalidItemCount: state.invalidItems.length,
    repeatedIdCount: state.repeatedIds.size,
  };
}

function paginationWarning(previousPages, currentPages, stage) {
  if (currentPages > previousPages) {
    return {
      code: "CATALOG_PAGINATION_EXPANDED",
      message: "La cantidad de paginas del catalogo aumento durante el recorrido.",
      details: { previousPages, currentPages, stage },
    };
  }
  if (currentPages < previousPages) {
    return {
      code: "CATALOG_PAGINATION_REDUCED",
      message: "La cantidad de paginas del catalogo disminuyo durante el recorrido.",
      details: { previousPages, currentPages, stage },
    };
  }
  return null;
}

function validateCheckpointCompatibility(checkpoint, mode, startPage, health) {
  if (checkpoint.mode !== mode) {
    throw new CatalogRunnerError(
      "CATALOG_CHECKPOINT_MODE_MISMATCH",
      "El checkpoint pertenece a otro modo de catalogo.",
    );
  }
  if (checkpoint.startPage !== startPage) {
    throw new CatalogRunnerError(
      "CATALOG_CHECKPOINT_START_PAGE_MISMATCH",
      "El startPage no coincide con el checkpoint.",
    );
  }
  if (JSON.stringify(checkpoint.catalogFingerprint) !== JSON.stringify(CATALOG_FINGERPRINT)) {
    throw new CatalogRunnerError(
      "CATALOG_CHECKPOINT_FINGERPRINT_MISMATCH",
      "El checkpoint no es compatible con la fuente actual.",
    );
  }
  if (checkpoint.pageSizeSeen !== health.pageSize) {
    throw new CatalogRunnerError(
      "CATALOG_CHECKPOINT_PAGE_SIZE_MISMATCH",
      "El pageSize actual no coincide con el checkpoint; no es seguro reanudar.",
      { checkpoint: checkpoint.pageSizeSeen, current: health.pageSize },
    );
  }
}

function serializePageError(error, page) {
  return {
    code: error.code || "CATALOG_PAGE_FAILED",
    message: error.message || "Fallo de lectura de pagina.",
    page,
    status: error.status ?? null,
    attempts: error.attempts ?? error.details?.attempts ?? null,
    retries: error.retries ?? error.details?.retries ?? null,
  };
}

async function defaultPlanBatch({ skus, source, maxItems }) {
  const client = createTiendanubeReadOnlyClient();
  const selectedSkus = skus.slice(0, maxItems).map((item) => item.codComercial);
  const batch = await runBatchSync({
    skus: selectedSkus,
    mode: "READ_ONLY",
    dependencies: {
      initialize: async () => ({ client }),
      executionDependencies: {
        syncProduct: async (sourceSku, dependencies = {}) =>
          syncProduct(sourceSku, {
            client: dependencies.client || client,
            extractArcoreProduct: (sku) => source.extractProduct(sku),
          }),
      },
    },
    options: { concurrency: 1 },
  });
  const outputFile = persistBatchResult(batch);
  return {
    outputFile,
    metadata: batch.metadata,
    summary: batch.summary,
  };
}

async function runCatalog({ mode = CATALOG_MODE.SCAN_ONLY, options = {}, dependencies = {} } = {}) {
  const validated = validateRunnerOptions(mode, options);
  const source = dependencies.source || new ArcoreCatalogSource(dependencies.sourceOptions);
  const checkpointDir = options.checkpointDir || CATALOG_CHECKPOINT_DIR;
  const outputDir = options.outputDir || CATALOG_RUNS_DIR;
  const identity = options.resume
    ? null
    : options.runId
      ? { runId: options.runId, startedAt: (options.now || new Date()).toISOString() }
      : createCatalogIdentity(options.now || new Date());
  const warnings = [];
  const errors = [];
  let checkpoint;
  let checkpointFile;
  let stateFile;
  let state;
  let pageRecords = [];
  let initialPagination;
  let nextPage;
  let lastCompletedPage;
  let status = "RUNNING";
  let batch = null;
  const startedClock = Date.now();

  await source.open();
  try {
    const initialHealth = await source.healthCheck();
    if (options.resume) {
      const loaded = loadCheckpoint(options.resume);
      checkpoint = loaded.checkpoint;
      checkpointFile = loaded.checkpointFile;
      validateCheckpointCompatibility(checkpoint, mode, checkpoint.startPage, initialHealth);
      stateFile = resolveCheckpointStateFile(checkpoint, checkpointFile);
      pageRecords = loadCompletedPages(stateFile, checkpoint.lastCompletedPage);
      state = restoreCatalogState(pageRecords);
      initialPagination = checkpoint.initialPagination;
      nextPage = checkpoint.nextPage;
      lastCompletedPage = checkpoint.lastCompletedPage;
      const changed = paginationWarning(
        checkpoint.totalPagesSeen,
        initialHealth.totalPages,
        "RESUME",
      );
      if (changed) addUniqueWarning(warnings, changed);
    } else {
      const paths = initializeCheckpointState(identity.runId, checkpointDir);
      checkpointFile = paths.checkpointFile;
      stateFile = paths.stateFile;
      state = createCatalogState();
      initialPagination = {
        total: initialHealth.total,
        totalPages: initialHealth.totalPages,
        pageSize: initialHealth.pageSize,
      };
      nextPage = validated.startPage;
      lastCompletedPage = null;
      checkpoint = {
        runId: identity.runId,
        startedAt: identity.startedAt,
        mode,
        status,
        startPage: validated.startPage,
        nextPage,
        lastCompletedPage,
        totalPagesSeen: initialHealth.totalPages,
        totalItemsSeen: 0,
        pageSizeSeen: initialHealth.pageSize,
        processedUniqueSkuCount: 0,
        catalogFingerprint: CATALOG_FINGERPRINT,
        initialPagination,
        stateFile: path.basename(stateFile),
        pendingErrors: [],
      };
      saveCheckpoint(checkpoint, checkpointFile);
    }

    warnings.push(...state.warnings);
    let totalPagesCurrent = initialHealth.totalPages;
    let pagesThisInvocation = 0;

    if (nextPage >= totalPagesCurrent) status = "COMPLETE";
    while (status === "RUNNING" && nextPage < totalPagesCurrent) {
      if (validated.maxPages !== null && pagesThisInvocation >= validated.maxPages) {
        status = "LIMIT_REACHED";
        break;
      }

      if (
        pagesThisInvocation > 0 &&
        pagesThisInvocation % validated.healthCheckEveryPages === 0
      ) {
        const health = await source.healthCheck();
        if (health.pageSize !== checkpoint.pageSizeSeen) {
          errors.push({
            code: "CATALOG_PAGE_SIZE_CHANGED",
            message: "El pageSize cambio durante el recorrido.",
            page: nextPage,
          });
          status = "PAUSED";
          break;
        }
        const changed = paginationWarning(totalPagesCurrent, health.totalPages, "HEALTH_CHECK");
        if (changed) addUniqueWarning(warnings, changed);
        totalPagesCurrent = health.totalPages;
      }

      let pageResult;
      try {
        pageResult = await source.readPage(nextPage);
        if (pageResult.pageSize !== checkpoint.pageSizeSeen) {
          throw new CatalogRunnerError(
            "CATALOG_PAGE_SIZE_CHANGED",
            "El pageSize cambio durante el recorrido.",
          );
        }
        const changed = paginationWarning(totalPagesCurrent, pageResult.totalPages, "PAGE_READ");
        if (changed) addUniqueWarning(warnings, changed);
        totalPagesCurrent = pageResult.totalPages;
        if (pageResult.items.length === 0 && nextPage < totalPagesCurrent) {
          throw new CatalogRunnerError(
            "CATALOG_UNEXPECTED_EMPTY_PAGE",
            "La API devolvio una pagina vacia dentro del rango declarado.",
          );
        }
      } catch (error) {
        errors.push(serializePageError(error, nextPage));
        status = "PAUSED";
        break;
      }

      processCatalogArticles(state, pageResult.items, nextPage);
      for (const warning of state.warnings) addUniqueWarning(warnings, warning);
      appendCompletedPage(stateFile, nextPage, pageResult.items, pageResult);
      const storedRecord = {
        page: nextPage,
        pageSize: pageResult.pageSize,
        itemCount: pageResult.items.length,
        total: pageResult.total,
        totalPages: pageResult.totalPages,
        timestamp: pageResult.timestamp,
        result: "COMPLETED",
        retries: pageResult.retries,
        articles: pageResult.items.map((article) => ({
          id: article.id || null,
          codComercial: article.codComercial || null,
        })),
      };
      pageRecords.push(storedRecord);
      lastCompletedPage = nextPage;
      nextPage += 1;
      pagesThisInvocation += 1;

      Object.assign(checkpoint, {
        status: "RUNNING",
        nextPage,
        lastCompletedPage,
        totalPagesSeen: totalPagesCurrent,
        totalItemsSeen: state.catalogItemCount,
        pageSizeSeen: pageResult.pageSize,
        processedUniqueSkuCount: state.skuByNormalized.size,
        pendingErrors: [],
      });
      saveCheckpoint(checkpoint, checkpointFile);
    }

    if (status === "RUNNING" && nextPage >= totalPagesCurrent) status = "COMPLETE";
    let finalHealth = null;
    if (status !== "PAUSED") {
      finalHealth = await source.healthCheck();
      if (finalHealth.pageSize !== checkpoint.pageSizeSeen) {
        errors.push({
          code: "CATALOG_PAGE_SIZE_CHANGED",
          message: "El pageSize cambio al finalizar el recorrido.",
          page: nextPage,
        });
        status = "PAUSED";
      } else {
        const changed = paginationWarning(totalPagesCurrent, finalHealth.totalPages, "FINAL");
        if (changed) addUniqueWarning(warnings, changed);
        totalPagesCurrent = finalHealth.totalPages;
        if (status === "COMPLETE" && nextPage < totalPagesCurrent) {
          status = "LIMIT_REACHED";
        }
      }
    }

    Object.assign(checkpoint, {
      status,
      nextPage,
      lastCompletedPage,
      totalPagesSeen: totalPagesCurrent,
      totalItemsSeen: state.catalogItemCount,
      processedUniqueSkuCount: state.skuByNormalized.size,
      pendingErrors: errors,
    });
    saveCheckpoint(checkpoint, checkpointFile);

    const skus = [...state.skuByNormalized.values()];
    if (mode === CATALOG_MODE.PLAN_BATCH && status !== "PAUSED") {
      const planBatch = dependencies.planBatch || defaultPlanBatch;
      batch = await planBatch({ skus, source, maxItems: validated.maxItems });
    }

    const result = {
      metadata: {
        runId: checkpoint.runId,
        startedAt: checkpoint.startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedClock,
        mode,
        status,
        readOnly: true,
        writesAllowed: false,
        fullRequested: validated.full,
        maxPages: validated.maxPages,
        maxItems: mode === CATALOG_MODE.PLAN_BATCH ? validated.maxItems : null,
        startPage: checkpoint.startPage,
        resumed: Boolean(options.resume),
        sourceMetrics: { ...source.metrics },
      },
      pagination: {
        initial: initialPagination,
        final: finalHealth
          ? {
              total: finalHealth.total,
              totalPages: finalHealth.totalPages,
              pageSize: finalHealth.pageSize,
            }
          : null,
        pages: pageRecords.map(({ articles, ...record }) => record),
        pagesCompleted: pageRecords.length,
        pagesProcessedThisInvocation: pagesThisInvocation,
      },
      summary: {
        ...stateSummary(state),
        pageCount: pageRecords.length,
        warningCount: warnings.length,
        errorCount: errors.length,
      },
      warnings,
      errors,
      duplicates: [...state.duplicateByNormalized.values()],
      invalidItems: state.invalidItems,
      checkpoint: {
        file: checkpointFile,
        stateFile,
        nextPage,
        lastCompletedPage,
        status,
      },
      skus,
      batch,
    };
    const persist = dependencies.persistCatalogRun || persistCatalogRun;
    const outputFile = options.persist === false ? null : persist(result, outputDir);
    return { ...result, outputFile };
  } finally {
    await source.close();
  }
}

module.exports = {
  CATALOG_FINGERPRINT,
  CATALOG_MODE,
  CatalogRunnerError,
  DEFAULT_HEALTH_CHECK_EVERY_PAGES,
  DEFAULT_MAX_PAGES,
  DEFAULT_PLAN_MAX_ITEMS,
  createCatalogState,
  defaultPlanBatch,
  paginationWarning,
  processCatalogArticles,
  restoreCatalogState,
  runCatalog,
  stateSummary,
  validateCheckpointCompatibility,
  validateRunnerOptions,
};
