const { ensureAuthenticatedSession } = require("../extractByCodesTest");
const { loadClientScope } = require("../clientScope/clientScope");
const { persistClientScopeReport } = require("../clientScope/clientScopeOutput");
const { runClientScope } = require("../clientScope/clientScopeRunner");
const { readExecutionGates } = require("../executor/executionGuards");
const { runMutableBatch } = require("../mutableBatch/mutableBatchRunner");
const { getTiendanubeConfig } = require("../tiendanube/client");
const { dataPathFrom, resolveDataDir } = require("../config/dataDirectory");
const { acquireProductionSyncLock } = require("./productionSyncLock");
const { buildSafeProductionPlan } = require("./productionSyncPlanner");
const {
  createProductionSyncIdentity,
  persistProductionSyncCheckpoint,
  persistProductionSyncReport,
  reportPath,
  checkpointPath,
} = require("./productionSyncReport");

const MODES = Object.freeze(["PLAN", "DRY_RUN", "EXECUTE"]);

class ProductionSyncError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ProductionSyncError";
    this.code = code;
    if (details) this.details = details;
  }
}

function normalizeMode(mode) {
  const normalized = String(mode || "PLAN").trim().toUpperCase();
  if (!MODES.includes(normalized)) {
    throw new ProductionSyncError(
      "PRODUCTION_SYNC_MODE_INVALID",
      "El modo debe ser PLAN, DRY_RUN o EXECUTE.",
    );
  }
  return normalized;
}

function domainEnvKey(domain) {
  return `TIENDANUBE_${domain}_EXECUTION_ENABLED`;
}

function assertProductionExecutionAuthorized(options = {}) {
  if (normalizeMode(options.mode) !== "EXECUTE") return;
  const env = options.env || process.env;
  const gates = readExecutionGates(env);
  const missing = [];
  if (options.confirmRealWrites !== true) missing.push("--confirm-real-writes");
  if (gates.dryRun) missing.push("TIENDANUBE_DRY_RUN=false");
  if (!gates.executionEnabled) missing.push("TIENDANUBE_EXECUTION_ENABLED=true");
  for (const domain of options.domains || []) {
    if (String(env[domainEnvKey(domain)] || "false").trim().toLowerCase() !== "true") {
      missing.push(`${domainEnvKey(domain)}=true`);
    }
  }
  if (missing.length > 0) {
    throw new ProductionSyncError(
      "PRODUCTION_SYNC_EXECUTION_NOT_AUTHORIZED",
      `Faltan requisitos para EXECUTE: ${missing.join(", ")}.`,
      { missing },
    );
  }
}

async function defaultHealthCheck() {
  await ensureAuthenticatedSession();
  getTiendanubeConfig();
  return {
    status: "PASSED",
    arcoreSession: "VALIDATED",
    tiendanubeConfiguration: "VALIDATED",
  };
}

async function defaultFreshAnalysis({ scopeFile }) {
  return runClientScope({ scopeFile, persist: false });
}

function mutableOptions(subBatch, context, mode) {
  return {
    mode,
    skus: subBatch.skus,
    ...(mode === "PLAN"
      ? { autoBudget: true }
      : { maxWrites: subBatch.expectedWrites }),
    scopeFile: context.scopeFile,
    confirmRealWrites: context.confirmRealWrites === true,
    enablePRICE: subBatch.domain === "PRICE",
    enableSTATUS: subBatch.domain === "STATUS",
    enableIMAGE: subBatch.domain === "IMAGE",
    enableCREATE: subBatch.domain === "CREATE",
    ...(context.dataDir ? {
      planOutputDir: dataPathFrom(context.dataDir, "mutable-batch-plans"),
      checkpointOutputDir: dataPathFrom(context.dataDir, "mutable-batch-checkpoints"),
      runOutputDir: dataPathFrom(context.dataDir, "mutable-batch"),
    } : {}),
  };
}

