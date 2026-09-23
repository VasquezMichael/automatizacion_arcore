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
const { runMutableBatch, SAFE_ENV } = require("./mutableBatchRunner");
const {
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
        publications: publications(imageAction),
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
  assert.equal(fixture.item.substate, "IMAGE_NEW_PRESENT_OLD_NOT_DELETED");
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
