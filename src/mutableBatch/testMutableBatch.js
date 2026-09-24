const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MutableWriteController,
  instrumentCreateAdapter,
  instrumentImageAdapter,
} = require("./mutableBatchAdapters");
const {
  checkpointPath,
  findCheckpointItem,
  loadCheckpoint,
  saveCheckpoint,
} = require("./mutableBatchCheckpoint");
const {
  applyImageAlreadyCurrentTrace,
  reconcileImageResume,
  runMutableBatch,
  SAFE_ENV,
} = require("./mutableBatchRunner");
const {
  assertImageApprovedSnapshotComplete,
  assertImageSnapshotExecutable,
  assertPriceApprovedSnapshotComplete,
  assertPriceSnapshotExecutable,
  assertSnapshotUnchanged,
  buildPreconditionSnapshot,
} = require("./mutableBatchPlan");
const { executeLegacyStatusUpdates } = require("../executor/legacyStatusExecution");

const SOURCE_SKU = "415 0768 09 0";
const NORMALIZED_SKU = "4150768090";
const CODE_VERSION = "test-sha";
const WRITE_ENV = {
  ...SAFE_ENV,
  TIENDANUBE_DRY_RUN: "false",
  TIENDANUBE_EXECUTION_ENABLED: "true",
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "true",
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "true",
  TIENDANUBE_IMAGE_EXECUTION_ENABLED: "true",
  TIENDANUBE_CREATE_EXECUTION_ENABLED: "true",
};

function fakePlanExecution(options = {}) {
  const classification = options.classification || "SINGLE";
  const priceAction = options.priceAction || "PRICE_UPDATE";
  const statusAction = options.statusAction || "STATUS_NO_CHANGE";
  const imageAction = options.imageAction || "IMAGE_NO_CHANGE";
  const availability = options.availability || "AVAILABLE";
  const matches = classification === "CREATE_SINGLE" ? [] : [
    {
      productId: 10,
      variantId: 20,
      sku: NORMALIZED_SKU,
      published: options.published ?? true,
      price: options.currentPrice ?? 100,
      currentPrice: options.currentPrice ?? 100,
      imageId: 30,
      imageCount: 1,
      imageIds: [30],
    },
  ];
  if (classification === "LEGACY_GROUP") {
    matches.push({
      productId: 11,
      variantId: 21,
      sku: NORMALIZED_SKU,
      published: options.published ?? true,
      price: options.currentPrice ?? 100,
      currentPrice: options.currentPrice ?? 100,
      imageId: 31,
      imageCount: 1,
      imageIds: [31],
    });
  }
  const publications = (action, extras = {}) => matches.map((match) => ({
    ...match,
    action,
    ...extras,
  }));
  const originalPlan = {
    sourceSku: SOURCE_SKU,
    normalizedSku: NORMALIZED_SKU,
    matchedCode: NORMALIZED_SKU,
    supplierResolution: { type: options.resolution || "EXACT" },
    classification,
    supplier: {
      codigo: NORMALIZED_SKU,
      availability,
      supplierPrice: options.supplierPrice ?? 100,
      name: "Producto controlado",
      imageSourceType: "COVER_FULL",
    },
    tiendanube: {
      matchCount: matches.length,
      productIds: matches.map((item) => item.productId),
      variantIds: matches.map((item) => item.variantId),
      matches,
      legacyGroup: classification === "LEGACY_GROUP"
        ? { valid: options.legacyValid !== false, expectedMatches: 2, actualMatches: matches.length }
        : null,
    },
    plans: {
      status: {
        action: statusAction,
        desiredPublished: statusAction === "UNPUBLISH" ? false : true,
        publications: publications(statusAction, {
          desiredPublished: statusAction === "UNPUBLISH" ? false : true,
        }),
      },
      price: {
        action: priceAction,
        calculation: {
          supplierPrice: options.supplierPrice ?? 100,
          category: 1,
          multiplier: 1.5,
          baseCalculatedPrice: options.calculatedPrice ?? 150,
          calculatedPrice: options.calculatedPrice ?? 150,
        },
        publications: publications(priceAction, {
          currentPrice: options.currentPrice ?? 100,
          requestedPrice: options.calculatedPrice ?? 150,
          calculatedPrice: options.calculatedPrice ?? 150,
        }),
      },
      image: {
        action: imageAction,
        sourceImageUrl: "https://www.arcore.com/catalogoWeb/imagenes/test.png",
        sourceHash: "source-hash",
        publications: publications(imageAction, {
          tiendanubeImageCount: 1,
          tiendanubeImageIds: [30],
          imageId: 30,
          tiendanubeHash: imageAction === "IMAGE_NO_CHANGE"
            ? "source-hash"
            : "target-hash",
          sourceHash: "source-hash",
          comparison: {
            exactMatch: imageAction === "IMAGE_NO_CHANGE",
            perceptualMatch: imageAction === "IMAGE_NO_CHANGE",
            sourceExactHash: "source-hash",
            targetExactHash: imageAction === "IMAGE_NO_CHANGE"
              ? "source-hash"
              : "target-hash",
            sourcePerceptualHash: imageAction === "IMAGE_NO_CHANGE"
              ? null
              : "source-fingerprint",
            targetPerceptualHash: imageAction === "IMAGE_NO_CHANGE"
              ? null
              : "target-fingerprint",
            distance: imageAction === "IMAGE_NO_CHANGE" ? 0 : 95,
            threshold: 20,
          },
        }).map((publication, index) => ({
          ...publication,
          tiendanubeImageIds: [30 + index],
          imageId: 30 + index,
        })),
      },
    },
    warnings: [],
    errors: [],
  };
  const actions = [];
  for (const match of matches) {
    actions.push({
      type: "STATUS",
      productId: match.productId,
      variantId: match.variantId,
      plannedAction: statusAction,
      simulationResult: ["PUBLISH", "UNPUBLISH"].includes(statusAction)
        ? "WOULD_UPDATE"
        : statusAction === "STATUS_UNKNOWN" ? "BLOCKED" : "SKIPPED_ALREADY_APPLIED",
    });
    actions.push({
      type: "PRICE",
      productId: match.productId,
      variantId: match.variantId,
      plannedAction: priceAction,
      simulationResult: priceAction === "PRICE_UPDATE"
        ? "WOULD_UPDATE"
        : priceAction.includes("BLOCK") ? "BLOCKED" : "SKIPPED_ALREADY_APPLIED",
    });
    actions.push({
      type: "IMAGE",
      productId: match.productId,
      variantId: match.variantId,
      plannedAction: imageAction,
      simulationResult: imageAction === "IMAGE_REPLACE"
        ? "WOULD_REPLACE"
        : "SKIPPED_ALREADY_APPLIED",
    });
  }
  if (classification === "CREATE_SINGLE") {
    actions.push({
      type: "CREATE_PRODUCT",
      productId: null,
      variantId: null,
      plannedAction: "CREATE_SINGLE",
      simulationResult: "WOULD_CREATE",
    });
  }
  return {
    normalizedSku: NORMALIZED_SKU,
    matchedCode: NORMALIZED_SKU,
    supplierResolution: originalPlan.supplierResolution,
    classification,
    originalPlan,
    revalidation: { status: "PASSED", ok: true },
    executionPlan: { actions },
    result: { executionStatus: "SIMULATED", writeAttempted: false },
    warnings: [],
    errors: [],
  };
}