function mutableResult(report, phase) {
  return {
    phase,
    runId: report.metadata.runId,
    planExpectedWrites: report.plan.expectedWrites,
    budgetMaxWrites: report.budget.maxWrites,
    consumedWrites: report.budget.writesConsumed,
    remainingWrites: report.budget.writesRemaining,
    writeAttempted: (report.writes || []).length,
    stopped: report.stopped,
    stopReason: report.stopReason,
    planFile: report.planFile,
    checkpointFile: report.checkpointFile,
    outputFile: report.outputFile,
    sessionMetrics: report.sessionMetrics || null,
  };
}

function assertExactBudget(subBatch, planReport) {
  if (
    planReport.plan.expectedWrites !== planReport.plan.metadata.maxWrites ||
    planReport.plan.expectedWrites !== planReport.budget.maxWrites
  ) {
    throw new ProductionSyncError(
      "PRODUCTION_SYNC_BUDGET_MISMATCH",
      `El budget del sub-batch ${subBatch.id} difiere del plan mutable fresco.`,
      {
        analysisExpectedWrites: subBatch.expectedWrites,
        mutableExpectedWrites: planReport.plan.expectedWrites,
        mutableMaxWrites: planReport.plan.metadata.maxWrites,
      },
    );
  }
}

async function defaultRunSubBatch(subBatch, context) {
  const planReport = await runMutableBatch(
    mutableOptions(subBatch, context, "PLAN"),
  );
  assertExactBudget(subBatch, planReport);
  const exactSubBatch = {
    ...subBatch,
    expectedWrites: planReport.plan.expectedWrites,
  };
  if (planReport.stopped) return mutableResult(planReport, "PLAN");

  if (context.mode !== "EXECUTE") {
    if (planReport.budget.writesConsumed !== 0 || (planReport.writes || []).length !== 0) {
      throw new ProductionSyncError(
        "PRODUCTION_SYNC_READ_ONLY_INVARIANT_VIOLATION",
        "Un sub-batch PLAN/DRY_RUN intento consumir writes.",
      );
    }
    return mutableResult(planReport, context.mode);
  }

  const executeReport = await runMutableBatch({
    ...mutableOptions(exactSubBatch, context, "EXECUTE"),
    resume: planReport.checkpointFile,
    planFile: planReport.planFile,
  });
  if (executeReport.budget.writesConsumed > exactSubBatch.expectedWrites) {
    throw new ProductionSyncError(
      "PRODUCTION_SYNC_BUDGET_EXCEEDED",
      `El sub-batch ${subBatch.id} excedio su budget aprobado.`,
    );
  }
  return mutableResult(executeReport, "EXECUTE");
}

function createBaseReport(identity, mode, scopeCount, env, outputDir) {
  return {
    runId: identity.runId,
    mode,
    startedAt: identity.timestamp,
    finishedAt: null,
    duration: null,
    durationMs: null,
    scopeCount,
    resolved: 0,
    alreadySynced: 0,
    autoExecutable: 0,
    manualReview: 0,
    notFound: 0,
    unknown: 0,
    technicalBlocked: 0,
    classifications: {},
    resolutions: {},
    domainOrder: [],
    batchConfig: null,
    exclusions: {},
    domainExclusions: {},
    subBatches: [],
    plannedWrites: 0,
    executedWrites: 0,
    writeAttempted: 0,
    stopped: false,
    stopReason: null,
    healthCheck: null,
    analysisReport: null,
    sessionMetrics: { analysis: null, subBatches: [] },
    security: {
      initialGates: readExecutionGates(env),
      finalGates: null,
    },
    summary: {},
    outputFile: reportPath(identity.runId, outputDir),
    checkpointFile: checkpointPath(identity.runId, outputDir),
  };
}

