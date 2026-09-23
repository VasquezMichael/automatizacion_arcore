const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ensureAuthenticatedSession } = require("../extractByCodesTest");
const { ArcoreCatalogSource } = require("../catalog/arcoreCatalogSource");
const { executeSyncPlan } = require("../executor/executeSyncPlan");
const { readExecutionGates } = require("../executor/executionGuards");
const { revalidateSyncPlan } = require("../executor/revalidate");
const { createTiendanubeCreateAdapter } = require("../executor/tiendanubeCreateAdapter");
const { createTiendanubeImageAdapter } = require("../executor/tiendanubeImageAdapter");
const { createTiendanubePriceAdapter } = require("../executor/tiendanubePriceAdapter");
const { createTiendanubeStatusAdapter } = require("../executor/tiendanubeStatusAdapter");
const { syncProduct } = require("../sync/syncProduct");
const { createTiendanubeClient } = require("../tiendanube/client");
const { normalizeSku } = require("../tiendanube/sku");
const {
  MutableWriteController,
  instrumentCreateAdapter,
  instrumentImageAdapter,
  instrumentPriceAdapter,
  instrumentStatusAdapter,
} = require("./mutableBatchAdapters");
const {
  MutableCheckpointError,
  checkpointPath,
  createCheckpoint,
  findCheckpointItem,
  loadCheckpoint,
  saveCheckpoint,
  validateResume,
} = require("./mutableBatchCheckpoint");
const {
  DOMAIN_ORDER,
  MutableBatchPlanError,
  STOP_CONDITIONS,
  assertPlanPriceSnapshotsComplete,
  assertPriceApprovedSnapshotComplete,
  assertSnapshotUnchanged,
  buildPlanItem,
  buildPreconditionSnapshot,
  prepareAllowlist,
  selectedDomains,
} = require("./mutableBatchPlan");
const {
  MUTABLE_PLAN_DIR,
  createMutableRunIdentity,
  persistMutablePlan,
  persistMutableRun,
} = require("./mutableBatchOutput");

const SAFE_ENV = Object.freeze({
  TIENDANUBE_DRY_RUN: "true",
  TIENDANUBE_EXECUTION_ENABLED: "false",
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "false",
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "false",
  TIENDANUBE_IMAGE_EXECUTION_ENABLED: "false",
  TIENDANUBE_CREATE_EXECUTION_ENABLED: "false",
});

const ACTION_TYPES = Object.freeze({
  PRICE: "PRICE",
  STATUS: "STATUS",
  IMAGE: "IMAGE",
  CREATE: "CREATE_PRODUCT",
});

class MutableBatchError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "MutableBatchError";
    this.code = code;
    if (details) this.details = details;
  }
}

function currentCodeVersion() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(__dirname, "..", ".."),
    encoding: "utf8",
  }).trim();
}

function currentMainVersion() {
  return execFileSync("git", ["rev-parse", "main"], {
    cwd: path.resolve(__dirname, "..", ".."),
    encoding: "utf8",
  }).trim();
}

function normalizeMode(mode) {
  const normalized = String(mode || "PLAN").trim().toUpperCase();
  if (!["PLAN", "EXECUTE"].includes(normalized)) {
    throw new MutableBatchError(
      "MUTABLE_MODE_INVALID",
      "El modo debe ser PLAN o EXECUTE.",
    );
  }
  return normalized;
}

function normalizeMaxWrites(value, mode) {
  const parsed = Number(value ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new MutableBatchError(
      "MUTABLE_WRITE_BUDGET_INVALID",
      "--max-writes debe ser un entero mayor o igual a cero.",
    );
  }
  if (mode === "EXECUTE" && parsed <= 0) {
    throw new MutableBatchError(
      "MUTABLE_WRITE_BUDGET_REQUIRED",
      "EXECUTE requiere --max-writes mayor que cero.",
    );
  }
  return parsed;
}

function domainEnvKey(domain) {
  return `TIENDANUBE_${domain}_EXECUTION_ENABLED`;
}