function tempOptions(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-batch-test-"));
  return {
    skus: [SOURCE_SKU],
    enablePRICE: true,
    maxWrites: 2,
    checkpointOutputDir: path.join(root, "checkpoints"),
    planOutputDir: path.join(root, "plans"),
    runOutputDir: path.join(root, "runs"),
    persist: false,
    _root: root,
    ...overrides,
  };
}

function fakeRuntime() {
  return { metrics: { contextsOpened: 0 }, async close() {} };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function imageSnapshot(options = {}) {
  return buildPreconditionSnapshot(
    fakePlanExecution({
      imageAction: options.imageAction || "IMAGE_REPLACE",
      priceAction: "PRICE_NO_CHANGE",
      classification: options.classification || "SINGLE",
    }).originalPlan,
    "IMAGE",
  );
}

function depsFor(planExecution, executeDomain, overrides = {}) {
  return {
    getCodeVersion: () => CODE_VERSION,
    getMainVersion: () => CODE_VERSION,
    openRuntime: async () => fakeRuntime(),
    planSku: async () => planExecution,
    ...(executeDomain ? { executeDomain } : {}),
    ...overrides,
  };
}

function successfulDomain(writeCount = 1, action = "PRICE_UPDATE") {
  return async ({ domain, controller }) => {
    for (let index = 0; index < writeCount; index += 1) {
      const audit = controller.beginWrite({
        domain,
        method: domain === "CREATE" || (domain === "IMAGE" && index === 0) ? "POST" : "PUT",
        resource: `/test/${index}`,
        targetState: { ok: true },
      });
      controller.completeWrite(audit, { id: 100 + index });
    }
    return {
      executionPlan: {
        actions: [{
          type: domain === "CREATE" ? "CREATE_PRODUCT" : domain,
          plannedAction: action,
          executionResult: "WRITE_SUCCEEDED",
          verifiedState: { ok: true },
        }],
      },
    };
  };
}

function checkpointFixture(domain = "PRICE", maxWrites = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-controller-test-"));
  const item = {
    key: `${NORMALIZED_SKU}:${domain}`,
    normalizedSku: NORMALIZED_SKU,
    domain,
    state: "PLANNED",
    writesConsumed: 0,
    errors: [],
    returnedIds: {},
  };
  const checkpoint = {
    version: 1,
    runId: "test",
    maxWrites,
    writesConsumed: 0,
    stopped: false,
    stopReason: null,
    auditLog: [],
    items: [item],
  };
  const file = path.join(root, "test.checkpoint.json");
  const controller = new MutableWriteController({
    checkpoint,
    checkpointItem: item,
    checkpointFile: file,
    saveCheckpoint,
  });
  return { root, item, checkpoint, file, controller };
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test("1. default PLAN_ONLY", async () => {
  const options = tempOptions({ mode: undefined });
  const report = await runMutableBatch(options, depsFor(fakePlanExecution()));
  assert.equal(report.metadata.mode, "PLAN");
  assert.equal(report.budget.writesConsumed, 0);
});

test("2. EXECUTE sin confirm produce 0 writes", async () => {
  const options = tempOptions({ mode: "EXECUTE" });
  const report = await runMutableBatch(options, depsFor(fakePlanExecution(), successfulDomain(), { env: WRITE_ENV }));
  assert.equal(report.stopped, true);
  assert.equal(report.budget.writesConsumed, 0);
});

test("3. SKU fuera de scope se rechaza", async () => {
  const options = tempOptions({ skus: ["NO-EXISTE-999"] });
  await assert.rejects(
    runMutableBatch(options, depsFor(fakePlanExecution())),
    (error) => error.code === "SKU_OUTSIDE_CLIENT_SCOPE",
  );
});

test("4. allowlist duplicada se rechaza", async () => {
  const options = tempOptions({ skus: [SOURCE_SKU, SOURCE_SKU] });
  await assert.rejects(
    runMutableBatch(options, depsFor(fakePlanExecution())),
    (error) => error.code === "MUTABLE_ALLOWLIST_DUPLICATE",
  );
});

test("5. PRICE success", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true });
  const report = await runMutableBatch(options, depsFor(fakePlanExecution(), successfulDomain(), { env: WRITE_ENV }));
  assert.equal(report.stopped, false);
  assert.equal(report.budget.writesConsumed, 1);
});

test("6. PRICE already current", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true });
  const plan = fakePlanExecution({ priceAction: "PRICE_NO_CHANGE" });
  const report = await runMutableBatch(options, depsFor(plan, async () => assert.fail("no execute"), { env: WRITE_ENV }));
  assert.equal(report.budget.writesConsumed, 0);
  assert.equal(report.perSku[0].state, "SKIPPED");
});

test("7. STATUS success", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true, enablePRICE: false, enableSTATUS: true });
  const plan = fakePlanExecution({ statusAction: "UNPUBLISH", priceAction: "PRICE_NO_CHANGE" });
  const report = await runMutableBatch(options, depsFor(plan, successfulDomain(1, "UNPUBLISH"), { env: WRITE_ENV }));
  assert.equal(report.budget.writesConsumed, 1);
});

test("8. STATUS legacy dos publicaciones", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true, enablePRICE: false, enableSTATUS: true, maxWrites: 2 });
  const plan = fakePlanExecution({ classification: "LEGACY_GROUP", statusAction: "UNPUBLISH", priceAction: "PRICE_NO_CHANGE" });
  const report = await runMutableBatch(options, depsFor(plan, successfulDomain(2, "UNPUBLISH"), { env: WRITE_ENV }));
  assert.equal(report.budget.writesConsumed, 2);
});

test("9. legacy mismatch no escribe", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true, enablePRICE: false, enableSTATUS: true });
  const plan = fakePlanExecution({ classification: "MANUAL_REVIEW", statusAction: "STATUS_UNKNOWN" });
  const report = await runMutableBatch(options, depsFor(plan, async () => assert.fail("no execute"), { env: WRITE_ENV }));
  assert.equal(report.budget.writesConsumed, 0);
  assert.equal(report.stopped, true);
});

test("10. IMAGE success POST y DELETE", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true, enablePRICE: false, enableIMAGE: true, maxWrites: 2 });
  const plan = fakePlanExecution({ imageAction: "IMAGE_REPLACE", priceAction: "PRICE_NO_CHANGE" });
  const report = await runMutableBatch(options, depsFor(plan, successfulDomain(2, "IMAGE_REPLACE"), { env: WRITE_ENV }));
  assert.equal(report.budget.writesConsumed, 2);
});

