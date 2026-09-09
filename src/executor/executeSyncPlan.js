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
} = require("./executionPlan");
const {
  createExecutionIdentity,
  persistExecution,
} = require("./executionLog");
const { revalidateSyncPlan } = require("./revalidate");

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
    warnings: [
      {
        code: "EXECUTION_NOT_IMPLEMENTED",
        message: "El executor esta en simulacion y no dispone de operaciones de escritura.",
        writeModeRequested: gates.writeModeRequested,
      },
    ],
    errors: [],
    dryRun: gates.dryRun,
    effectiveDryRun: gates.effectiveDryRun,
    executionEnabled: gates.executionEnabled,
    writeOperationsAvailable: false,
  };
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
  console.log(`- effectiveDryRun: ${execution.effectiveDryRun}`);
  console.log(`- writeOperationsAvailable: ${execution.writeOperationsAvailable}`);
  console.log(`- revalidation: ${execution.revalidation?.status || "NO_EJECUTADA"}`);

  console.log("\nAcciones simuladas:");
  for (const action of execution.executionPlan?.actions || []) {
    const ids = action.productId
      ? ` | productId ${action.productId} | variantId ${action.variantId}`
      : "";
    console.log(
      `- ${action.type}${ids} | ${action.plannedAction} | ${action.simulationResult}`,
    );
  }

  console.log("\nResumen:");
  for (const [key, value] of Object.entries(execution.result || {})) {
    console.log(`- ${key}: ${value}`);
  }
  console.log(`- warnings: ${execution.warnings.length}`);
  console.log(`- errors: ${execution.errors.length}`);
  if (execution.outputFile) console.log(`\nEjecucion guardada en: ${execution.outputFile}`);
  console.log("NO SE REALIZARON ESCRITURAS.");
}

async function main() {
  const sourceSku = process.argv[2] || "";
  console.log("=== EXECUTOR SIMULATION MODE - NO WRITES AVAILABLE ===");
  const execution = await executeSyncPlan(sourceSku);
  printExecution(execution);
  process.exitCode = ["BLOCKED", "FAILED"].includes(execution.result.executionStatus)
    ? 1
    : 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error fatal del executor: ${error.message}`);
    console.error("NO SE REALIZARON ESCRITURAS.");
    process.exitCode = 1;
  });
}

module.exports = {
  executeSyncPlan,
  main,
  printExecution,
};
