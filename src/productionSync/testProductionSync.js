const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  acquireProductionSyncLock,
  ProductionSyncLockError,
} = require("./productionSyncLock");
const {
  buildSafeProductionPlan,
  readBatchConfig,
} = require("./productionSyncPlanner");
const {
  containsSensitiveKeys,
  persistProductionSyncReport,
} = require("./productionSyncReport");
const {
  assertProductionExecutionAuthorized,
  runProductionSync,
} = require("./productionSyncRunner");

const SAFE_ENV = {
  TIENDANUBE_DRY_RUN: "true",
  TIENDANUBE_EXECUTION_ENABLED: "false",
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "false",
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "false",
  TIENDANUBE_IMAGE_EXECUTION_ENABLED: "false",
  TIENDANUBE_CREATE_EXECUTION_ENABLED: "false",
};

function makeItem(overrides = {}) {
  const index = overrides.index || 1;
  const classification = overrides.classification || "SINGLE";
  const normalizedSku = overrides.normalizedSku || `SKU${String(index).padStart(3, "0")}`;
  const priceAction = overrides.priceAction || "PRICE_NO_CHANGE";
  const statusAction = overrides.statusAction || "STATUS_NO_CHANGE";
  const imageAction = overrides.imageAction || "IMAGE_NO_CHANGE";
  const publications = (action) => [{
    productId: 1000 + index,
    variantId: 2000 + index,
    action,
  }];
  return {
    inputSku: overrides.inputSku || `SKU ${index}`,
    normalizedSku,
    supplierResolution: { type: overrides.resolution || "EXACT" },
    classification,
    availability: overrides.availability || "AVAILABLE",
    supplier: {
      imageSourceType: overrides.imageSourceType === undefined
        ? "COVER_FULL"
        : overrides.imageSourceType,
    },
    tiendanube: {
      matchCount: classification === "CREATE_SINGLE" ? 0 : 1,
      legacyGroup: classification === "LEGACY_GROUP"
        ? { valid: overrides.legacyValid !== false, expectedMatches: 1, actualMatches: 1 }
        : null,
    },
    status: overrides.status || "SUCCEEDED",
    requiresManualReview: classification === "MANUAL_REVIEW",
    result: {
      revalidationStatus: overrides.revalidation || "PASSED",
      writeAttempted: false,
    },
    plans: {
      price: { action: priceAction, publications: publications(priceAction) },
      status: { action: statusAction, publications: publications(statusAction) },
      image: { action: imageAction, publications: publications(imageAction) },
      create: classification === "CREATE_SINGLE"
        ? {
            plannedAction: "CREATE_SINGLE",
            simulationResult: overrides.createResult || "WOULD_CREATE",
          }
        : null,
    },
    warnings: overrides.warnings || [],
    errors: overrides.errors || [],
  };
}

function analysis(items) {
  return {
    metadata: { sourceMetrics: { contextsOpened: 1 } },
    items,
  };
}

function tempRoot(prefix = "production-sync-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeLoaded(items) {
  return {
    filePath: path.join(tempRoot(), "scope.json"),
    scope: { items: items.map((item) => ({ sourceSku: item.inputSku })) },
  };
}

function completedSubBatch(subBatch, overrides = {}) {
  return {
    phase: "PLAN",
    runId: `mutable-${subBatch.id}`,
    planExpectedWrites: subBatch.expectedWrites,
    budgetMaxWrites: subBatch.expectedWrites,
    consumedWrites: 0,
    remainingWrites: subBatch.expectedWrites,
    writeAttempted: 0,
    stopped: false,
    stopReason: null,
    sessionMetrics: null,
    ...overrides,
  };
}