test("11. IMAGE POST fail detiene", async () => {
  const fixture = checkpointFixture("IMAGE", 2);
  const adapter = instrumentImageAdapter({
    async getProduct() { return { id: 1, variants: [] }; },
    async listProductImages() { return []; },
    async uploadProductImage() { throw Object.assign(new Error("upload fail"), { status: 500 }); },
    async deleteProductImage() { assert.fail("no delete"); },
  }, fixture.controller);
  await assert.rejects(adapter.uploadProductImage(1, { src: "https://x/img", position: 1 }));
  assert.equal(fixture.checkpoint.stopped, true);
  assert.equal(fixture.checkpoint.writesConsumed, 1);
});

test("12. IMAGE verify fail no DELETE", async () => {
  const fixture = checkpointFixture("IMAGE", 2);
  let deletes = 0;
  const adapter = instrumentImageAdapter({
    async getProduct() { return { id: 1, variants: [] }; },
    async listProductImages() { return []; },
    async uploadProductImage() { return { id: 99 }; },
    async deleteProductImage() { deletes += 1; },
  }, fixture.controller);
  await adapter.uploadProductImage(1, { src: "https://x/img", position: 1 });
  assert.equal(deletes, 0);
  assert.equal(fixture.item.substate, "IMAGE_POST_COMPLETED_PENDING_VERIFICATION");
});

test("13. IMAGE resume after POST no repite POST", async () => {
  const setup = await createResumeFixture("IMAGE", fakePlanExecution({ imageAction: "IMAGE_REPLACE", priceAction: "PRICE_NO_CHANGE" }));
  setup.item.writesConsumed = 1;
  setup.checkpoint.writesConsumed = 1;
  setup.item.substate = "IMAGE_NEW_PRESENT_OLD_NOT_DELETED";
  saveCheckpoint(setup.checkpoint, setup.checkpointFile);
  let executes = 0;
  const report = await runMutableBatch({ mode: "EXECUTE", resume: setup.checkpointFile, planFile: setup.planFile, confirmRealWrites: true, persist: false }, {
    ...setup.dependencies,
    env: WRITE_ENV,
    executeDomain: async () => { executes += 1; },
    reconcileResume: async () => ({ verified: true, resumedWithoutPost: true }),
  });
  assert.equal(executes, 0);
  assert.equal(report.budget.writesConsumed, 1);
});

test("14. CREATE success", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true, enablePRICE: false, enableCREATE: true, maxWrites: 1 });
  const plan = fakePlanExecution({ classification: "CREATE_SINGLE", priceAction: "PRICE_FOR_CREATION" });
  const report = await runMutableBatch(options, depsFor(plan, successfulDomain(1, "CREATE_SINGLE"), { env: WRITE_ENV }));
  assert.equal(report.budget.writesConsumed, 1);
});

test("15. CREATE duplicate guard detiene sin POST", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true, enablePRICE: false, enableCREATE: true, maxWrites: 1 });
  const plan = fakePlanExecution({ classification: "CREATE_SINGLE" });
  const execute = async () => ({ executionPlan: { actions: [{
    type: "CREATE_PRODUCT",
    plannedAction: "CREATE_SINGLE",
    executionResult: "BLOCKED",
    errors: [{ code: "CREATE_DUPLICATE_GUARD_TRIGGERED", message: "exists" }],
  }] } });
  const report = await runMutableBatch(options, depsFor(plan, execute, { env: WRITE_ENV }));
  assert.equal(report.stopped, true);
  assert.equal(report.budget.writesConsumed, 0);
});

test("16. CREATE ambiguous queda excluido", async () => {
  const options = tempOptions({ enablePRICE: false, enableCREATE: true, maxWrites: 1 });
  const plan = fakePlanExecution({ classification: "MANUAL_REVIEW" });
  const report = await runMutableBatch(options, depsFor(plan));
  assert.equal(report.plan.excludedItems.length, 1);
  assert.equal(report.budget.writesConsumed, 0);
});

test("17. CREATE crash after POST persiste IDs", async () => {
  const fixture = checkpointFixture("CREATE", 1);
  const adapter = instrumentCreateAdapter({
    async findSkuMatches() { return { matches: [] }; },
    async createProduct() { return { id: 77, variants: [{ id: 88 }] }; },
    async getProduct() { throw new Error("crash"); },
    async listProductImages() { return []; },
  }, fixture.controller);
  await adapter.createProduct({ name: "x" });
  assert.equal(fixture.item.returnedIds.createdProductId, 77);
  assert.equal(fixture.item.substate, "CREATE_POST_COMPLETED");
});

test("18. CREATE resume no segundo POST", async () => {
  const setup = await createResumeFixture("CREATE", fakePlanExecution({ classification: "CREATE_SINGLE" }));
  setup.item.writesConsumed = 1;
  setup.checkpoint.writesConsumed = 1;
  setup.item.substate = "CREATE_POST_COMPLETED";
  setup.item.returnedIds.createdProductId = 77;
  saveCheckpoint(setup.checkpoint, setup.checkpointFile);
  let executes = 0;
  const report = await runMutableBatch({ mode: "EXECUTE", resume: setup.checkpointFile, planFile: setup.planFile, confirmRealWrites: true, persist: false }, {
    ...setup.dependencies,
    env: WRITE_ENV,
    executeDomain: async () => { executes += 1; },
    reconcileResume: async () => ({ verified: true, productId: 77 }),
  });
  assert.equal(executes, 0);
  assert.equal(report.budget.writesConsumed, 1);
});

test("19. budget exact", async () => {
  const fixture = checkpointFixture("PRICE", 1);
  const audit = fixture.controller.beginWrite({ domain: "PRICE", method: "PUT", resource: "/x", targetState: {} });
  fixture.controller.completeWrite(audit, {});
  assert.equal(fixture.checkpoint.writesConsumed, 1);
});

test("20. budget agotado antes del write", async () => {
  const fixture = checkpointFixture("PRICE", 0);
  assert.throws(
    () => fixture.controller.beginWrite({ domain: "PRICE", method: "PUT", resource: "/x", targetState: {} }),
    (error) => error.code === "WRITE_BUDGET_EXHAUSTED",
  );
  assert.equal(fixture.checkpoint.writesConsumed, 0);
});

test("21. write fuera de dominio bloqueado", async () => {
  const fixture = checkpointFixture("PRICE", 1);
  assert.throws(
    () => fixture.controller.beginWrite({ domain: "STATUS", method: "PUT", resource: "/x", targetState: {} }),
    (error) => error.code === "WRITE_OUTSIDE_ENABLED_DOMAIN",
  );
});

test("22. precondition drift detiene", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true });
  const error = Object.assign(new Error("drift"), { code: "PRECONDITION_CHANGED" });
  const report = await runMutableBatch(options, depsFor(fakePlanExecution(), async () => { throw error; }, { env: WRITE_ENV }));
  assert.equal(report.stopReason.code, "PRECONDITION_CHANGED");
});