function assertExecutionAuthorized({ mode, confirmRealWrites, domains, maxWrites, env }) {
  if (mode !== "EXECUTE") return;
  const gates = readExecutionGates(env);
  const missing = [];
  if (!confirmRealWrites) missing.push("--confirm-real-writes");
  if (gates.dryRun) missing.push("TIENDANUBE_DRY_RUN=false");
  if (!gates.executionEnabled) missing.push("TIENDANUBE_EXECUTION_ENABLED=true");
  if (domains.length === 0) missing.push("dominio explicito");
  if (maxWrites <= 0) missing.push("write budget");
  for (const domain of domains) {
    if (String(env[domainEnvKey(domain)] || "false").toLowerCase() !== "true") {
      missing.push(`${domainEnvKey(domain)}=true`);
    }
  }
  if (missing.length > 0) {
    throw new MutableBatchError(
      "MUTABLE_EXECUTION_NOT_AUTHORIZED",
      `Faltan requisitos para writes: ${missing.join(", ")}.`,
      { missing },
    );
  }
}

function envForDomain(domain) {
  return {
    ...SAFE_ENV,
    TIENDANUBE_DRY_RUN: "false",
    TIENDANUBE_EXECUTION_ENABLED: "true",
    [domainEnvKey(domain)]: "true",
  };
}

async function openDefaultRuntime() {
  await ensureAuthenticatedSession();
  const source = new ArcoreCatalogSource();
  await source.open();
  await source.healthCheck();
  const client = createTiendanubeClient();
  return {
    client,
    source,
    metrics: source.metrics,
    async sync(sourceSku) {
      return syncProduct(sourceSku, {
        client,
        extractArcoreProduct: (sku) => source.extractProduct(sku),
      });
    },
    adapters: {
      PRICE: createTiendanubePriceAdapter(client),
      STATUS: createTiendanubeStatusAdapter(client),
      IMAGE: createTiendanubeImageAdapter(client),
      CREATE: createTiendanubeCreateAdapter(client),
    },
    async close() {
      await source.close();
    },
  };
}

async function defaultPlanSku(inputSku, runtime) {
  return executeSyncPlan(inputSku, {
    env: { ...SAFE_ENV },
    persist: false,
    client: runtime.client,
    syncProduct: (sku) => runtime.sync(sku),
  });
}

function actionNeedsWrite(domain, action) {
  if (domain === "PRICE") return action.plannedAction === "PRICE_UPDATE";
  if (domain === "STATUS") return ["PUBLISH", "UNPUBLISH"].includes(action.plannedAction);
  if (domain === "IMAGE") return action.plannedAction === "IMAGE_REPLACE";
  if (domain === "CREATE") return action.plannedAction === "CREATE_SINGLE";
  return false;
}

function relevantActions(execution, domain) {
  return (execution.executionPlan?.actions || []).filter(
    (action) => action.type === ACTION_TYPES[domain],
  );
}

function executionFailure(actions) {
  return actions.find((action) =>
    ["BLOCKED", "WRITE_FAILED", "WRITE_VERIFICATION_FAILED"].includes(
      action.executionResult,
    ),
  );
}

function executionPostState(actions) {
  return actions.map((action) => ({
    productId: action.productId ?? action.createdProductId ?? null,
    variantId: action.variantId ?? action.createdVariantId ?? null,
    result: action.executionResult,
    verifiedState: action.verifiedState || null,
    oldImageId: action.oldImageId ?? null,
    newImageId: action.newImageId ?? null,
    createdProductId: action.createdProductId ?? null,
    createdVariantId: action.createdVariantId ?? null,
  }));
}

function sameIdentitySnapshot(initial, current) {
  const fields = [
    "normalizedSku",
    "matchedCode",
    "supplierResolution",
    "classification",
    "matchCount",
    "productIds",
    "variantIds",
    "legacy",
  ];
  return fields.every(
    (field) => JSON.stringify(initial[field]) === JSON.stringify(current[field]),
  );
}