function applyPlanToReport(report, plan) {
  report.resolved = plan.resolved;
  report.alreadySynced = plan.alreadySynced;
  report.autoExecutable = plan.autoExecutable;
  report.manualReview = plan.exclusions.manualReview.length;
  report.notFound = plan.exclusions.notFound.length;
  report.unknown = plan.exclusions.unknown.length;
  report.technicalBlocked = plan.exclusions.technicalBlocked.length;
  report.classifications = plan.classifications;
  report.resolutions = plan.resolutions;
  report.domainOrder = plan.domainOrder;
  report.batchConfig = plan.batchConfig;
  report.exclusions = plan.exclusions;
  report.domainExclusions = plan.domainExclusions;
  report.plannedWrites = plan.plannedWrites;
  report.subBatches = plan.subBatches.map((subBatch) => ({ ...subBatch }));
}

function markStopped(report, error, subBatch) {
  report.stopped = true;
  report.stopReason = {
    code: error.code || "PRODUCTION_SYNC_FAILED",
    message: error.message || "La sincronizacion productiva fue detenida.",
    ...(error.details ? { details: error.details } : {}),
    ...(subBatch ? { subBatchId: subBatch.id } : {}),
  };
}

function finalizeReport(report, env, now = new Date()) {
  report.finishedAt = now.toISOString();
  report.durationMs = Math.max(0, now.getTime() - Date.parse(report.startedAt));
  report.duration = report.durationMs;
  report.security.finalGates = readExecutionGates(env);
  report.summary = {
    scopeCount: report.scopeCount,
    resolved: report.resolved,
    alreadySynced: report.alreadySynced,
    autoExecutable: report.autoExecutable,
    exceptions:
      report.manualReview + report.notFound + report.unknown + report.technicalBlocked,
    subBatchCount: report.subBatches.length,
    completedSubBatches: report.subBatches.filter((item) => item.state === "COMPLETED").length,
    plannedWrites: report.plannedWrites,
    executedWrites: report.executedWrites,
    writeAttempted: report.writeAttempted,
    stopped: report.stopped,
  };
  return report;
}