test("23. availability UNKNOWN no STATUS write", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true, enablePRICE: false, enableSTATUS: true });
  const plan = fakePlanExecution({ availability: "UNKNOWN", statusAction: "STATUS_UNKNOWN" });
  const report = await runMutableBatch(options, depsFor(plan, async () => assert.fail("no execute"), { env: WRITE_ENV }));
  assert.equal(report.budget.writesConsumed, 0);
  assert.equal(report.stopped, true);
});

test("24. supplier price invalido no PRICE write", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true });
  const plan = fakePlanExecution({ supplierPrice: null, priceAction: "PRICE_WRITE_BLOCKED" });
  const report = await runMutableBatch(options, depsFor(plan, async () => assert.fail("no execute"), { env: WRITE_ENV }));
  assert.equal(report.budget.writesConsumed, 0);
  assert.equal(report.stopped, true);
});

test("25. session failure", async () => {
  const options = tempOptions();
  await assert.rejects(
    runMutableBatch(options, { getCodeVersion: () => CODE_VERSION, getMainVersion: () => CODE_VERSION, openRuntime: async () => { throw new Error("session"); } }),
    /session/,
  );
});

test("26. write 429 detiene", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true });
  const error = Object.assign(new Error("rate limit"), { code: "WRITE_FAILED", status: 429 });
  const report = await runMutableBatch(options, depsFor(fakePlanExecution(), async () => { throw error; }, { env: WRITE_ENV }));
  assert.equal(report.stopped, true);
});

test("27. write 5xx detiene", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true });
  const error = Object.assign(new Error("server"), { code: "WRITE_FAILED", status: 500 });
  const report = await runMutableBatch(options, depsFor(fakePlanExecution(), async () => { throw error; }, { env: WRITE_ENV }));
  assert.equal(report.stopped, true);
});

test("28. post verification fail detiene", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true });
  const execute = async ({ controller }) => {
    const audit = controller.beginWrite({ domain: "PRICE", method: "PUT", resource: "/x", targetState: {} });
    controller.completeWrite(audit, {});
    return { executionPlan: { actions: [{
      type: "PRICE",
      plannedAction: "PRICE_UPDATE",
      executionResult: "WRITE_VERIFICATION_FAILED",
      errors: [{ code: "PRICE_WRITE_VERIFICATION_FAILED", message: "mismatch" }],
    }] } };
  };
  const report = await runMutableBatch(options, depsFor(fakePlanExecution(), execute, { env: WRITE_ENV }));
  assert.equal(report.stopped, true);
  assert.equal(report.budget.writesConsumed, 1);
});

test("29. checkpoint persistence", async () => {
  const options = tempOptions();
  const report = await runMutableBatch(options, depsFor(fakePlanExecution()));
  const loaded = loadCheckpoint(report.checkpointFile);
  assert.equal(loaded.checkpoint.runId, report.metadata.runId);
});

test("30. resume VERIFIED SKU skip", async () => {
  const setup = await createResumeFixture("PRICE", fakePlanExecution());
  setup.item.state = "VERIFIED";
  saveCheckpoint(setup.checkpoint, setup.checkpointFile);
  let executes = 0;
  const report = await runMutableBatch({ mode: "EXECUTE", resume: setup.checkpointFile, planFile: setup.planFile, confirmRealWrites: true, persist: false }, {
    ...setup.dependencies,
    env: WRITE_ENV,
    executeDomain: async () => { executes += 1; },
  });
  assert.equal(executes, 0);
  assert.equal(report.stopped, false);
});

test("31. resume estado externo inconsistente detiene", async () => {
  const setup = await createResumeFixture("PRICE", fakePlanExecution());
  setup.item.writesConsumed = 1;
  setup.checkpoint.writesConsumed = 1;
  setup.item.state = "WRITE_COMPLETED";
  saveCheckpoint(setup.checkpoint, setup.checkpointFile);
  const report = await runMutableBatch({ mode: "EXECUTE", resume: setup.checkpointFile, planFile: setup.planFile, confirmRealWrites: true, persist: false }, {
    ...setup.dependencies,
    env: WRITE_ENV,
    reconcileResume: async () => ({ verified: false }),
  });
  assert.equal(report.stopped, true);
  assert.equal(report.stopReason.code, "RESUME_INCONSISTENT_EXTERNAL_STATE");
});

test("32. PLAN siempre cero writes", async () => {
  const options = tempOptions({ mode: "PLAN", confirmRealWrites: true, maxWrites: 99 });
  const report = await runMutableBatch(options, depsFor(fakePlanExecution(), successfulDomain(), { env: WRITE_ENV }));
  assert.equal(report.budget.writesConsumed, 0);
  assert.equal(report.writes.length, 0);
});

test("33. drift ajeno al dominio no bloquea", async () => {
  const before = fakePlanExecution();
  const after = fakePlanExecution({ currentPrice: 999 });
  assert.deepEqual(
    buildPreconditionSnapshot(before.originalPlan, "STATUS"),
    buildPreconditionSnapshot(after.originalPlan, "STATUS"),
  );
  assert.notDeepEqual(
    buildPreconditionSnapshot(before.originalPlan, "PRICE"),
    buildPreconditionSnapshot(after.originalPlan, "PRICE"),
  );
});

test("34. DELETE fallido conserva subestado parcial IMAGE", async () => {
  const fixture = checkpointFixture("IMAGE", 2);
  const adapter = instrumentImageAdapter({
    async getProduct() { return { id: 1, variants: [] }; },
    async listProductImages() { return []; },
    async uploadProductImage() { return { id: 99 }; },
    async deleteProductImage() { throw new Error("delete fail"); },
  }, fixture.controller);
  await adapter.uploadProductImage(1, { src: "https://x/img", position: 1 });
  adapter.markImageUploadVerified(1, 50, 99);
  await assert.rejects(adapter.deleteProductImage(1, 50));
  assert.equal(fixture.item.substate, "IMAGE_NEW_PRESENT_OLD_NOT_DELETED");
  assert.equal(fixture.item.returnedIds.newImageId, 99);
});

test("35. dominios deshabilitados se reportan sin presupuestar", async () => {
  const options = tempOptions({ mode: "PLAN", enablePRICE: true });
  const report = await runMutableBatch(options, depsFor(fakePlanExecution({
    statusAction: "UNPUBLISH",
    imageAction: "IMAGE_REPLACE",
  })));
  assert.equal(report.plan.items[0].domains.STATUS.action, "UNPUBLISH");
  assert.equal(report.plan.items[0].domains.IMAGE.action, "IMAGE_REPLACE");
  assert.equal(report.plan.actions.find((item) => item.domain === "STATUS").enabled, false);
  assert.equal(report.plan.expectedWrites, 1);
});