function sameDomainTarget(domain, initial, current) {
  if (domain === "PRICE") {
    return (
      initial.supplierPrice === current.supplierPrice &&
      initial.calculatedPrice === current.calculatedPrice
    );
  }
  if (domain === "STATUS") {
    return (
      initial.availability === current.availability &&
      initial.desiredPublished === current.desiredPublished
    );
  }
  if (domain === "IMAGE") {
    return (
      initial.sourceImageUrl === current.sourceImageUrl &&
      initial.sourceHash === current.sourceHash
    );
  }
  return false;
}

function planStillNeedsWrite(execution, domain) {
  return relevantActions(execution, domain).some((action) => actionNeedsWrite(domain, action));
}

async function reconcileImageResume({
  planItem,
  checkpoint,
  checkpointItem,
  checkpointFile,
  runtime,
  currentExecution,
}) {
  const newImageId = checkpointItem.returnedIds?.newImageId;
  const initial = planItem.domains.IMAGE.snapshot;
  const oldImageId = initial.publications.find((publication) => publication.imageId)?.imageId;
  const match = currentExecution.originalPlan?.tiendanube?.matches?.[0];
  if (!newImageId || !oldImageId || !match) return { verified: false };

  const adapter = runtime.adapters.IMAGE;
  const product = await adapter.getProduct(match.productId);
  const variant = (product?.variants || []).find(
    (item) => String(item.id) === String(match.variantId),
  );
  const images = await adapter.listProductImages(match.productId);
  const newPresent = images.some((image) => String(image.id) === String(newImageId));
  const oldPresent = images.some((image) => String(image.id) === String(oldImageId));
  const newPrimary = images.some(
    (image) => String(image.id) === String(newImageId) && Number(image.position) === 1,
  );
  const identityOk =
    String(product?.id) === String(match.productId) &&
    variant &&
    String(variant.id) === String(match.variantId) &&
    normalizeSku(variant.sku) === planItem.normalizedSku;
  const sourceVerified =
    currentExecution.originalPlan?.plans?.image?.action === "IMAGE_NO_CHANGE";
  if (!identityOk || !newPresent || !newPrimary || !sourceVerified) {
    return { verified: false };
  }
  if (!oldPresent) {
    return {
      verified: true,
      resumedWithoutPost: true,
      newImageId,
      oldImageId,
      oldImagePresent: false,
    };
  }

  const controller = new MutableWriteController({
    checkpoint,
    checkpointItem,
    checkpointFile,
    saveCheckpoint,
  });
  const wrapped = instrumentImageAdapter(adapter, controller);
  await wrapped.getProduct(match.productId);
  await wrapped.listProductImages(match.productId);
  await wrapped.deleteProductImage(match.productId, oldImageId);
  const finalImages = await wrapped.listProductImages(match.productId);
  const finalOk =
    finalImages.some((image) => String(image.id) === String(newImageId)) &&
    !finalImages.some((image) => String(image.id) === String(oldImageId));
  if (!finalOk) return { verified: false };
  return {
    verified: true,
    resumedWithoutPost: true,
    deleteCompletedOnResume: true,
    newImageId,
    oldImageId,
  };
}

