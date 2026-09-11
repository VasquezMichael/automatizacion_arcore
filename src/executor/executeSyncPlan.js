const { syncProduct } = require("../sync/syncProduct");
const { createTiendanubeReadOnlyClient } = require("../tiendanube/readOnlyClient");
const { normalizeSku } = require("../tiendanube/sku");
const {
  readExecutionGates,
  flattenDomainBlocks,
  mergeDomainBlocks,
  validateExecutionPlan,
} = require("./executionGuards");
const {
  buildBlockedExecutionPlan,
  buildExecutionPlan,
  summarizeActions,
  summarizeLegacyExecution,
} = require("./executionPlan");
const {
  createExecutionIdentity,
  persistExecution,
} = require("./executionLog");
const { revalidateSyncPlan } = require("./revalidate");
const {
  executeSinglePriceUpdate,
  isEligibleSinglePriceUpdate,
} = require("./singlePriceExecution");
const {
  executeSingleStatusUpdate,
  isEligibleSingleStatusUpdate,
} = require("./singleStatusExecution");
const {
  executeLegacyPriceUpdates,
  validateLegacyPriceExecution,
} = require("./legacyPriceExecution");
const {
  executeLegacyStatusUpdates,
  validateLegacyStatusExecution,
} = require("./legacyStatusExecution");
const { createTiendanubePriceAdapter } = require("./tiendanubePriceAdapter");
const { createTiendanubeStatusAdapter } = require("./tiendanubeStatusAdapter");

function serializeError(error) {
  return {
    code: error.code || "EXECUTOR_ERROR",
    message: error.message,
    status: error.response?.status || error.status || null,
  };
}

function baseExecution(sourceSku, gates, identity) {
  return {
    executionId: identity.executionId,
    timestamp: identity.timestamp,
    sourceSku,
    normalizedSku: normalizeSku(sourceSku),
    matchedCode: null,
    supplierResolution: null,
    classification: null,
    originalPlan: null,
    revalidation: null,
    executionPlan: null,
    result: null,
    warnings: [],
    errors: [],
    dryRun: gates.dryRun,
    effectiveDryRun: gates.effectiveDryRun,
    executionEnabled: gates.executionEnabled,
    priceExecutionEnabled: gates.priceExecutionEnabled,
    statusExecutionEnabled: gates.statusExecutionEnabled,
    globalWriteRequested: gates.globalWriteRequested,
    priceWriteRequested: gates.priceWriteRequested,
    statusWriteRequested: gates.statusWriteRequested,
    writeModeRequested: gates.writeModeRequested,
    writeOperationsAvailable: false,
    writeOperationsAvailableByDomain: {
      price: false,
      status: false,
      image: false,
      create: false,
    },
  };
}

function annotateExecutionResults(actions) {
  for (const action of actions || []) {
    if (action.executionResult) continue;
    if (["BLOCKED", "NOT_EXECUTABLE", "REVALIDATION_FAILED"].includes(action.simulationResult)) {
      action.executionResult = "BLOCKED";
    } else if (action.simulationResult === "SKIPPED_ALREADY_APPLIED") {
      action.executionResult = "SKIPPED_ALREADY_APPLIED";
    } else {
      action.executionResult = "SIMULATED";
    }
  }
}

function updateFinalVerify(actions, executionStatus) {
  const finalVerify = actions.find((action) => action.type === "FINAL_VERIFY");
  if (!finalVerify) return;

  if (executionStatus === "SUCCESS") {
    finalVerify.simulationResult = "PASSED";
    finalVerify.executionResult = "WRITE_SUCCEEDED";
  } else if (executionStatus === "NO_CHANGES") {
    finalVerify.simulationResult = "PASSED";
    finalVerify.executionResult = "SKIPPED_ALREADY_APPLIED";
  } else if (executionStatus === "PARTIAL_FAILURE") {
    finalVerify.simulationResult = "FAILED";
    finalVerify.executionResult = "WRITE_VERIFICATION_FAILED";
  } else if (executionStatus === "BLOCKED") {
    finalVerify.simulationResult = "BLOCKED";
    finalVerify.executionResult = "BLOCKED";
  }
}

function actionHasError(action, code) {
  return (action?.errors || []).some((error) => error.code === code);
}

