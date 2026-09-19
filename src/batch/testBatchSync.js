const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeSku } = require("../tiendanube/sku");
const {
  BatchInputError,
  parseBatchCliArgs,
  prepareBatchInput,
  readSkuFile,
} = require("./batchInput");
const { persistBatchResult, sanitizeBatchOutput } = require("./batchOutput");
const {
  BatchFatalError,
  FORCED_READ_ONLY_ENV,
  MAX_CONCURRENCY,
  runBatchSync,
} = require("./batchSync");

const FIXED_NOW = new Date("2026-09-18T12:00:00.000Z");
const FIXED_OPTIONS = {
  batchId: "batch-test",
  now: FIXED_NOW,
  completedAt: "2026-09-18T12:01:00.000Z",
};

function publication(action, index = 1) {
  return {
    productId: 100 + index,
    variantId: 200 + index,
    action,
  };
}

function definition(overrides = {}) {
  return {
    classification: "SINGLE",
    resolution: "EXACT",
    matchedCode: "SKU1",
    availability: "AVAILABLE",
    matchCount: 1,
    statusActions: ["STATUS_NO_CHANGE"],
    priceActions: ["PRICE_NO_CHANGE"],
    imageActions: ["IMAGE_NO_CHANGE"],
    executionStatus: "NO_CHANGES",
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function planGroup(actions, fallbackAction) {
  return {
    action: fallbackAction || actions[0],
    publications: actions.map((action, index) => publication(action, index + 1)),
    errors: [],
    warnings: [],
  };
}

function fakeExecution(sourceSku, item = definition()) {
  const normalizedSku = normalizeSku(sourceSku);
  const isCreate = item.classification === "CREATE_SINGLE";
  const isManual = item.classification === "MANUAL_REVIEW";
  const statusPlan = isManual
    ? null
    : isCreate
      ? { action: "STATUS_FOR_CREATION", desiredPublished: true, publications: [] }
      : planGroup(item.statusActions);
  const pricePlan = isManual
    ? null
    : isCreate
      ? {
          action: "PRICE_FOR_CREATION",
          calculation: { supplierPrice: 100, calculatedPrice: 150 },
          publications: [],
          errors: [],
        }
      : planGroup(item.priceActions);
  const imagePlan = isManual
    ? null
    : isCreate
      ? {
          action: "IMAGE_FOR_CREATION",
          sourceImageUrl: "https://www.arcore.com/catalogoWeb/imagenes/test.png",
          publications: [],
          errors: [],
          warnings: [],
        }
      : planGroup(item.imageActions);
  const executionStatus = isManual ? "BLOCKED" : item.executionStatus;
  const createAction = isCreate
    ? {
        type: "CREATE_PRODUCT",
        plannedAction: "CREATE_SINGLE",
        simulationResult: item.createBlocked ? "BLOCKED" : "WOULD_CREATE",
      }
    : null;

  return {
    executionId: `execution-${normalizedSku}`,
    sourceSku,
    normalizedSku,
    matchedCode: item.matchedCode,
    supplierResolution: {
      type: item.resolution,
      sourceCode: normalizedSku,
      matchedCode: item.matchedCode,
      rule: item.resolution === "SAFE_TRANSFORM" ? "APPEND_TRAILING_ZERO" : null,
    },
    classification: item.classification,
    originalPlan: {
      supplier: { availability: item.availability },
      tiendanube: {
        matchCount: item.matchCount,
        legacyGroup:
          item.classification === "LEGACY_GROUP"
            ? { valid: true, expectedMatches: 2, actualMatches: 2 }
            : null,
      },
      plans: { status: statusPlan, price: pricePlan, image: imagePlan },
    },
    revalidation: {
      ok: !isManual,
      status: isManual ? "NOT_RUN" : "PASSED",
      issues: [],
    },
    executionPlan: {
      actions: [
        { type: "REVALIDATE", simulationResult: isManual ? "BLOCKED" : "SIMULATED" },
        ...(createAction ? [createAction] : []),
        { type: "FINAL_VERIFY", simulationResult: isManual ? "BLOCKED" : "NOT_RUN_SIMULATION" },
      ],
    },
    result: {
      executionStatus,
      wouldWrite: isCreate && !item.createBlocked ? 1 : 0,
      blockedActions: isManual || item.createBlocked ? 1 : 0,
      failedActions: executionStatus === "FAILED" ? 1 : 0,
      writeAttempted: false,
    },
    warnings: item.warnings,
    errors: item.errors,
    dryRun: true,
    executionEnabled: false,
    globalWriteRequested: false,
    priceWriteRequested: false,
    statusWriteRequested: false,
    imageWriteRequested: false,
    createWriteRequested: false,
    writeOperationsAvailable: false,
    writeOperationsAvailableByDomain: {
      price: false,
      status: false,
      image: false,
      create: false,
    },
  };
}

function fakeDependencies(definitions = {}, tracker = {}) {
  return {
    initialize: async () => {
      tracker.initializeCount = (tracker.initializeCount || 0) + 1;
      return { client: Object.freeze({ readOnly: true }) };
    },
    executeSyncPlan: async (sourceSku, dependencies) => {
      tracker.calls = tracker.calls || [];
      tracker.calls.push({ sourceSku, dependencies });
      assert.deepEqual(dependencies.env, FORCED_READ_ONLY_ENV);
      assert.equal(dependencies.persist, false);
      assert.equal("priceAdapter" in dependencies, false);
      assert.equal("statusAdapter" in dependencies, false);
      assert.equal("imageAdapter" in dependencies, false);
      assert.equal("createAdapter" in dependencies, false);
      const selected = definitions[normalizeSku(sourceSku)] || definition();
      if (selected.throwError) throw selected.throwError;
      if (selected.delayMs) await new Promise((resolve) => setTimeout(resolve, selected.delayMs));
      return fakeExecution(sourceSku, selected);
    },
  };
}

async function run(skus, definitions = {}, options = {}, tracker = {}) {
  return runBatchSync({
    skus,
    dependencies: fakeDependencies(definitions, tracker),
    options: { ...FIXED_OPTIONS, ...options },
  });
}

function testInputValidationAndFiles() {
  assert.throws(() => prepareBatchInput(null), (error) => error.code === "BATCH_INPUT_NOT_ARRAY");
  assert.throws(
    () => prepareBatchInput(["OK", ""]),
    (error) => error.code === "BATCH_INPUT_INVALID_SKU",
  );

  const input = prepareBatchInput(["415 0549 10", "415054910", "ABC-1"]);
  assert.equal(input.inputCount, 3);
  assert.equal(input.uniqueSkuCount, 2);
  assert.equal(input.duplicateInputCount, 1);
  assert.deepEqual(
    input.items.map((item) => item.normalizedSku),
    ["415054910", "abc1"],
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-input-"));
  try {
    const jsonFile = path.join(tempDir, "skus.json");
    const textFile = path.join(tempDir, "skus.txt");
    fs.writeFileSync(jsonFile, JSON.stringify(["A", "B"]));
    fs.writeFileSync(textFile, "# comentario\nA\n\nB\n");
    assert.deepEqual(readSkuFile(jsonFile), ["A", "B"]);
    assert.deepEqual(readSkuFile(textFile), ["A", "B"]);
    assert.deepEqual(parseBatchCliArgs(["--file", textFile, "--concurrency", "2"]), {
      skus: ["A", "B"],
      concurrency: 2,
      filePath: textFile,
    });
    assert.deepEqual(parseBatchCliArgs(["A,B"]), {
      skus: ["A", "B"],
      concurrency: 1,
      filePath: null,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log("OK 1-5: input, archivos, normalizacion y deduplicacion.");
}

async function testEmptySingleAndMultiple() {
  let initialized = false;
  const empty = await runBatchSync({
    skus: [],
    dependencies: { initialize: async () => { initialized = true; } },
    options: FIXED_OPTIONS,
  });
  assert.equal(initialized, false);
  assert.equal(empty.summary.processedCount, 0);

  const single = await run(["SKU1"]);
  assert.equal(single.summary.processedCount, 1);
  assert.equal(single.items[0].status, "SUCCEEDED");

  const multiple = await run(["SKU1", "SKU2", "SKU3"]);
  assert.equal(multiple.summary.processedCount, 3);
  assert.equal(multiple.metadata.concurrency, 1);
  assert.deepEqual(multiple.metadata.itemOrder, ["sku1", "sku2", "sku3"]);
  console.log("OK 6-8: lista vacia, un SKU y multiples SKUs.");
}

async function testClassificationsAndResolutions() {
  const definitions = {
    single: definition({ classification: "SINGLE", resolution: "EXACT" }),
    legacy: definition({
      classification: "LEGACY_GROUP",
      resolution: "SAFE_TRANSFORM",
      matchCount: 2,
      statusActions: ["PUBLISH", "STATUS_NO_CHANGE"],
      priceActions: ["PRICE_UPDATE", "PRICE_NO_CHANGE"],
      imageActions: ["IMAGE_REPLACE", "NO_SOURCE_IMAGE"],
      executionStatus: "SIMULATED",
      warnings: [{ code: "ARCORE_SAFE_TRANSFORM_USED", message: "Transformacion segura." }],
    }),
    create: definition({
      classification: "CREATE_SINGLE",
      resolution: "EXACT",
      matchCount: 0,
      executionStatus: "SIMULATED",
    }),
    notfound: definition({
      classification: "MANUAL_REVIEW",
      resolution: "NOT_FOUND",
      matchedCode: null,
      matchCount: 0,
      errors: [{ code: "ARCORE_PRODUCT_NOT_FOUND", message: "No encontrado." }],
    }),
    ambiguous: definition({
      classification: "MANUAL_REVIEW",
      resolution: "AMBIGUOUS",
      matchedCode: null,
      matchCount: 0,
      errors: [{ code: "ARCORE_PRODUCT_AMBIGUOUS", message: "Ambiguo." }],
    }),
  };
  const batch = await run(Object.keys(definitions), definitions);
  assert.equal(batch.summary.classifications.SINGLE, 1);
  assert.equal(batch.summary.classifications.LEGACY_GROUP, 1);
  assert.equal(batch.summary.classifications.CREATE_SINGLE, 1);
  assert.equal(batch.summary.classifications.MANUAL_REVIEW, 2);
  assert.equal(batch.summary.supplierResolutions.EXACT, 2);
  assert.equal(batch.summary.supplierResolutions.SAFE_TRANSFORM, 1);
  assert.equal(batch.summary.supplierResolutions.NOT_FOUND, 1);
  assert.equal(batch.summary.supplierResolutions.AMBIGUOUS, 1);
  assert.equal(batch.summary.manualReviewCount, 2);
  assert.equal(batch.summary.warningCodes.ARCORE_SAFE_TRANSFORM_USED, 1);
  assert.equal(batch.summary.errorCodes.ARCORE_PRODUCT_NOT_FOUND, 1);
  assert.equal(batch.summary.errorCodes.ARCORE_PRODUCT_AMBIGUOUS, 1);
  assert.deepEqual(
    batch.summary.manualReviewItems.map((item) => item.normalizedSku),
    ["notfound", "ambiguous"],
  );
  console.log("OK 9-15: clasificaciones, EXACT, SAFE_TRANSFORM, NOT_FOUND y AMBIGUOUS.");
}

async function testActionSummary() {
  const definitions = {
    actions: definition({
      classification: "LEGACY_GROUP",
      matchCount: 2,
      statusActions: ["PUBLISH", "UNPUBLISH", "STATUS_NO_CHANGE", "STATUS_UNKNOWN"],
      priceActions: ["PRICE_UPDATE", "PRICE_NO_CHANGE", "PRICE_WRITE_BLOCKED"],
      imageActions: [
        "IMAGE_REPLACE",
        "IMAGE_CREATE",
        "IMAGE_NO_CHANGE",
        "NO_SOURCE_IMAGE",
        "IMAGE_DOWNLOAD_FAILED",
      ],
      executionStatus: "SIMULATED_WITH_BLOCKS",
    }),
    create: definition({ classification: "CREATE_SINGLE", matchCount: 0, executionStatus: "SIMULATED" }),
  };
  const batch = await run(["actions", "create"], definitions);
  assert.deepEqual(batch.summary.statusActions, {
    publish: 1,
    unpublish: 1,
    noChange: 1,
    blocked: 1,
    notApplicable: 1,
    total: 5,
  });
  assert.deepEqual(batch.summary.priceActions, {
    update: 1,
    noChange: 1,
    blocked: 1,
    notApplicable: 1,
    total: 4,
  });
  assert.deepEqual(batch.summary.imageActions, {
    replace: 1,
    create: 1,
    noChange: 1,
    noSourceImage: 1,
    blocked: 1,
    notApplicable: 1,
    total: 6,
  });
  assert.deepEqual(batch.summary.createActions, {
    createSingle: 1,
    notApplicable: 1,
    blocked: 0,
    total: 2,
  });
  console.log("OK 16-20: conteos STATUS, PRICE, IMAGE, CREATE y bloques locales.");
}

async function testIsolationAndFatalErrors() {
  const tracker = {};
  const definitions = {
    ok1: definition(),
    fail: { throwError: Object.assign(new Error("network unavailable"), { code: "NETWORK_ERROR" }) },
    ok2: definition({ resolution: "SAFE_TRANSFORM" }),
  };
  const batch = await run(["ok1", "fail", "ok2"], definitions, {}, tracker);
  assert.equal(batch.summary.processedCount, 3);
  assert.equal(batch.summary.succeededCount, 2);
  assert.equal(batch.summary.failedCount, 1);
  assert.equal(batch.items[1].errors[0].stage, "EXECUTION");
  assert.equal(batch.items[2].normalizedSku, "ok2");

  await assert.rejects(
    () =>
      runBatchSync({
        skus: ["SKU"],
        dependencies: { initialize: async () => { throw new Error("bad config"); } },
      }),
    (error) => error.code === "BATCH_INITIALIZATION_FAILED",
  );
  await assert.rejects(
    () => runBatchSync({ skus: ["SKU"], mode: "WRITE", dependencies: fakeDependencies() }),
    (error) => error.code === "BATCH_MODE_NOT_ALLOWED",
  );
  console.log("OK 21-23: error por item, fatal global y modo writable rechazado.");
}

async function testConcurrencyOrderAndReadOnlyInvariant() {
  const active = { current: 0, maximum: 0 };
  const definitions = {
    slow: definition({ delayMs: 30 }),
    fast: definition({ delayMs: 1 }),
    medium: definition({ delayMs: 10 }),
  };
  const dependencies = fakeDependencies(definitions);
  const originalExecute = dependencies.executeSyncPlan;
  dependencies.executeSyncPlan = async (...args) => {
    active.current += 1;
    active.maximum = Math.max(active.maximum, active.current);
    try {
      return await originalExecute(...args);
    } finally {
      active.current -= 1;
    }
  };
  const concurrent = await runBatchSync({
    skus: ["slow", "fast", "medium"],
    dependencies,
    options: { ...FIXED_OPTIONS, concurrency: 2 },
  });
  assert.equal(active.maximum, 2);
  assert.deepEqual(concurrent.items.map((item) => item.inputSku), ["slow", "fast", "medium"]);
  await assert.rejects(
    () => runBatchSync({ skus: [], options: { concurrency: MAX_CONCURRENCY + 1 } }),
    (error) => error instanceof BatchFatalError && error.code === "BATCH_CONCURRENCY_INVALID",
  );

  const unsafe = fakeExecution("unsafe");
  unsafe.createWriteRequested = true;
  await assert.rejects(
    () =>
      runBatchSync({
        skus: ["unsafe"],
        dependencies: {
          initialize: async () => ({}),
          executeSyncPlan: async () => unsafe,
        },
      }),
    (error) => error.code === "BATCH_READ_ONLY_INVARIANT_VIOLATION",
  );
  console.log("OK 24-26: concurrencia acotada, orden deterministico e invariante read-only.");
}

async function testExternalGatesAndReproducibility() {
  const names = Object.keys(FORCED_READ_ONLY_ENV);
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = "true";
    const tracker = {};
    const first = await run(["A", "A", "B"], {}, {}, tracker);
    const second = await run(["A", "A", "B"]);
    assert.equal(tracker.calls.length, 2);
    assert.equal(first.input.duplicateInputCount, 1);
    assert.deepEqual(first, second);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
  console.log("OK 27-28: gates externos ignorados y resultado reproducible.");
}

async function testSanitizedSerializableOutput() {
  const batch = await run(["SKU"]);
  batch.metadata.token = "fixture-value";
  batch.items[0].errors.push({
    code: "SAFE_ERROR",
    message: "Authorization: demo cookie=demo",
  });
  const sanitized = sanitizeBatchOutput(batch);
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes("fixture-value"), false);
  assert.equal(serialized.includes("Authorization: demo"), false);
  assert.equal(serialized.includes("cookie=demo"), false);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-output-"));
  try {
    const outputFile = persistBatchResult(batch, tempDir);
    const parsed = JSON.parse(fs.readFileSync(outputFile, "utf8"));
    assert.equal(parsed.metadata.batchId, "batch-test");
    assert.equal(Array.isArray(parsed.items), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log("OK 29-30: output sanitizado, persistible y JSON serializable.");
}

async function main() {
  testInputValidationAndFiles();
  await testEmptySingleAndMultiple();
  await testClassificationsAndResolutions();
  await testActionSummary();
  await testIsolationAndFatalErrors();
  await testConcurrencyOrderAndReadOnlyInvariant();
  await testExternalGatesAndReproducibility();
  await testSanitizedSerializableOutput();
  console.log("Resultado: OK. Batch read-only cubre los 30 escenarios controlados.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test batch: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