async function defaultReconcileResume(context) {
  const {
    planItem,
    domain,
    checkpoint,
    checkpointItem,
    checkpointFile,
    runtime,
  } = context;
  const currentExecution = await defaultPlanSku(planItem.inputSku, runtime);
  const currentPlan = currentExecution.originalPlan;

  if (domain === "CREATE") {
    const productId = checkpointItem.returnedIds?.createdProductId;
    const variantId = checkpointItem.returnedIds?.createdVariantId;
    const match = currentPlan?.tiendanube?.matches?.[0];
    const verified =
      currentPlan?.classification === "SINGLE" &&
      currentPlan?.tiendanube?.matchCount === 1 &&
      String(match?.productId) === String(productId) &&
      (!variantId || String(match?.variantId) === String(variantId)) &&
      currentPlan?.normalizedSku === planItem.normalizedSku;
    return {
      verified,
      resumedWithoutPost: true,
      productId: productId || null,
      variantId: variantId || null,
    };
  }

  const currentSnapshot = buildPreconditionSnapshot(currentPlan, domain);
  const initialSnapshot = planItem.domains[domain].snapshot;
  if (
    !sameIdentitySnapshot(initialSnapshot, currentSnapshot) ||
    !sameDomainTarget(domain, initialSnapshot, currentSnapshot)
  ) {
    return { verified: false };
  }
  if (domain === "IMAGE") {
    return reconcileImageResume({
      ...context,
      currentExecution,
    });
  }
  if (!planStillNeedsWrite(currentExecution, domain)) {
    return { verified: true, resumedAlreadyApplied: true };
  }
  const hasFailedWrite = checkpoint.auditLog.some(
    (entry) =>
      entry.sku === checkpointItem.normalizedSku &&
      entry.domain === domain &&
      entry.httpResult === "FAILED",
  );
  if (hasFailedWrite) return { verified: false };
  return {
    verified: false,
    continueExecution: true,
    refreshedSnapshot: currentSnapshot,
  };
}

function instrumentedAdapters(runtime, controller) {
  return {
    priceAdapter: instrumentPriceAdapter(runtime.adapters.PRICE, controller),
    statusAdapter: instrumentStatusAdapter(runtime.adapters.STATUS, controller),
    imageAdapter: instrumentImageAdapter(runtime.adapters.IMAGE, controller),
    createAdapter: instrumentCreateAdapter(runtime.adapters.CREATE, controller),
  };
}

async function defaultExecuteDomain({
  planItem,
  domain,
  runtime,
  controller,
  checkpointItem,
}) {
  const initialSnapshot = domain === "PRICE"
    ? checkpointItem.approvedSnapshot
    : planItem.domains[domain].snapshot;
  let freshPlan = null;
  const execution = await executeSyncPlan(planItem.inputSku, {
    env: envForDomain(domain),
    persist: false,
    client: runtime.client,
    syncProduct: async (sku) => {
      freshPlan = await runtime.sync(sku);
      assertSnapshotUnchanged(
        initialSnapshot,
        buildPreconditionSnapshot(freshPlan, domain),
      );
      return freshPlan;
    },
    revalidateSyncPlan: async (plan, dependencies) => {
      const revalidation = await revalidateSyncPlan(plan, dependencies);
      checkpointItem.prevalidation = {
        checkedAt: revalidation.checkedAt,
        status: revalidation.status,
        ok: revalidation.ok,
        issues: revalidation.issues || [],
      };
      checkpointItem.state = revalidation.ok ? "PREVALIDATED" : "FAILED";
      controller.persist();
      return revalidation;
    },
    ...instrumentedAdapters(runtime, controller),
    stopOnAnyWriteFailure: true,
  });
  return execution;
}

function planPathForRun(runId, planDir = MUTABLE_PLAN_DIR) {
  return path.resolve(planDir, `${runId}.json`);
}

function loadPlanFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new MutableBatchError(
      "MUTABLE_PLAN_NOT_FOUND",
      `No existe el plan asociado al checkpoint: ${filePath}`,
    );
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stopCheckpoint(checkpoint, checkpointFile, error, item) {
  checkpoint.stopped = true;
  checkpoint.stopReason = {
    code: error.code || "MUTABLE_BATCH_FAILED",
    message: error.message,
  };
  if (item) {
    item.state = item.state === "FAILED" ? "FAILED" : "STOPPED";
    item.errors.push(checkpoint.stopReason);
  }
  saveCheckpoint(checkpoint, checkpointFile);
}