async function runProductionSync(options = {}, dependencies = {}) {
  const mode = normalizeMode(options.mode);
  const env = dependencies.env || process.env;
  const dataDir = resolveDataDir(env, options.dataDir);
  if (mode === "EXECUTE") {
    assertProductionExecutionAuthorized({
      mode,
      env,
      confirmRealWrites: options.confirmRealWrites,
    });
  }

  const loadScope = dependencies.loadScope || loadClientScope;
  const loaded = loadScope(options.scopeFile);
  const identity = dependencies.identity || createProductionSyncIdentity(options.now || new Date());
  const outputDir = options.outputDir || dataPathFrom(dataDir, "production-sync");
  const report = createBaseReport(
    identity,
    mode,
    loaded.scope.items.length,
    env,
    outputDir,
  );
  const acquireLock = dependencies.acquireLock || acquireProductionSyncLock;
  const lock = acquireLock({
    filePath: options.lockFile || dataPathFrom(dataDir, "production-sync", "production-sync.lock"),
    staleMinutes: options.staleLockMinutes,
    runId: identity.runId,
    now: options.now,
  });
  const persistCheckpoint = dependencies.persistCheckpoint || persistProductionSyncCheckpoint;
  const persistReport = dependencies.persistReport || persistProductionSyncReport;
  const runHealthCheck = dependencies.runHealthCheck || defaultHealthCheck;
  const runFreshAnalysis = dependencies.runFreshAnalysis || defaultFreshAnalysis;
  const persistFreshAnalysis = dependencies.persistFreshAnalysis || persistClientScopeReport;
  const buildPlan = dependencies.buildPlan || buildSafeProductionPlan;
  const runSubBatch = dependencies.runSubBatch || defaultRunSubBatch;

  try {
    report.healthCheck = await runHealthCheck({ loaded, scopeFile: loaded.filePath });
    const analysis = await runFreshAnalysis({
      loaded,
      scopeFile: loaded.filePath,
      mode: "READ_ONLY",
    });
    report.sessionMetrics.analysis = analysis.metadata?.sourceMetrics || null;
    report.analysisReport = {
      runId: analysis.metadata?.runId || null,
      completedAt: analysis.metadata?.completedAt || null,
      itemCount: Array.isArray(analysis.items) ? analysis.items.length : 0,
      outputFile: null,
    };
    if (options.persist !== false) {
      report.analysisReport.outputFile = persistFreshAnalysis(
        analysis,
        dataPathFrom(dataDir, "client-scope"),
      );
    }
    const plan = buildPlan(analysis, {
      env,
      batchConfig: options.batchConfig,
    });
    applyPlanToReport(report, plan);

    if (mode === "EXECUTE") {
      assertProductionExecutionAuthorized({
        mode,
        env,
        confirmRealWrites: options.confirmRealWrites,
        domains: [...new Set(plan.subBatches.map((item) => item.domain))],
      });
    }
    if (options.persist !== false) persistCheckpoint(report, outputDir);

    for (let index = 0; index < plan.subBatches.length; index += 1) {
      const planned = plan.subBatches[index];
      const subBatch = report.subBatches[index];
      subBatch.state = "RUNNING";
      try {
        const result = await runSubBatch(planned, {
          mode,
          env,
          dataDir,
          scopeFile: loaded.filePath,
          confirmRealWrites: options.confirmRealWrites,
        });
        if (result.planExpectedWrites !== result.budgetMaxWrites) {
          throw new ProductionSyncError(
            "PRODUCTION_SYNC_BUDGET_MISMATCH",
            `El resultado del sub-batch ${planned.id} no coincide con el budget aprobado.`,
          );
        }
        if (mode !== "EXECUTE" && (result.consumedWrites > 0 || result.writeAttempted > 0)) {
          throw new ProductionSyncError(
            "PRODUCTION_SYNC_READ_ONLY_INVARIANT_VIOLATION",
            `El sub-batch ${planned.id} intento escribir en ${mode}.`,
          );
        }
        const budgetDelta = result.planExpectedWrites - subBatch.expectedWrites;
        report.plannedWrites += budgetDelta;
        subBatch.state = result.stopped ? "STOPPED" : "COMPLETED";
        subBatch.expectedWrites = result.planExpectedWrites;
        subBatch.consumedWrites = result.consumedWrites;
        subBatch.remainingWrites = result.planExpectedWrites - result.consumedWrites;
        subBatch.mutable = result;
        report.executedWrites += result.consumedWrites;
        report.writeAttempted += result.writeAttempted;
        report.sessionMetrics.subBatches.push({
          id: planned.id,
          metrics: result.sessionMetrics,
        });
        if (result.stopped) {
          throw new ProductionSyncError(
            result.stopReason?.code || "PRODUCTION_SYNC_SUB_BATCH_STOPPED",
            result.stopReason?.message || `El sub-batch ${planned.id} fue detenido.`,
          );
        }
      } catch (error) {
        subBatch.state = "STOPPED";
        subBatch.error = {
          code: error.code || "PRODUCTION_SYNC_SUB_BATCH_FAILED",
          message: error.message,
        };
        markStopped(report, error, planned);
        if (options.persist !== false) persistCheckpoint(report, outputDir);
        break;
      }
      if (options.persist !== false) persistCheckpoint(report, outputDir);
    }
  } catch (error) {
    markStopped(report, error);
  } finally {
    try {
      report.lockReleased = lock.release();
    } catch (error) {
      report.lockReleased = false;
      if (!report.stopped) markStopped(report, error);
    }
  }

  finalizeReport(report, env, dependencies.finishedAt || new Date());
  if (options.persist !== false) {
    persistCheckpoint(report, outputDir);
    persistReport(report, outputDir);
  }
  return report;
}

module.exports = {
  MODES,
  ProductionSyncError,
  assertExactBudget,
  assertProductionExecutionAuthorized,
  defaultFreshAnalysis,
  defaultHealthCheck,
  defaultRunSubBatch,
  finalizeReport,
  normalizeMode,
  runProductionSync,
};