test("36. legacy stopOnAnyFailure no ejecuta publicacion siguiente", async () => {
  const actions = [10, 11].map((productId, index) => ({
    type: "STATUS",
    productId,
    variantId: 20 + index,
    plannedAction: "UNPUBLISH",
    currentState: { published: true },
    desiredState: { published: false },
    simulationResult: "WOULD_UPDATE",
    errors: [],
  }));
  let updateCalls = 0;
  const result = await executeLegacyStatusUpdates({
    plan: { normalizedSku: NORMALIZED_SKU },
    actions,
    stopOnAnyFailure: true,
    adapter: {
      async getProduct(productId) {
        const action = actions.find((item) => item.productId === productId);
        return {
          id: productId,
          published: true,
          variants: [{ id: action.variantId, sku: NORMALIZED_SKU }],
        };
      },
      async updateProductPublished() {
        updateCalls += 1;
        throw new Error("write fail");
      },
    },
  });
  assert.equal(updateCalls, 1);
  assert.equal(actions[1].executionResult, "BLOCKED");
  assert.equal(result.groupIntegrityFailed, true);
});

test("37. PLAN SINGLE persiste precios y contexto aprobados", async () => {
  const report = await runMutableBatch(
    tempOptions({ mode: "PLAN" }),
    depsFor(fakePlanExecution()),
  );
  const price = report.plan.items[0].domains.PRICE;
  assert.equal(price.snapshot.publications[0].approvedCurrentPrice, 100);
  assert.equal(price.snapshot.publications[0].approvedTargetPrice, 150);
  assert.equal(price.snapshot.supplierPrice, 100);
  assert.equal(price.snapshot.pricingResult.category, 1);
  assert.equal(price.snapshot.pricingResult.multiplier, 1.5);
  assert.equal(price.snapshot.pricingResult.baseCalculatedPrice, 150);
  assert.equal(price.snapshot.pricingResult.calculatedPrice, 150);
  assert.equal(price.actions[0].approvedCurrentPrice, 100);
  assert.equal(price.actions[0].approvedTargetPrice, 150);
  assert.equal(price.actions[0].normalizedSku, NORMALIZED_SKU);
  assert.equal(price.actions[0].classification, "SINGLE");
  assert.equal(price.actions[0].resolution, "EXACT");
});

test("38. EXECUTE current igual al aprobado permite write", async () => {
  const expected = buildPreconditionSnapshot(
    fakePlanExecution({ currentPrice: 100 }).originalPlan,
    "PRICE",
  );
  const actual = buildPreconditionSnapshot(
    fakePlanExecution({ currentPrice: 100 }).originalPlan,
    "PRICE",
  );
  const result = assertPriceSnapshotExecutable(expected, actual);
  assert.deepEqual(result.writablePairs, ["10:20"]);
  assert.deepEqual(result.alreadyCurrentPairs, []);
});

test("39. EXECUTE current igual al target queda already current", async () => {
  const expected = buildPreconditionSnapshot(
    fakePlanExecution({ currentPrice: 100 }).originalPlan,
    "PRICE",
  );
  const actual = buildPreconditionSnapshot(
    fakePlanExecution({ currentPrice: 150, priceAction: "PRICE_NO_CHANGE" }).originalPlan,
    "PRICE",
  );
  const result = assertPriceSnapshotExecutable(expected, actual);
  assert.deepEqual(result.writablePairs, []);
  assert.deepEqual(result.alreadyCurrentPairs, ["10:20"]);
});

test("40. EXECUTE current distinto de aprobado y target detiene", async () => {
  const expected = buildPreconditionSnapshot(
    fakePlanExecution({ currentPrice: 100 }).originalPlan,
    "PRICE",
  );
  const actual = buildPreconditionSnapshot(
    fakePlanExecution({ currentPrice: 125 }).originalPlan,
    "PRICE",
  );
  assert.throws(
    () => assertPriceSnapshotExecutable(expected, actual),
    (error) => error.code === "PRECONDITION_CHANGED",
  );
});

test("41. supplierPrice drift produce PRICE_TARGET_DRIFT", async () => {
  const expected = buildPreconditionSnapshot(fakePlanExecution().originalPlan, "PRICE");
  const actual = buildPreconditionSnapshot(
    fakePlanExecution({ supplierPrice: 101 }).originalPlan,
    "PRICE",
  );
  assert.throws(
    () => assertPriceSnapshotExecutable(expected, actual),
    (error) => error.code === "PRICE_TARGET_DRIFT",
  );
});

test("42. calculated target drift produce PRICE_TARGET_DRIFT", async () => {
  const expected = buildPreconditionSnapshot(fakePlanExecution().originalPlan, "PRICE");
  const actual = buildPreconditionSnapshot(
    fakePlanExecution({ calculatedPrice: 151 }).originalPlan,
    "PRICE",
  );
  assert.throws(
    () => assertPriceSnapshotExecutable(expected, actual),
    (error) => error.code === "PRICE_TARGET_DRIFT",
  );
});

test("43. approvedCurrentPrice null se rechaza", async () => {
  const snapshot = buildPreconditionSnapshot(fakePlanExecution().originalPlan, "PRICE");
  snapshot.publications[0].approvedCurrentPrice = null;
  assert.throws(
    () => assertPriceApprovedSnapshotComplete(snapshot),
    (error) => error.code === "PRICE_APPROVED_SNAPSHOT_INCOMPLETE",
  );
});

test("44. checkpoint PRICE viejo se rechaza en resume", async () => {
  const setup = await createResumeFixture("PRICE", fakePlanExecution());
  const plan = JSON.parse(fs.readFileSync(setup.planFile, "utf8"));
  const snapshot = plan.items[0].domains.PRICE.snapshot;
  snapshot.publications[0] = {
    productId: 10,
    variantId: 20,
    sku: NORMALIZED_SKU,
    action: "PRICE_UPDATE",
    price: null,
    calculatedPrice: 150,
  };
  delete snapshot.approvedTargetPrice;
  delete snapshot.pricingResult;
  fs.writeFileSync(setup.planFile, JSON.stringify(plan, null, 2));
  await assert.rejects(
    runMutableBatch({
      mode: "EXECUTE",
      resume: setup.checkpointFile,
      planFile: setup.planFile,
      confirmRealWrites: true,
      persist: false,
    }, { ...setup.dependencies, env: WRITE_ENV }),
    (error) => error.code === "PRICE_APPROVED_SNAPSHOT_INCOMPLETE",
  );
});

test("45. resume conserva approvedCurrentPrice original", async () => {
  const setup = await createResumeFixture("PRICE", fakePlanExecution({ currentPrice: 100 }));
  const report = await runMutableBatch({
    mode: "PLAN",
    resume: setup.checkpointFile,
    planFile: setup.planFile,
    persist: false,
  }, setup.dependencies);
  assert.equal(
    report.plan.items[0].domains.PRICE.snapshot.publications[0].approvedCurrentPrice,
    100,
  );
  assert.equal(report.perSku[0].approvedSnapshot.publications[0].approvedCurrentPrice, 100);
});