function createReport(plan, checkpoint, options = {}) {
  return {
    metadata: {
      runId: plan.metadata.runId,
      mode: options.mode || plan.metadata.mode,
      startedAt: plan.metadata.generatedAt,
      completedAt: new Date().toISOString(),
      mainSha: plan.metadata.mainSha,
    },
    plan,
    execution: {
      stopped: checkpoint.stopped,
      stopReason: checkpoint.stopReason,
      items: checkpoint.items,
    },
    writes: checkpoint.auditLog,
    verifications: checkpoint.items
      .filter((item) => item.verification)
      .map((item) => ({ key: item.key, verification: item.verification })),
    stopped: checkpoint.stopped,
    stopReason: checkpoint.stopReason,
    budget: {
      maxWrites: checkpoint.maxWrites,
      writesConsumed: checkpoint.writesConsumed,
      writesRemaining: checkpoint.maxWrites - checkpoint.writesConsumed,
    },
    perSku: checkpoint.items,
    sessionMetrics: options.sessionMetrics || null,
    finalGates: { ...SAFE_ENV },
  };
}

async function buildNewPlan(options, dependencies, runtime, codeVersion, mainVersion) {
  const mode = normalizeMode(options.mode);
  const domains = selectedDomains(options);
  if (domains.length === 0) {
    throw new MutableBatchError(
      "MUTABLE_DOMAIN_REQUIRED",
      "Debe habilitarse al menos un dominio de forma explicita.",
    );
  }
  const maxWrites = normalizeMaxWrites(options.maxWrites, mode);
  const allowlist = prepareAllowlist(options.skus, options.scopeFile);
  const identity = createMutableRunIdentity(options.now || new Date());
  const planSku = dependencies.planSku || defaultPlanSku;
  const items = [];
  for (const allowItem of allowlist.items) {
    const execution = await planSku(allowItem.inputSku, runtime, allowItem);
    items.push(buildPlanItem(allowItem, execution, DOMAIN_ORDER));
  }
  const plan = {
    metadata: {
      runId: identity.runId,
      generatedAt: identity.timestamp,
      mode,
      mainSha: mainVersion,
      codeVersion,
      scopeFile: allowlist.loaded.filePath,
      allowlist: allowlist.items.map((item) => item.normalizedSku),
      domains,
      maxWrites,
      concurrency: 1,
      confirmRealWrites: options.confirmRealWrites === true,
    },
    items,
    actions: items.flatMap((item) =>
      DOMAIN_ORDER.map((domain) => ({
        normalizedSku: item.normalizedSku,
        domain,
        enabled: domains.includes(domain),
        ...item.domains[domain],
      })),
    ),
    expectedWrites: items.reduce(
      (total, item) =>
        total + domains.reduce((sum, domain) => sum + item.domains[domain].expectedWrites, 0),
      0,
    ),
    excludedItems: items.filter(
      (item) => item.classification === "MANUAL_REVIEW" || item.errors.length > 0,
    ).map((item) => ({
      inputSku: item.inputSku,
      normalizedSku: item.normalizedSku,
      classification: item.classification,
      errors: item.errors,
    })),
    stopConditions: [...STOP_CONDITIONS],
  };
  assertPlanPriceSnapshotsComplete(plan);
  const persistPlan = dependencies.persistMutablePlan || persistMutablePlan;
  const planFile = options.persist === false
    ? null
    : persistPlan(plan, options.planOutputDir);
  const checkpointFile = options.checkpointFile || checkpointPath(
    identity.runId,
    options.checkpointOutputDir,
  );
  const checkpointResult = createCheckpoint(plan, checkpointFile);
  return { plan, planFile, ...checkpointResult };
}

function assertResumePriceSnapshotsComplete(plan, checkpoint) {
  assertPlanPriceSnapshotsComplete(plan);
  for (const planItem of plan.items || []) {
    const pricePlan = planItem?.domains?.PRICE;
    if (!pricePlan || pricePlan.expectedWrites <= 0) continue;
    const checkpointItem = findCheckpointItem(
      checkpoint,
      planItem.normalizedSku,
      "PRICE",
    );
    try {
      assertPriceApprovedSnapshotComplete(checkpointItem?.approvedSnapshot);
    } catch (error) {
      throw new MutableCheckpointError(
        "PRICE_APPROVED_SNAPSHOT_INCOMPLETE",
        "El checkpoint PRICE no conserva la precondicion aprobada original.",
        {
          normalizedSku: planItem.normalizedSku,
          cause: error.code || error.message,
        },
      );
    }
    if (
      JSON.stringify(checkpointItem.approvedSnapshot) !==
      JSON.stringify(pricePlan.snapshot)
    ) {
      throw new MutableCheckpointError(
        "PRICE_APPROVED_SNAPSHOT_INCOMPLETE",
        "El snapshot PRICE del checkpoint difiere del plan aprobado.",
        { normalizedSku: planItem.normalizedSku },
      );
    }
  }
}