function statusHasCriticalIdentityFailure(action) {
  return (
    actionHasError(action, "STATUS_PREWRITE_READ_FAILED") ||
    actionHasError(action, "STATUS_PREWRITE_IDENTITY_MISMATCH") ||
    (actionHasError(action, "STATUS_WRITE_VERIFICATION_FAILED") &&
      action.errors.some((error) => error.details?.identity))
  );
}

function blockActionAfterCriticalIdentity(action, sourceAction) {
  if (!action || action.executionResult === "BLOCKED") return;
  const error = {
    code: "CRITICAL_IDENTITY_FAILED",
    message: "La ejecucion se detuvo por una inconsistencia critica de identidad.",
    details: {
      sourceDomain: sourceAction.type,
      sourceErrors: (sourceAction.errors || []).map((item) => item.code),
    },
  };
  action.simulationResult = "BLOCKED";
  action.executionResult = "BLOCKED";
  action.errors = action.errors || [];
  action.errors.push(error);
}

async function executeSingleWrites(execution, gates, dependencies, actions) {
  const statusAction = actions.find((action) => action.type === "STATUS");
  const priceAction = actions.find((action) => action.type === "PRICE");
  const statusWriteAvailable = isEligibleSingleStatusUpdate(
    execution.originalPlan,
    execution.revalidation,
    statusAction,
  );
  const priceWriteAvailable = isEligibleSinglePriceUpdate(
    execution.originalPlan,
    execution.revalidation,
    priceAction,
  );
  const statusExecutionAvailable = gates.statusWriteRequested && statusWriteAvailable;
  const priceExecutionAvailable = gates.priceWriteRequested && priceWriteAvailable;
  execution.writeOperationsAvailableByDomain.status = statusExecutionAvailable;
  execution.writeOperationsAvailableByDomain.price = priceExecutionAvailable;
  execution.writeOperationsAvailable = statusExecutionAvailable || priceExecutionAvailable;
  let criticalIdentityFailure = false;

  if (statusExecutionAvailable) {
    const statusAdapter =
      dependencies.statusAdapter || createTiendanubeStatusAdapter();
    await executeSingleStatusUpdate({
      plan: execution.originalPlan,
      revalidation: execution.revalidation,
      action: statusAction,
      adapter: statusAdapter,
    });
    execution.errors.push(...(statusAction.errors || []));
    criticalIdentityFailure = statusHasCriticalIdentityFailure(statusAction);
  }

  if (priceExecutionAvailable && !criticalIdentityFailure) {
    const priceAdapter = dependencies.priceAdapter || createTiendanubePriceAdapter();
    await executeSinglePriceUpdate({
      plan: execution.originalPlan,
      revalidation: execution.revalidation,
      action: priceAction,
      adapter: priceAdapter,
    });
    execution.errors.push(...(priceAction.errors || []));
  } else if (priceExecutionAvailable && criticalIdentityFailure) {
    blockActionAfterCriticalIdentity(priceAction, statusAction);
    execution.errors.push(...(priceAction.errors || []));
  }

  execution.result = summarizeActions(
    actions,
    criticalIdentityFailure,
    { executionMode: true },
  );
  updateFinalVerify(actions, execution.result.executionStatus);
}

const GLOBAL_LEGACY_ISSUES = new Set([
  "LEGACY_CLASSIFICATION_REQUIRED",
  "LEGACY_SUPPLIER_RESOLUTION_BLOCKED",
  "LEGACY_GROUP_INVALID",
  "LEGACY_GROUP_NORMALIZED_SKU_MISMATCH",
  "LEGACY_EXPECTED_MATCHES_INVALID",
  "LEGACY_GROUP_COUNT_MISMATCH",
  "LEGACY_GROUP_PAIR_MISMATCH",
  "LEGACY_GROUP_SKU_MISMATCH",
  "LEGACY_STATUS_CLASSIFICATION_INVALID",
  "LEGACY_STATUS_SUPPLIER_RESOLUTION_INVALID",
  "LEGACY_STATUS_REVALIDATION_FAILED",
  "LEGACY_STATUS_NORMALIZED_SKU_MISMATCH",
  "LEGACY_STATUS_EXPECTED_MATCHES_INVALID",
  "LEGACY_STATUS_COUNT_MISMATCH",
  "LEGACY_STATUS_PAIR_MISMATCH",
  "LEGACY_STATUS_PUBLICATION_SKU_MISMATCH",
]);