test("46. LEGACY persiste current y target por publicacion", async () => {
  const plan = fakePlanExecution({ classification: "LEGACY_GROUP" });
  plan.originalPlan.plans.price.publications[1].currentPrice = 110;
  const snapshot = buildPreconditionSnapshot(plan.originalPlan, "PRICE");
  assert.deepEqual(
    snapshot.publications.map((item) => item.approvedCurrentPrice),
    [100, 110],
  );
  assert.deepEqual(
    snapshot.publications.map((item) => item.approvedTargetPrice),
    [150, 150],
  );
});

test("47. LEGACY con drift individual detiene todo el dominio", async () => {
  const before = fakePlanExecution({ classification: "LEGACY_GROUP" });
  const after = fakePlanExecution({ classification: "LEGACY_GROUP" });
  after.originalPlan.plans.price.publications[1].currentPrice = 999;
  const expected = buildPreconditionSnapshot(before.originalPlan, "PRICE");
  const actual = buildPreconditionSnapshot(after.originalPlan, "PRICE");
  assert.throws(
    () => assertPriceSnapshotExecutable(expected, actual),
    (error) => error.code === "PRECONDITION_CHANGED",
  );
});

test("48. precondition failure no consume budget", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true });
  const actual = buildPreconditionSnapshot(
    fakePlanExecution({ currentPrice: 999 }).originalPlan,
    "PRICE",
  );
  const execute = async ({ planItem }) => {
    assertSnapshotUnchanged(planItem.domains.PRICE.snapshot, actual);
    assert.fail("no write");
  };
  const report = await runMutableBatch(
    options,
    depsFor(fakePlanExecution(), execute, { env: WRITE_ENV }),
  );
  assert.equal(report.stopped, true);
  assert.equal(report.stopReason.code, "PRECONDITION_CHANGED");
  assert.equal(report.budget.writesConsumed, 0);
  assert.equal(report.writes.length, 0);
});

test("49. PLAN aprobado nunca escribe", async () => {
  const report = await runMutableBatch(
    tempOptions({ mode: "PLAN", confirmRealWrites: true, maxWrites: 10 }),
    depsFor(fakePlanExecution(), successfulDomain(), { env: WRITE_ENV }),
  );
  assert.equal(report.budget.writesConsumed, 0);
  assert.equal(report.writes.length, 0);
  assert.equal(report.perSku[0].state, "PLANNED");
});

test("50. excepcion conserva gates finales seguros", async () => {
  const options = tempOptions({ mode: "EXECUTE", confirmRealWrites: true });
  const report = await runMutableBatch(
    options,
    depsFor(fakePlanExecution(), async () => {
      throw Object.assign(new Error("controlled"), { code: "PRECONDITION_CHANGED" });
    }, { env: WRITE_ENV }),
  );
  assert.equal(report.stopped, true);
  assert.deepEqual(report.finalGates, SAFE_ENV);
  assert.equal(report.budget.writesConsumed, 0);
});

test("51. checkpoint PRICE conserva snapshot identico al plan", async () => {
  const setup = await createResumeFixture("PRICE", fakePlanExecution());
  const plan = JSON.parse(fs.readFileSync(setup.planFile, "utf8"));
  assert.deepEqual(
    setup.item.approvedSnapshot,
    plan.items[0].domains.PRICE.snapshot,
  );
});

test("52. IMAGE SINGLE persiste approvedImageIds", async () => {
  assert.deepEqual(imageSnapshot().publications[0].approvedImageIds, ["30"]);
});

test("53. IMAGE SINGLE persiste approvedImageCount", async () => {
  assert.equal(imageSnapshot().publications[0].approvedImageCount, 1);
});

test("54. IMAGE SINGLE persiste approvedPrimaryImageId", async () => {
  assert.equal(imageSnapshot().publications[0].approvedPrimaryImageId, "30");
});

test("55. IMAGE SINGLE persiste approvedSourceHash", async () => {
  assert.equal(imageSnapshot().publications[0].approvedSourceHash, "source-hash");
});

test("56. IMAGE SINGLE persiste approvedSourceFingerprint", async () => {
  assert.equal(
    imageSnapshot().publications[0].approvedSourceFingerprint,
    "source-fingerprint",
  );
});

test("57. IMAGE SINGLE persiste approvedCurrentFingerprint", async () => {
  assert.equal(
    imageSnapshot().publications[0].approvedCurrentFingerprint,
    "target-fingerprint",
  );
});

test("58. IMAGE SINGLE persiste distancia y threshold", async () => {
  const publication = imageSnapshot().publications[0];
  assert.equal(publication.approvedPerceptualDistance, 95);
  assert.equal(publication.approvedThreshold, 20);
});

test("59. snapshot IMAGE completo permite ejecucion", async () => {
  const snapshot = imageSnapshot();
  assert.equal(assertImageApprovedSnapshotComplete(snapshot), snapshot);
  assert.deepEqual(assertImageSnapshotExecutable(snapshot, clone(snapshot)), {
    alreadyCurrentPairs: [],
    writablePairs: ["10:20"],
  });
});

test("60. drift de imageIds produce IMAGE_TARGET_STATE_DRIFT", async () => {
  const expected = imageSnapshot();
  const actual = clone(expected);
  actual.publications[0].approvedImageIds = ["30", "99"];
  actual.publications[0].approvedImageCount = 2;
  assert.throws(
    () => assertImageSnapshotExecutable(expected, actual),
    (error) => error.code === "IMAGE_TARGET_STATE_DRIFT",
  );
});

test("61. drift de imageCount produce IMAGE_TARGET_STATE_DRIFT", async () => {
  const expected = imageSnapshot();
  const actual = clone(expected);
  actual.publications[0].approvedImageCount = 2;
  assert.throws(
    () => assertImageSnapshotExecutable(expected, actual),
    (error) => error.code === "IMAGE_TARGET_STATE_DRIFT",
  );
});

test("62. drift de primary image produce IMAGE_TARGET_STATE_DRIFT", async () => {
  const expected = imageSnapshot();
  const actual = clone(expected);
  actual.publications[0].approvedPrimaryImageId = "99";
  assert.throws(
    () => assertImageSnapshotExecutable(expected, actual),
    (error) => error.code === "IMAGE_TARGET_STATE_DRIFT",
  );
});

test("63. drift de source URL produce IMAGE_SOURCE_DRIFT", async () => {
  const expected = imageSnapshot();
  const actual = clone(expected);
  actual.publications[0].approvedSourceUrl = "https://www.arcore.com/changed.png";
  assert.throws(
    () => assertImageSnapshotExecutable(expected, actual),
    (error) => error.code === "IMAGE_SOURCE_DRIFT",
  );
});

test("64. drift de source hash produce IMAGE_SOURCE_DRIFT", async () => {
  const expected = imageSnapshot();
  const actual = clone(expected);
  actual.publications[0].approvedSourceHash = "changed";
  assert.throws(
    () => assertImageSnapshotExecutable(expected, actual),
    (error) => error.code === "IMAGE_SOURCE_DRIFT",
  );
});