async function loadResume(options, dependencies, codeVersion) {
  const loaded = loadCheckpoint(options.resume);
  const planFile = options.planFile || planPathForRun(
    loaded.checkpoint.runId,
    options.planOutputDir,
  );
  const plan = loadPlanFile(planFile);
  assertResumePriceSnapshotsComplete(plan, loaded.checkpoint);
  const expected = {
    codeVersion,
    allowlist: options.skus?.length
      ? prepareAllowlist(options.skus, options.scopeFile).items.map((item) => item.normalizedSku)
      : plan.metadata.allowlist,
    domains: selectedDomains(options).length
      ? selectedDomains(options)
      : plan.metadata.domains,
    maxWrites: options.maxWrites === undefined
      ? plan.metadata.maxWrites
      : normalizeMaxWrites(options.maxWrites, "EXECUTE"),
  };
  validateResume(loaded.checkpoint, expected);
  if (loaded.checkpoint.stopped && options.resumeStopped !== true) {
    throw new MutableCheckpointError(
      "MUTABLE_CHECKPOINT_STOPPED",
      "El checkpoint esta detenido; requiere revision explicita antes de reanudar.",
    );
  }
  loaded.checkpoint.stopped = false;
  loaded.checkpoint.stopReason = null;
  saveCheckpoint(loaded.checkpoint, loaded.checkpointFile);
  return { plan, planFile, ...loaded };
}