function runnerFixture(items, overrides = {}) {
  const root = tempRoot();
  const loaded = fakeLoaded(items);
  return {
    options: {
      mode: "PLAN",
      persist: false,
      lockFile: path.join(root, "sync.lock"),
      ...overrides.options,
    },
    dependencies: {
      env: SAFE_ENV,
      loadScope: () => loaded,
      runHealthCheck: async () => ({ status: "PASSED" }),
      runFreshAnalysis: async () => analysis(items),
      runSubBatch: async (subBatch) => completedSubBatch(subBatch),
      ...overrides.dependencies,
    },
    root,
  };
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test("1. default PLAN", async () => {
  const fixture = runnerFixture([makeItem()]);
  delete fixture.options.mode;
  const report = await runProductionSync(fixture.options, fixture.dependencies);
  assert.equal(report.mode, "PLAN");
  assert.equal(report.executedWrites, 0);
});

test("2. lock normal", () => {
  const filePath = path.join(tempRoot(), "sync.lock");
  const acquired = acquireProductionSyncLock({ filePath, runId: "normal" });
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(acquired.release(), true);
});

test("3. lock concurrente rechazado", () => {
  const filePath = path.join(tempRoot(), "sync.lock");
  const acquired = acquireProductionSyncLock({ filePath, runId: "first" });
  assert.throws(
    () => acquireProductionSyncLock({ filePath, runId: "second" }),
    (error) => error instanceof ProductionSyncLockError && error.code === "SYNC_ALREADY_RUNNING",
  );
  acquired.release();
});

test("4. stale lock controlado", () => {
  const filePath = path.join(tempRoot(), "sync.lock");
  fs.writeFileSync(filePath, JSON.stringify({
    runId: "stale",
    token: "old",
    pid: 999999,
    hostname: os.hostname(),
    acquiredAt: "2000-01-01T00:00:00.000Z",
  }));
  const acquired = acquireProductionSyncLock({
    filePath,
    runId: "replacement",
    staleMinutes: 1,
  });
  assert.equal(acquired.lock.runId, "replacement");
  acquired.release();
});

test("4b. lock activo no se elimina aunque supere stale threshold", () => {
  const filePath = path.join(tempRoot(), "sync.lock");
  const acquired = acquireProductionSyncLock({
    filePath,
    runId: "active",
    now: new Date("2000-01-01T00:00:00.000Z"),
    pid: process.pid,
  });
  assert.throws(
    () => acquireProductionSyncLock({
      filePath,
      runId: "replacement",
      now: new Date("2026-01-01T00:00:00.000Z"),
      staleMinutes: 1,
    }),
    (error) => error.code === "SYNC_ALREADY_RUNNING",
  );
  acquired.release();
});

test("5. release lock tras exito", async () => {
  const fixture = runnerFixture([makeItem()]);
  await runProductionSync(fixture.options, fixture.dependencies);
  assert.equal(fs.existsSync(fixture.options.lockFile), false);
});

test("6. release lock tras error", async () => {
  const fixture = runnerFixture([makeItem()], {
    dependencies: { runFreshAnalysis: async () => { throw new Error("analysis failed"); } },
  });
  const report = await runProductionSync(fixture.options, fixture.dependencies);
  assert.equal(report.stopped, true);
  assert.equal(fs.existsSync(fixture.options.lockFile), false);
});

test("7. NOT_FOUND excluido", () => {
  const plan = buildSafeProductionPlan(analysis([
    makeItem({ resolution: "NOT_FOUND", classification: null }),
  ]), { env: SAFE_ENV });
  assert.equal(plan.exclusions.notFound.length, 1);
  assert.equal(plan.subBatches.length, 0);
});

test("8. MANUAL_REVIEW excluido", () => {
  const plan = buildSafeProductionPlan(analysis([
    makeItem({ classification: "MANUAL_REVIEW", resolution: "AMBIGUOUS" }),
  ]), { env: SAFE_ENV });
  assert.equal(plan.exclusions.manualReview.length, 1);
});

test("9. UNKNOWN excluido", () => {
  const plan = buildSafeProductionPlan(analysis([
    makeItem({ availability: "UNKNOWN", priceAction: "PRICE_UPDATE" }),
  ]), { env: SAFE_ENV });
  assert.equal(plan.exclusions.unknown.length, 1);
  assert.equal(plan.plannedWrites, 0);
});

test("10. AUTO_SINGLE incluido", () => {
  const plan = buildSafeProductionPlan(analysis([
    makeItem({ priceAction: "PRICE_UPDATE" }),
  ]), { env: SAFE_ENV });
  assert.equal(plan.safeItems[0].automationClass, "AUTO_SINGLE");
  assert.equal(plan.autoExecutable, 1);
});

test("11. AUTO_CREATE incluido", () => {
  const plan = buildSafeProductionPlan(analysis([
    makeItem({ classification: "CREATE_SINGLE" }),
  ]), { env: SAFE_ENV });
  assert.equal(plan.safeItems[0].automationClass, "AUTO_CREATE");
  assert.equal(plan.plannedWrites, 1);
});

test("12. AUTO_LEGACY valido incluido", () => {
  const plan = buildSafeProductionPlan(analysis([
    makeItem({ classification: "LEGACY_GROUP", statusAction: "UNPUBLISH" }),
  ]), { env: SAFE_ENV });
  assert.equal(plan.safeItems[0].automationClass, "AUTO_LEGACY");
  assert.equal(plan.plannedWrites, 1);
});

test("13. legacy invalido excluido", () => {
  const plan = buildSafeProductionPlan(analysis([
    makeItem({ classification: "LEGACY_GROUP", legacyValid: false }),
  ]), { env: SAFE_ENV });
  assert.equal(plan.exclusions.manualReview.length, 1);
});

test("14. batching SINGLE maximo 15", () => {
  const items = Array.from({ length: 31 }, (_, index) =>
    makeItem({ index: index + 1, priceAction: "PRICE_UPDATE" }),
  );
  const plan = buildSafeProductionPlan(analysis(items), { env: SAFE_ENV });
  const batches = plan.subBatches.filter((item) => item.domain === "PRICE");
  assert.deepEqual(batches.map((item) => item.skus.length), [15, 15, 1]);
});

test("15. batching CREATE maximo 10", () => {
  const items = Array.from({ length: 11 }, (_, index) =>
    makeItem({ index: index + 1, classification: "CREATE_SINGLE" }),
  );
  const plan = buildSafeProductionPlan(analysis(items), { env: SAFE_ENV });
  assert.deepEqual(plan.subBatches.map((item) => item.skus.length), [10, 1]);
});

test("16. batching IMAGE maximo 8", () => {
  const items = Array.from({ length: 9 }, (_, index) =>
    makeItem({ index: index + 1, imageAction: "IMAGE_REPLACE" }),
  );
  const plan = buildSafeProductionPlan(analysis(items), { env: SAFE_ENV });
  assert.deepEqual(plan.subBatches.map((item) => item.skus.length), [8, 1]);
});

test("17. LEGACY aislado por normalized SKU", () => {
  const plan = buildSafeProductionPlan(analysis([
    makeItem({ index: 1, classification: "LEGACY_GROUP", priceAction: "PRICE_UPDATE" }),
    makeItem({ index: 2, classification: "LEGACY_GROUP", priceAction: "PRICE_UPDATE" }),
  ]), { env: SAFE_ENV });
  assert.equal(plan.subBatches.length, 2);
  assert.ok(plan.subBatches.every((item) => item.kind === "LEGACY" && item.skus.length === 1));
});

test("18. budget exacto por operacion mutable", () => {
  const plan = buildSafeProductionPlan(analysis([
    makeItem({ index: 1, priceAction: "PRICE_UPDATE" }),
    makeItem({ index: 2, imageAction: "IMAGE_REPLACE" }),
  ]), { env: SAFE_ENV });
  assert.equal(plan.plannedWrites, 3);
  assert.deepEqual(plan.subBatches.map((item) => item.expectedWrites), [1, 2]);
});

test("19. budget mismatch produce STOP", async () => {
  const item = makeItem({ priceAction: "PRICE_UPDATE" });
  const fixture = runnerFixture([item], {
    dependencies: {
      runSubBatch: async (subBatch) => completedSubBatch(subBatch, {
        budgetMaxWrites: subBatch.expectedWrites + 1,
      }),
    },
  });
  const report = await runProductionSync(fixture.options, fixture.dependencies);
  assert.equal(report.stopped, true);
  assert.equal(report.stopReason.code, "PRODUCTION_SYNC_BUDGET_MISMATCH");
});

test("20. global STOP evita siguientes batches", async () => {
  const items = [
    makeItem({ index: 1, classification: "CREATE_SINGLE" }),
    makeItem({ index: 2, priceAction: "PRICE_UPDATE" }),
  ];
  let calls = 0;
  const fixture = runnerFixture(items, {
    dependencies: {
      runSubBatch: async (subBatch) => {
        calls += 1;
        return completedSubBatch(subBatch, {
          stopped: true,
          stopReason: { code: "UNSAFE", message: "stop" },
        });
      },
    },
  });
  const report = await runProductionSync(fixture.options, fixture.dependencies);
  assert.equal(report.stopped, true);
  assert.equal(calls, 1);
});

test("21. reporte parcial se persiste al detener", async () => {
  const item = makeItem({ priceAction: "PRICE_UPDATE" });
  const snapshots = [];
  const fixture = runnerFixture([item], {
    options: { persist: true },
    dependencies: {
      persistCheckpoint: (report) => snapshots.push(JSON.parse(JSON.stringify(report))),
      persistReport: () => "report.json",
      runSubBatch: async (subBatch) => completedSubBatch(subBatch, {
        stopped: true,
        stopReason: { code: "UNSAFE", message: "stop" },
      }),
    },
  });
  const report = await runProductionSync(fixture.options, fixture.dependencies);
  assert.equal(report.stopped, true);
  assert.ok(snapshots.some((snapshot) => snapshot.stopped === true));
});

test("22. idempotencia segunda corrida produce 0 writes", () => {
  const first = buildSafeProductionPlan(analysis([
    makeItem({ priceAction: "PRICE_UPDATE" }),
  ]), { env: SAFE_ENV });
  const second = buildSafeProductionPlan(analysis([
    makeItem({ priceAction: "PRICE_NO_CHANGE" }),
  ]), { env: SAFE_ENV });
  assert.equal(first.plannedWrites, 1);
  assert.equal(second.plannedWrites, 0);
});

test("23. gates EXECUTE siguen siendo obligatorios", () => {
  assert.throws(
    () => assertProductionExecutionAuthorized({
      mode: "EXECUTE",
      confirmRealWrites: true,
      domains: ["PRICE"],
      env: SAFE_ENV,
    }),
    (error) => error.code === "PRODUCTION_SYNC_EXECUTION_NOT_AUTHORIZED",
  );
});

test("24. EXECUTE sin confirmacion rechazado", () => {
  const env = {
    ...SAFE_ENV,
    TIENDANUBE_DRY_RUN: "false",
    TIENDANUBE_EXECUTION_ENABLED: "true",
    TIENDANUBE_PRICE_EXECUTION_ENABLED: "true",
  };
  assert.throws(
    () => assertProductionExecutionAuthorized({
      mode: "EXECUTE",
      confirmRealWrites: false,
      domains: ["PRICE"],
      env,
    }),
    (error) => error.code === "PRODUCTION_SYNC_EXECUTION_NOT_AUTHORIZED",
  );
});

test("25. reportes no conservan secretos", () => {
  const root = tempRoot();
  const report = {
    runId: "sanitized",
    error: "Authorization: Bearer very-secret-token",
    cookie: "session=private-cookie",
  };
  const file = persistProductionSyncReport(report, root);
  const persisted = fs.readFileSync(file, "utf8");
  assert.equal(persisted.includes("very-secret-token"), false);
  assert.equal(persisted.includes("private-cookie"), false);
  assert.equal(containsSensitiveKeys(JSON.parse(persisted)), false);
});

test("26. IMAGE con source type no aprobado se excluye por dominio", () => {
  const plan = buildSafeProductionPlan(analysis([
    makeItem({
      imageAction: "IMAGE_REPLACE",
      imageSourceType: null,
      priceAction: "PRICE_UPDATE",
    }),
  ]), { env: SAFE_ENV });
  assert.equal(plan.domainExclusions.IMAGE.length, 1);
  assert.equal(plan.subBatches.some((item) => item.domain === "IMAGE"), false);
  assert.equal(plan.subBatches.some((item) => item.domain === "PRICE"), true);
});

async function main() {
  readBatchConfig(SAFE_ENV);
  let passed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      passed += 1;
      console.log(`OK ${entry.name}`);
    } catch (error) {
      console.error(`FAIL ${entry.name}`);
      throw error;
    }
  }
  console.log(`\n${passed}/${tests.length} production sync tests passed.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { analysis, makeItem, main };