test("65. drift de source fingerprint produce IMAGE_SOURCE_DRIFT", async () => {
  const expected = imageSnapshot();
  const actual = clone(expected);
  actual.publications[0].approvedSourceFingerprint = "changed";
  assert.throws(
    () => assertImageSnapshotExecutable(expected, actual),
    (error) => error.code === "IMAGE_SOURCE_DRIFT",
  );
});

test("66. drift de current fingerprint produce IMAGE_TARGET_STATE_DRIFT", async () => {
  const expected = imageSnapshot();
  const actual = clone(expected);
  actual.publications[0].approvedCurrentFingerprint = "changed";
  assert.throws(
    () => assertImageSnapshotExecutable(expected, actual),
    (error) => error.code === "IMAGE_TARGET_STATE_DRIFT",
  );
});

test("67. drift perceptual que aun requiere replace detiene", async () => {
  const expected = imageSnapshot();
  const actual = clone(expected);
  actual.publications[0].approvedPerceptualDistance = 94;
  assert.throws(
    () => assertImageSnapshotExecutable(expected, actual),
    (error) => error.code === "IMAGE_PRECONDITION_CHANGED",
  );
});

test("68. IMAGE_ALREADY_CURRENT queda sin write", async () => {
  const expected = imageSnapshot();
  const actual = imageSnapshot({ imageAction: "IMAGE_NO_CHANGE" });
  const result = assertImageSnapshotExecutable(expected, actual);
  assert.deepEqual(result.alreadyCurrentPairs, ["10:20"]);
  const execution = fakePlanExecution({ imageAction: "IMAGE_NO_CHANGE" });
  applyImageAlreadyCurrentTrace(execution, result.alreadyCurrentPairs);
  const action = execution.executionPlan.actions.find((item) => item.type === "IMAGE");
  assert.equal(action.plannedAction, "IMAGE_ALREADY_CURRENT");
  assert.equal(action.executionResult, "SKIPPED_ALREADY_APPLIED");
});

test("69. POST persiste pendingNewImageId antes de verificar", async () => {
  const fixture = checkpointFixture("IMAGE", 2);
  const adapter = instrumentImageAdapter({
    async getProduct() { return {}; },
    async listProductImages() { return []; },
    async uploadProductImage() { return { id: 99 }; },
    async deleteProductImage() {},
  }, fixture.controller);
  await adapter.uploadProductImage(10, { src: "https://x/img", position: 1 });
  assert.equal(fixture.item.returnedIds.pendingNewImageId, 99);
  assert.equal(fixture.item.returnedIds.newImageId, undefined);
});

test("70. upload verificado promueve newImageId durable", async () => {
  const fixture = checkpointFixture("IMAGE", 2);
  const adapter = instrumentImageAdapter({
    async getProduct() { return {}; },
    async listProductImages() { return []; },
    async uploadProductImage() { return { id: 99 }; },
    async deleteProductImage() {},
  }, fixture.controller);
  await adapter.uploadProductImage(10, { src: "https://x/img", position: 1 });
  adapter.markImageUploadVerified(10, 30, 99);
  assert.equal(fixture.item.returnedIds.newImageId, 99);
  assert.equal(fixture.item.returnedIds.oldImageId, 30);
  assert.equal(fixture.item.returnedIds.pendingNewImageId, undefined);
  assert.equal(fixture.item.substate, "IMAGE_NEW_PRESENT_OLD_NOT_DELETED");
});

test("71. DELETE exitoso conserva IDs y subestado", async () => {
  const fixture = checkpointFixture("IMAGE", 2);
  const adapter = instrumentImageAdapter({
    async getProduct() { return {}; },
    async listProductImages() { return []; },
    async uploadProductImage() { return { id: 99 }; },
    async deleteProductImage() {},
  }, fixture.controller);
  await adapter.uploadProductImage(10, { src: "https://x/img", position: 1 });
  adapter.markImageUploadVerified(10, 30, 99);
  await adapter.deleteProductImage(10, 30);
  assert.equal(fixture.item.returnedIds.newImageId, 99);
  assert.equal(fixture.item.returnedIds.deletedImageId, 30);
  assert.equal(fixture.item.substate, "IMAGE_DELETE_COMPLETED");
});

test("72. LEGACY conserva snapshot individual por publicacion", async () => {
  const snapshot = imageSnapshot({ classification: "LEGACY_GROUP" });
  assert.deepEqual(
    snapshot.publications.map((item) => ({
      pair: `${item.productId}:${item.variantId}`,
      ids: item.approvedImageIds,
      primary: item.approvedPrimaryImageId,
    })),
    [
      { pair: "10:20", ids: ["30"], primary: "30" },
      { pair: "11:21", ids: ["31"], primary: "31" },
    ],
  );
});

test("73. LEGACY drift individual detiene antes de siguiente write", async () => {
  const expected = imageSnapshot({ classification: "LEGACY_GROUP" });
  const actual = clone(expected);
  actual.publications[1].approvedCurrentFingerprint = "changed";
  const options = tempOptions({
    mode: "EXECUTE",
    confirmRealWrites: true,
    enablePRICE: false,
    enableIMAGE: true,
    maxWrites: 4,
  });
  const execute = async ({ controller }) => {
    for (let index = 0; index < 2; index += 1) {
      const audit = controller.beginWrite({
        domain: "IMAGE",
        method: index === 0 ? "POST" : "DELETE",
        resource: `/products/10/images/${index}`,
        targetState: {},
      });
      controller.completeWrite(audit, {});
    }
    assertImageSnapshotExecutable(expected, actual);
  };
  const report = await runMutableBatch(
    options,
    depsFor(
      fakePlanExecution({
        classification: "LEGACY_GROUP",
        imageAction: "IMAGE_REPLACE",
        priceAction: "PRICE_NO_CHANGE",
      }),
      execute,
      { env: WRITE_ENV },
    ),
  );
  assert.equal(report.stopped, true);
  assert.equal(report.stopReason.code, "IMAGE_TARGET_STATE_DRIFT");
  assert.equal(report.budget.writesConsumed, 2);
});

test("74. checkpoint IMAGE viejo incompleto se rechaza", async () => {
  const setup = await createResumeFixture(
    "IMAGE",
    fakePlanExecution({ imageAction: "IMAGE_REPLACE", priceAction: "PRICE_NO_CHANGE" }),
  );
  setup.item.approvedSnapshot = null;
  saveCheckpoint(setup.checkpoint, setup.checkpointFile);
  await assert.rejects(
    runMutableBatch({
      mode: "PLAN",
      resume: setup.checkpointFile,
      planFile: setup.planFile,
      persist: false,
    }, setup.dependencies),
    (error) => error.code === "IMAGE_APPROVED_SNAPSHOT_INCOMPLETE",
  );
});