function uniqueIssues(issues) {
  const seen = new Set();
  return issues.filter((item) => {
    const key = `${item.code}:${JSON.stringify(item.details || null)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function blockLegacyActions(domainActions, issues) {
  for (const action of domainActions) {
    action.simulationResult = "BLOCKED";
    action.executionResult = "BLOCKED";
    action.errors = action.errors || [];
    action.errors.push(...issues);
  }
}

async function executeLegacyWrites(execution, gates, dependencies, actions) {
  const statusValidation = validateLegacyStatusExecution(
    execution.originalPlan,
    execution.revalidation,
    actions,
  );
  const priceValidation = validateLegacyPriceExecution(
    execution.originalPlan,
    execution.revalidation,
    actions,
  );
  const globalIssues = uniqueIssues(
    [...statusValidation.issues, ...priceValidation.issues].filter((item) =>
      GLOBAL_LEGACY_ISSUES.has(item.code),
    ),
  );

  if (globalIssues.length > 0) {
    blockLegacyActions(statusValidation.statusActions, globalIssues);
    blockLegacyActions(priceValidation.priceActions, globalIssues);
    execution.errors.push(...globalIssues);
    execution.result = summarizeLegacyExecution(actions, {
      globalIntegrityFailed: true,
    });
    updateFinalVerify(actions, execution.result.executionStatus);
    return;
  }

  const localStatusIssues = statusValidation.issues.filter(
    (item) => !GLOBAL_LEGACY_ISSUES.has(item.code),
  );
  const localPriceIssues = priceValidation.issues.filter(
    (item) => !GLOBAL_LEGACY_ISSUES.has(item.code),
  );
  if (localStatusIssues.length > 0) {
    blockLegacyActions(statusValidation.statusActions, localStatusIssues);
    execution.errors.push(...localStatusIssues);
  }
  if (localPriceIssues.length > 0) {
    blockLegacyActions(priceValidation.priceActions, localPriceIssues);
    execution.errors.push(...localPriceIssues);
  }

  const statusWriteAvailable =
    localStatusIssues.length === 0 &&
    statusValidation.statusActions.some((action) =>
      ["PUBLISH", "UNPUBLISH"].includes(action.plannedAction),
    );
  const priceWriteAvailable =
    localPriceIssues.length === 0 &&
    priceValidation.priceActions.some(
      (action) => action.plannedAction === "PRICE_UPDATE",
    );
  const statusExecutionAvailable =
    gates.statusWriteRequested && statusWriteAvailable;
  const priceExecutionAvailable =
    gates.priceWriteRequested && priceWriteAvailable;
  execution.writeOperationsAvailableByDomain.status = statusExecutionAvailable;
  execution.writeOperationsAvailableByDomain.price = priceExecutionAvailable;
  execution.writeOperationsAvailable =
    statusExecutionAvailable || priceExecutionAvailable;

  let statusResult = { issues: [], groupIntegrityFailed: false };
  if (gates.statusWriteRequested && localStatusIssues.length === 0) {
    const statusAdapter =
      dependencies.statusAdapter || createTiendanubeStatusAdapter();
    statusResult = await executeLegacyStatusUpdates({
      plan: execution.originalPlan,
      actions: statusValidation.statusActions,
      adapter: statusAdapter,
    });
    execution.errors.push(
      ...statusValidation.statusActions.flatMap((action) => action.errors || []),
      ...statusResult.issues,
    );
  }

  let priceResult = { issues: [], groupIntegrityFailed: false };
  if (statusResult.groupIntegrityFailed && gates.priceWriteRequested) {
    const integrityIssue = {
      code: "GROUP_INTEGRITY_FAILED",
      message: "PRICE no se ejecuta porque STATUS detecto una inconsistencia critica del grupo.",
    };
    blockLegacyActions(priceValidation.priceActions, [integrityIssue]);
    execution.errors.push(integrityIssue);
  } else if (gates.priceWriteRequested && localPriceIssues.length === 0) {
    const priceAdapter = dependencies.priceAdapter || createTiendanubePriceAdapter();
    priceResult = await executeLegacyPriceUpdates({
      plan: execution.originalPlan,
      actions: priceValidation.priceActions,
      adapter: priceAdapter,
    });
    execution.errors.push(
      ...priceValidation.priceActions.flatMap((action) => action.errors || []),
      ...priceResult.issues,
    );
  }

  execution.result = summarizeLegacyExecution(actions, {
    globalIntegrityFailed:
      statusResult.groupIntegrityFailed || priceResult.groupIntegrityFailed,
    statusIntegrityFailed: statusResult.groupIntegrityFailed,
    priceIntegrityFailed: priceResult.groupIntegrityFailed,
  });
  updateFinalVerify(actions, execution.result.executionStatus);
}

async function executeSupportedWrites(execution, gates, dependencies) {
  const actions = execution.executionPlan?.actions || [];
  annotateExecutionResults(actions);

  if (execution.originalPlan?.classification === "LEGACY_GROUP") {
    if (
      (!gates.priceWriteRequested && !gates.statusWriteRequested) ||
      execution.revalidation?.ok !== true
    ) {
      execution.result = summarizeLegacyExecution(actions, { simulated: true });
      return;
    }
    await executeLegacyWrites(execution, gates, dependencies, actions);
    return;
  }

  if (
    (!gates.priceWriteRequested && !gates.statusWriteRequested) ||
    execution.revalidation?.ok !== true
  ) return;
  if (execution.originalPlan?.classification === "SINGLE") {
    await executeSingleWrites(execution, gates, dependencies, actions);
  }
}

function notRunRevalidation(reason) {
  return {
    checkedAt: null,
    ok: false,
    status: "NOT_RUN",
    matches: [],
    issues: [{ code: "GUARDS_BLOCKED", message: reason }],
  };
}

async function executeSyncPlan(sourceSku, dependencies = {}) {
  const gates = readExecutionGates(dependencies.env || process.env);
  const identity = createExecutionIdentity(sourceSku, dependencies.now || new Date());
  const execution = baseExecution(sourceSku, gates, identity);
  const shouldPersist = dependencies.persist !== false;

  try {
    const orchestrate = dependencies.syncProduct || syncProduct;
    const orchestratorDependencies = dependencies.client
      ? { client: dependencies.client }
      : undefined;
    const originalPlan = await orchestrate(sourceSku, orchestratorDependencies);
    execution.originalPlan = originalPlan;
    execution.normalizedSku = originalPlan.normalizedSku || execution.normalizedSku;
    execution.matchedCode = originalPlan.matchedCode || null;
    execution.supplierResolution = originalPlan.supplierResolution || null;
    execution.classification = originalPlan.classification || null;
    execution.warnings.push(...(originalPlan.warnings || []));

    const guards = validateExecutionPlan(originalPlan);
    if (!guards.ok) {
      execution.errors.push(...guards.issues);
      execution.revalidation = notRunRevalidation(
        "El plan no supero los gates previos a la revalidacion.",
      );
      const blocked = buildBlockedExecutionPlan(originalPlan, guards.issues);
      execution.executionPlan = blocked.executionPlan;
      execution.result = blocked.summary;
    } else {
      const client = dependencies.client || createTiendanubeReadOnlyClient();
      const revalidate = dependencies.revalidateSyncPlan || revalidateSyncPlan;
      const revalidation = await revalidate(originalPlan, {
        client,
        ...(dependencies.revalidationDependencies || {}),
      });
      execution.revalidation = revalidation;

      if (!revalidation.ok) {
        execution.errors.push(...(revalidation.issues || []));
        const blocked = buildBlockedExecutionPlan(
          originalPlan,
          revalidation.issues || [],
        );
        blocked.executionPlan.actions[0].simulationResult = "REVALIDATION_FAILED";
        execution.executionPlan = blocked.executionPlan;
        execution.result = blocked.summary;
      } else {
        const domainBlocks = mergeDomainBlocks(
          guards.domainBlocks,
          revalidation.domainBlocks,
        );
        const simulation = buildExecutionPlan(originalPlan, revalidation, {
          domainBlocks,
        });
        execution.executionPlan = simulation.executionPlan;
        execution.result = simulation.summary;
        execution.warnings.push(...flattenDomainBlocks(domainBlocks));
        if (simulation.issues.length > 0) {
          execution.revalidation = {
            ...revalidation,
            ok: false,
            status: "FAILED",
            issues: [...(revalidation.issues || []), ...simulation.issues],
          };
          execution.errors.push(...simulation.issues);
        }
        await executeSupportedWrites(execution, gates, dependencies);
      }
    }
  } catch (error) {
    execution.errors.push(serializeError(error));
    execution.revalidation = execution.revalidation || {
      checkedAt: null,
      ok: false,
      status: "FAILED",
      matches: [],
      issues: [serializeError(error)],
    };
    const failed = buildBlockedExecutionPlan(execution.originalPlan, execution.errors);
    execution.executionPlan = failed.executionPlan;
    execution.result = {
      ...failed.summary,
      executionStatus: "FAILED",
      failedActions: Math.max(failed.summary.failedActions, 1),
    };
  }

  annotateExecutionResults(execution.executionPlan?.actions);

  if (shouldPersist) {
    const persist = dependencies.persistExecution || persistExecution;
    execution.outputFile = persist(execution, dependencies.outputDir);
  }
  return execution;
}

function printExecution(execution) {
  console.log("\nResultado del executor:");
  console.log(`- executionId: ${execution.executionId}`);
  console.log(`- sourceSku: ${execution.sourceSku}`);
  console.log(`- normalizedSku: ${execution.normalizedSku}`);
  console.log(`- matchedCode: ${execution.matchedCode || "NO_ENCONTRADO"}`);
  console.log(
    `- supplierResolution: ${execution.supplierResolution?.type || "NO_ENCONTRADA"}`,
  );
  console.log(`- classification: ${execution.classification || "NO_CLASIFICADO"}`);
  console.log(`- dryRun configurado: ${execution.dryRun}`);
  console.log(`- executionEnabled configurado: ${execution.executionEnabled}`);
  console.log(`- priceExecutionEnabled configurado: ${execution.priceExecutionEnabled}`);
  console.log(`- statusExecutionEnabled configurado: ${execution.statusExecutionEnabled}`);
  console.log(`- globalWriteRequested: ${execution.globalWriteRequested}`);
  console.log(`- priceWriteRequested: ${execution.priceWriteRequested}`);
  console.log(`- statusWriteRequested: ${execution.statusWriteRequested}`);
  console.log(`- effectiveDryRun: ${execution.effectiveDryRun}`);
  console.log(`- writeOperationsAvailable: ${execution.writeOperationsAvailable}`);
  console.log(
    `- writeOperationsAvailableByDomain: ${JSON.stringify(execution.writeOperationsAvailableByDomain)}`,
  );
  console.log(`- revalidation: ${execution.revalidation?.status || "NO_EJECUTADA"}`);

  console.log("\nAcciones:");
  for (const action of execution.executionPlan?.actions || []) {
    const ids = action.productId
      ? ` | productId ${action.productId} | variantId ${action.variantId}`
      : "";
    console.log(
      `- ${action.type}${ids} | ${action.plannedAction} | ${action.executionResult || action.simulationResult}`,
    );
  }

  console.log("\nResumen:");
  for (const [key, value] of Object.entries(execution.result || {})) {
    if (value && typeof value === "object") {
      console.log(`- ${key}:`);
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        console.log(`  - ${nestedKey}: ${nestedValue}`);
      }
    } else {
      console.log(`- ${key}: ${value}`);
    }
  }
  console.log(`- warnings: ${execution.warnings.length}`);
  console.log(`- errors: ${execution.errors.length}`);
  if (execution.outputFile) console.log(`\nEjecucion guardada en: ${execution.outputFile}`);
  if (execution.result?.writeAttempted) {
    console.log(
      execution.result.writeSucceeded
        ? "Se intento al menos una escritura y todos los PUT intentados respondieron exitosamente."
        : "Se intento al menos una escritura y al menos un PUT fallo.",
    );
    console.log(
      execution.result.verified
        ? "La escritura fue verificada por GET posterior."
        : "La escritura no quedo completamente verificada.",
    );
  } else {
    console.log("NO SE REALIZARON ESCRITURAS.");
  }
}

async function main() {
  const sourceSku = process.argv[2] || "";
  console.log("=== EXECUTOR CONTROLADO ===");
  const execution = await executeSyncPlan(sourceSku);
  printExecution(execution);
  process.exitCode = ["BLOCKED", "FAILED", "PARTIAL_FAILURE"].includes(execution.result.executionStatus)
    ? 1
    : 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error fatal del executor: ${error.message}`);
    console.error("No fue posible determinar un resultado final trazable.");
    process.exitCode = 1;
  });
}

module.exports = {
  executeSyncPlan,
  main,
  printExecution,
};