async function runMutableBatch(options = {}, dependencies = {}) {
  const mode = normalizeMode(options.mode || (options.resume ? "EXECUTE" : "PLAN"));
  const codeVersion = (dependencies.getCodeVersion || currentCodeVersion)();
  const mainVersion = (dependencies.getMainVersion || currentMainVersion)();
  const openRuntime = dependencies.openRuntime || openDefaultRuntime;
  let runtime = null;
  let state;
  let report;

  try {
    runtime = dependencies.runtime || await openRuntime(options, dependencies);
    state = options.resume
      ? await loadResume(options, dependencies, codeVersion)
      : await buildNewPlan(
          { ...options, mode },
          dependencies,
          runtime,
          codeVersion,
          mainVersion,
        );
    const domains = state.plan.metadata.domains;

    if (mode === "PLAN") {
      report = createReport(state.plan, state.checkpoint, {
        mode,
        sessionMetrics: runtime.metrics,
      });
      report.planFile = state.planFile;
      report.checkpointFile = state.checkpointFile;
      report.outputFile = options.persist === false
        ? null
        : (dependencies.persistMutableRun || persistMutableRun)(
            report,
            options.runOutputDir,
          );
      return report;
    }

    assertExecutionAuthorized({
      mode,
      confirmRealWrites: options.confirmRealWrites,
      domains,
      maxWrites: state.checkpoint.maxWrites,
      env: dependencies.env || process.env,
    });

    const executeDomain = dependencies.executeDomain || defaultExecuteDomain;
    for (const planItem of state.plan.items) {
      for (const domain of domains) {
        const checkpointItem = findCheckpointItem(
          state.checkpoint,
          planItem.normalizedSku,
          domain,
        );
        if (["VERIFIED", "SKIPPED"].includes(checkpointItem.state)) continue;
        if (checkpointItem.writesConsumed > 0) {
          const reconcile = dependencies.reconcileResume || defaultReconcileResume;
          const reconciled = await reconcile({
            planItem,
            domain,
            checkpoint: state.checkpoint,
            checkpointItem,
            checkpointFile: state.checkpointFile,
            runtime,
          });
          if (reconciled?.verified) {
            checkpointItem.state = "VERIFIED";
            checkpointItem.verification = reconciled;
            saveCheckpoint(state.checkpoint, state.checkpointFile);
            continue;
          }
          if (reconciled?.continueExecution) {
            planItem.domains[domain].snapshot = reconciled.refreshedSnapshot;
            checkpointItem.state = "PLANNED";
            checkpointItem.substate = "RESUME_REVALIDATED_PENDING_WRITES";
            checkpointItem.prevalidation = {
              status: "PASSED",
              resumed: true,
            };
            saveCheckpoint(state.checkpoint, state.checkpointFile);
          } else {
            throw new MutableBatchError(
              "RESUME_INCONSISTENT_EXTERNAL_STATE",
              "El estado externo no coincide con el checkpoint.",
              { key: checkpointItem.key },
            );
          }
        }
        if (planItem.domains[domain].blocked) {
          throw new MutableBatchError(
            "DOMAIN_PLAN_BLOCKED",
            `El dominio ${domain} esta bloqueado para ${planItem.inputSku}.`,
            { reasons: planItem.domains[domain].blockedReasons },
          );
        }
        if (planItem.domains[domain].expectedWrites === 0) {
          checkpointItem.state = "SKIPPED";
          checkpointItem.substate = "ALREADY_CURRENT_OR_NOT_APPLICABLE";
          checkpointItem.verification = { verified: true, noWriteRequired: true };
          saveCheckpoint(state.checkpoint, state.checkpointFile);
          continue;
        }

        const controller = new MutableWriteController({
          checkpoint: state.checkpoint,
          checkpointItem,
          checkpointFile: state.checkpointFile,
          saveCheckpoint,
        });
        const execution = await executeDomain({
          planItem,
          domain,
          runtime,
          controller,
          checkpointItem,
        });
        const actions = relevantActions(execution, domain);
        const failure = executionFailure(actions);
        const unresolved = actions.find(
          (action) => actionNeedsWrite(domain, action) && action.executionResult === "SIMULATED",
        );
        if (failure || unresolved || actions.length === 0) {
          const failureCode = failure?.errors?.[0]?.code;
          const error = new MutableBatchError(
            failureCode === "PRICE_PREWRITE_STATE_CHANGED"
              ? "PRECONDITION_CHANGED"
              : failureCode || "WRITE_VERIFICATION_FAILED",
            failure?.errors?.[0]?.message || "El dominio no termino completamente verificado.",
            { domain, action: failure?.plannedAction || unresolved?.plannedAction || null },
          );
          stopCheckpoint(state.checkpoint, state.checkpointFile, error, checkpointItem);
          break;
        }
        controller.verify(executionPostState(actions));
      }
      if (state.checkpoint.stopped) break;
    }
  } catch (error) {
    if (state?.checkpoint && state?.checkpointFile && !state.checkpoint.stopped) {
      stopCheckpoint(state.checkpoint, state.checkpointFile, error);
    }
    if (!state) throw error;
  } finally {
    if (runtime?.close) await runtime.close();
  }

  report = createReport(state.plan, state.checkpoint, {
    mode,
    sessionMetrics: runtime?.metrics,
  });
  report.planFile = state.planFile;
  report.checkpointFile = state.checkpointFile;
  report.outputFile = options.persist === false
    ? null
    : (dependencies.persistMutableRun || persistMutableRun)(report, options.runOutputDir);
  return report;
}

module.exports = {
  ACTION_TYPES,
  MutableBatchError,
  SAFE_ENV,
  assertExecutionAuthorized,
  createReport,
  defaultExecuteDomain,
  defaultPlanSku,
  defaultReconcileResume,
  envForDomain,
  normalizeMaxWrites,
  normalizeMode,
  openDefaultRuntime,
  runMutableBatch,
};