test("75. drift IMAGE no consume budget", async () => {
  const expected = imageSnapshot();
  const actual = clone(expected);
  actual.publications[0].approvedImageIds = ["99"];
  actual.publications[0].approvedPrimaryImageId = "99";
  const options = tempOptions({
    mode: "EXECUTE",
    confirmRealWrites: true,
    enablePRICE: false,
    enableIMAGE: true,
    maxWrites: 2,
  });
  const report = await runMutableBatch(
    options,
    depsFor(
      fakePlanExecution({ imageAction: "IMAGE_REPLACE", priceAction: "PRICE_NO_CHANGE" }),
      async () => assertImageSnapshotExecutable(expected, actual),
      { env: WRITE_ENV },
    ),
  );
  assert.equal(report.stopReason.code, "IMAGE_TARGET_STATE_DRIFT");
  assert.equal(report.budget.writesConsumed, 0);
});

test("76. PLAN IMAGE mantiene cero writes y gates seguros", async () => {
  const report = await runMutableBatch(
    tempOptions({
      mode: "PLAN",
      enablePRICE: false,
      enableIMAGE: true,
      maxWrites: 2,
    }),
    depsFor(fakePlanExecution({ imageAction: "IMAGE_REPLACE" })),
  );
  assert.equal(report.budget.writesConsumed, 0);
  assert.equal(report.writes.length, 0);
  assert.deepEqual(report.finalGates, SAFE_ENV);
});

test("77. checkpoint IMAGE conserva snapshot identico al plan", async () => {
  const setup = await createResumeFixture(
    "IMAGE",
    fakePlanExecution({ imageAction: "IMAGE_REPLACE", priceAction: "PRICE_NO_CHANGE" }),
  );
  const plan = JSON.parse(fs.readFileSync(setup.planFile, "utf8"));
  assert.deepEqual(
    setup.item.approvedSnapshot,
    plan.items[0].domains.IMAGE.snapshot,
  );
});

test("78. resume IMAGE real no repite POST y completa DELETE", async () => {
  const fixture = checkpointFixture("IMAGE", 2);
  fixture.item.approvedSnapshot = imageSnapshot();
  fixture.item.writesConsumed = 1;
  fixture.item.returnedIds = {
    productId: 10,
    oldImageId: 30,
    newImageId: 99,
  };
  fixture.item.substate = "IMAGE_NEW_PRESENT_OLD_NOT_DELETED";
  fixture.checkpoint.writesConsumed = 1;
  fixture.checkpoint.auditLog.push({
    sequence: 1,
    sku: NORMALIZED_SKU,
    domain: "IMAGE",
    method: "POST",
    resource: "/products/10/images",
    httpResult: "SUCCESS",
  });
  let images = [
    { id: 99, position: 1, src: "https://tiendanube.example/new.png" },
    { id: 30, position: 2, src: "https://tiendanube.example/old.png" },
  ];
  let deletes = 0;
  const result = await reconcileImageResume({
    planItem: {
      inputSku: SOURCE_SKU,
      normalizedSku: NORMALIZED_SKU,
      domains: { IMAGE: { snapshot: fixture.item.approvedSnapshot } },
    },
    checkpoint: fixture.checkpoint,
    checkpointItem: fixture.item,
    checkpointFile: fixture.file,
    runtime: {
      adapters: {
        IMAGE: {
          async getProduct() {
            return { id: 10, variants: [{ id: 20, sku: NORMALIZED_SKU }] };
          },
          async listProductImages() { return clone(images); },
          async uploadProductImage() { assert.fail("resume no debe repetir POST"); },
          async deleteProductImage(_productId, imageId) {
            deletes += 1;
            images = images.filter((image) => String(image.id) !== String(imageId));
          },
        },
      },
    },
    currentExecution: fakePlanExecution({
      imageAction: "IMAGE_NO_CHANGE",
      priceAction: "PRICE_NO_CHANGE",
    }),
  });
  assert.equal(result.verified, true);
  assert.equal(result.deleteCompletedOnResume, true);
  assert.equal(deletes, 1);
  assert.equal(fixture.checkpoint.writesConsumed, 2);
  assert.equal(images.some((image) => image.id === 30), false);
});

test("79. final verification IMAGE inconsistente no queda verificada", async () => {
  const fixture = checkpointFixture("IMAGE", 2);
  fixture.item.approvedSnapshot = imageSnapshot();
  fixture.item.writesConsumed = 1;
  fixture.item.returnedIds = { productId: 10, oldImageId: 30, newImageId: 99 };
  fixture.checkpoint.writesConsumed = 1;
  fixture.checkpoint.auditLog.push({
    sequence: 1,
    sku: NORMALIZED_SKU,
    domain: "IMAGE",
    method: "POST",
    resource: "/products/10/images",
    httpResult: "SUCCESS",
  });
  const images = [
    { id: 99, position: 1, src: "https://tiendanube.example/new.png" },
    { id: 30, position: 2, src: "https://tiendanube.example/old.png" },
  ];
  const result = await reconcileImageResume({
    planItem: { inputSku: SOURCE_SKU, normalizedSku: NORMALIZED_SKU },
    checkpoint: fixture.checkpoint,
    checkpointItem: fixture.item,
    checkpointFile: fixture.file,
    runtime: {
      adapters: {
        IMAGE: {
          async getProduct() {
            return { id: 10, variants: [{ id: 20, sku: NORMALIZED_SKU }] };
          },
          async listProductImages() { return clone(images); },
          async uploadProductImage() { assert.fail("resume no debe repetir POST"); },
          async deleteProductImage() {},
        },
      },
    },
    currentExecution: fakePlanExecution({
      imageAction: "IMAGE_NO_CHANGE",
      priceAction: "PRICE_NO_CHANGE",
    }),
  });
  assert.equal(result.verified, false);
  assert.equal(fixture.checkpoint.writesConsumed, 2);
});

async function createResumeFixture(domain, planExecution) {
  const enable = {
    enablePRICE: false,
    enableSTATUS: false,
    enableIMAGE: false,
    enableCREATE: false,
  };
  enable[`enable${domain}`] = true;
  const options = tempOptions({ mode: "PLAN", persist: true, maxWrites: 2, ...enable });
  const dependencies = depsFor(planExecution);
  const report = await runMutableBatch(options, dependencies);
  const loaded = loadCheckpoint(report.checkpointFile);
  return {
    ...loaded,
    planFile: report.planFile,
    item: findCheckpointItem(loaded.checkpoint, NORMALIZED_SKU, domain),
    dependencies,
  };
}

async function main() {
  let passed = 0;
  for (const current of tests) {
    try {
      await current.run();
      passed += 1;
      console.log(`OK ${current.name}`);
    } catch (error) {
      console.error(`FAIL ${current.name}: ${error.stack || error.message}`);
      process.exitCode = 1;
      break;
    }
  }
  console.log(`Mutable batch tests: ${passed}/${tests.length} OK`);
}

if (require.main === module) {
  main();
}

module.exports = { fakePlanExecution, main };
