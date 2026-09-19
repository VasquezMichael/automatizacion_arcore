const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ArcoreCatalogSource } = require("./arcoreCatalogSource");
const { persistCatalogRun } = require("./catalogOutput");
const { CATALOG_MODE, runCatalog, validateRunnerOptions } = require("./catalogRunner");

const FIXED_NOW = new Date("2026-09-18T12:00:00.000Z");

function article(index, overrides = {}) {
  return {
    id: `id-${index}`,
    codComercial: `SKU-${index}`,
    codigo: `internal-${index}`,
    marcaId: "MK",
    supermedida: false,
    ...overrides,
  };
}

function pageResult(page, items, { totalPages = 1, pageSize = 12, total } = {}) {
  return {
    page,
    items,
    total: total ?? items.length,
    totalPages,
    pageSize,
    httpStatus: 200,
    contentType: "application/json",
    attempts: 1,
    retries: 0,
    timestamp: `2026-09-18T12:00:${String(page).padStart(2, "0")}.000Z`,
  };
}

class FakeCatalogSource {
  constructor(pages, options = {}) {
    this.pages = pages;
    this.options = options;
    this.readCalls = [];
    this.healthCalls = 0;
    this.openCalls = 0;
    this.closeCalls = 0;
    this.metrics = { requestCount: 0, reauthCount: 0, contextsOpened: 1, healthChecks: 0 };
  }

  async open() {
    this.openCalls += 1;
  }

  async close() {
    this.closeCalls += 1;
  }

  async healthCheck() {
    this.healthCalls += 1;
    this.metrics.healthChecks += 1;
    const sequence = this.options.healthSequence || [];
    const selected = sequence[this.healthCalls - 1] || this.options.health || {
      total: Object.values(this.pages).reduce(
        (count, page) => count + (Array.isArray(page?.items) ? page.items.length : 0),
        0,
      ),
      totalPages: Math.max(...Object.keys(this.pages).map(Number)) + 1,
      pageSize: 12,
    };
    return { status: "VALID", httpStatus: 200, checkedAt: new Date().toISOString(), ...selected };
  }

  async readPage(page) {
    this.readCalls.push(page);
    this.metrics.requestCount += 1;
    const value = this.pages[page];
    if (value instanceof Error) throw value;
    if (!value) throw Object.assign(new Error(`missing page ${page}`), { code: "MISSING_PAGE" });
    return value;
  }

  async extractProduct(sourceSku) {
    return { sourceSku };
  }
}

async function withTempRun(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-runner-"));
  try {
    return await callback({
      tempDir,
      checkpointDir: path.join(tempDir, "checkpoints"),
      outputDir: path.join(tempDir, "runs"),
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function execute(source, options = {}, dependencies = {}) {
  return withTempRun(({ checkpointDir, outputDir }) =>
    runCatalog({
      mode: options.mode || CATALOG_MODE.SCAN_ONLY,
      options: {
        runId: options.runId || "catalog-test",
        now: FIXED_NOW,
        checkpointDir,
        outputDir,
        maxPages: options.maxPages ?? 5,
        startPage: options.startPage,
        maxItems: options.maxItems,
        healthCheckEveryPages: options.healthCheckEveryPages || 100,
        persist: options.persist ?? true,
      },
      dependencies: { source, ...dependencies },
    }),
  );
}

async function testPagesAndValidation() {
  const one = new FakeCatalogSource({
    0: pageResult(0, [article(1), article(2)], { totalPages: 1, total: 2 }),
  });
  const oneResult = await execute(one);
  assert.equal(oneResult.metadata.status, "COMPLETE");
  assert.equal(oneResult.summary.pageCount, 1);
  assert.equal(oneResult.summary.uniqueSkuCount, 2);

  const multiplePages = {
    0: pageResult(0, [article(1)], { totalPages: 3, total: 3 }),
    1: pageResult(1, [article(2)], { totalPages: 3, total: 3 }),
    2: pageResult(2, [article(3)], { totalPages: 3, total: 3 }),
  };
  const multiple = await execute(new FakeCatalogSource(multiplePages));
  assert.equal(multiple.summary.pageCount, 3);
  assert.deepEqual(multiple.skus.map((item) => item.codComercial), ["SKU-1", "SKU-2", "SKU-3"]);

  const empty = await execute(
    new FakeCatalogSource({ 0: pageResult(0, [], { totalPages: 2, total: 2 }) }),
  );
  assert.equal(empty.metadata.status, "PAUSED");
  assert.equal(empty.errors[0].code, "CATALOG_UNEXPECTED_EMPTY_PAGE");

  const invalid = await execute(
    new FakeCatalogSource({
      0: pageResult(0, [article(1, { codComercial: null })], { totalPages: 1 }),
    }),
  );
  assert.equal(invalid.summary.invalidItemCount, 1);
  assert.equal(invalid.summary.uniqueSkuCount, 0);
  console.log("OK 1-4: una pagina, multiples, vacia e item sin codComercial.");
}

async function testDuplicatesAndPaginationChanges() {
  const duplicatePages = {
    0: pageResult(0, [article(1, { codComercial: "SKU X" })], { totalPages: 2, total: 2 }),
    1: pageResult(1, [article(2, { codComercial: "sku-x" })], { totalPages: 2, total: 2 }),
  };
  const duplicate = await execute(new FakeCatalogSource(duplicatePages));
  assert.equal(duplicate.summary.duplicateSkuCount, 1);
  assert.deepEqual(duplicate.duplicates[0].pages, [0, 1]);
  assert.deepEqual(duplicate.duplicates[0].ids, ["id-1", "id-2"]);

  const repeatedIdPages = {
    0: pageResult(0, [article(1)], { totalPages: 2, total: 2 }),
    1: pageResult(1, [article(1, { codComercial: "SKU-OTHER" })], { totalPages: 2, total: 2 }),
  };
  const repeated = await execute(new FakeCatalogSource(repeatedIdPages));
  assert.equal(repeated.summary.repeatedIdCount, 1);
  assert(repeated.warnings.some((warning) => warning.code === "CATALOG_ID_REPEATED"));

  const stable = await execute(
    new FakeCatalogSource({ 0: pageResult(0, [article(1)], { totalPages: 1 }) }),
  );
  assert.equal(stable.warnings.some((warning) => /PAGINATION/.test(warning.code)), false);

  const expanded = await execute(
    new FakeCatalogSource(
      {
        0: pageResult(0, [article(1)], { totalPages: 2, total: 2 }),
        1: pageResult(1, [article(2)], { totalPages: 2, total: 2 }),
      },
      { healthSequence: [{ total: 1, totalPages: 1, pageSize: 12 }, { total: 2, totalPages: 2, pageSize: 12 }] },
    ),
  );
  assert(expanded.warnings.some((warning) => warning.code === "CATALOG_PAGINATION_EXPANDED"));

  const expandedAtFinal = await execute(
    new FakeCatalogSource(
      { 0: pageResult(0, [article(1)], { totalPages: 1, total: 1 }) },
      {
        healthSequence: [
          { total: 1, totalPages: 1, pageSize: 12 },
          { total: 2, totalPages: 2, pageSize: 12 },
        ],
      },
    ),
  );
  assert.equal(expandedAtFinal.metadata.status, "LIMIT_REACHED");
  assert.equal(expandedAtFinal.checkpoint.nextPage, 1);

  const reduced = await execute(
    new FakeCatalogSource(
      { 0: pageResult(0, [article(1)], { totalPages: 1, total: 1 }) },
      { healthSequence: [{ total: 2, totalPages: 2, pageSize: 12 }, { total: 1, totalPages: 1, pageSize: 12 }] },
    ),
  );
  assert(reduced.warnings.some((warning) => warning.code === "CATALOG_PAGINATION_REDUCED"));

  const sizeChanged = await execute(
    new FakeCatalogSource(
      { 0: pageResult(0, [article(1)], { totalPages: 1, pageSize: 24 }) },
      { health: { total: 1, totalPages: 1, pageSize: 12 } },
    ),
  );
  assert.equal(sizeChanged.metadata.status, "PAUSED");
  assert.equal(sizeChanged.errors[0].code, "CATALOG_PAGE_SIZE_CHANGED");
  console.log("OK 5-10: duplicados, ids repetidos y cambios de paginacion.");
}

async function testCheckpointAndResume() {
  await withTempRun(async ({ checkpointDir, outputDir }) => {
    const pages = {
      0: pageResult(0, [article(1)], { totalPages: 4, total: 4 }),
      1: pageResult(1, [article(2)], { totalPages: 4, total: 4 }),
      2: pageResult(2, [article(3)], { totalPages: 4, total: 4 }),
      3: pageResult(3, [article(4)], { totalPages: 4, total: 4 }),
    };
    const firstSource = new FakeCatalogSource(pages);
    const first = await runCatalog({
      options: {
        runId: "resume-test",
        now: FIXED_NOW,
        checkpointDir,
        outputDir,
        maxPages: 2,
      },
      dependencies: { source: firstSource },
    });
    assert.equal(fs.existsSync(first.checkpoint.file), true);
    const checkpoint = JSON.parse(fs.readFileSync(first.checkpoint.file, "utf8"));
    assert.equal(checkpoint.nextPage, 2);
    assert.equal(checkpoint.lastCompletedPage, 1);
    assert.equal(checkpoint.processedUniqueSkuCount, 2);

    const resumedSource = new FakeCatalogSource(pages);
    const resumed = await runCatalog({
      options: {
        resume: first.checkpoint.file,
        checkpointDir,
        outputDir,
        maxPages: 2,
      },
      dependencies: { source: resumedSource },
    });
    assert.deepEqual(resumedSource.readCalls, [2, 3]);
    assert.equal(resumed.metadata.resumed, true);
    assert.equal(resumed.metadata.status, "COMPLETE");
    assert.equal(resumed.summary.uniqueSkuCount, 4);
    assert.deepEqual(resumed.skus.map((item) => item.codComercial), ["SKU-1", "SKU-2", "SKU-3", "SKU-4"]);
  });
  console.log("OK 11-13: checkpoint, resume y paginas completadas no reprocesadas.");
}

function response(status, payload = null) {
  return {
    status,
    url: status === 302 ? "https://clientes.arcore.com/auth/login" : "https://clientes.arcore.com/api/articulos",
    contentType: payload ? "application/json" : "text/plain",
    payload,
  };
}

function successfulPayload() {
  return { data: [article(1)], total: 1, pages: 1, pageSize: 12 };
}

async function testRetriesAndSessionRecovery() {
  for (const scenario of [
    { name: "timeout", first: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
    { name: "429", first: response(429) },
    { name: "500", first: response(500) },
  ]) {
    const sequence = [scenario.first, response(200, successfulPayload())];
    const waits = [];
    const source = new ArcoreCatalogSource({
      requestPage: async () => {
        const next = sequence.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      sleepFn: async (ms) => waits.push(ms),
      backoffMs: [1, 2],
    });
    const result = await source.readPage(0);
    assert.equal(result.attempts, 2, scenario.name);
    assert.deepEqual(waits, [1], scenario.name);
  }

  let reauthenticated = false;
  const authSequence = [response(401), response(200, successfulPayload())];
  const recovered = new ArcoreCatalogSource({
    requestPage: async () => authSequence.shift(),
    reauthenticate: async () => { reauthenticated = true; },
    sleepFn: async () => {},
  });
  const recoveredPage = await recovered.readPage(0);
  assert.equal(reauthenticated, true);
  assert.equal(recoveredPage.attempts, 2);

  const failedReauth = new ArcoreCatalogSource({
    requestPage: async () => response(401),
    reauthenticate: async () => { throw new Error("login failed"); },
  });
  await assert.rejects(
    () => failedReauth.readPage(0),
    (error) => error.code === "ARCORE_REAUTH_FAILED",
  );

  const exhausted = new ArcoreCatalogSource({
    requestPage: async () => response(500),
    sleepFn: async () => {},
    backoffMs: [1, 2],
  });
  await assert.rejects(
    () => exhausted.readPage(0),
    (error) => error.code === "CATALOG_PAGE_RETRIES_EXHAUSTED" && error.attempts === 3,
  );
  console.log("OK 14-19: retries timeout/429/500, reauth y maximo de intentos.");
}

async function testFailureLimitsAndModes() {
  await withTempRun(async ({ checkpointDir, outputDir }) => {
    const failure = Object.assign(new Error("server down"), {
      code: "CATALOG_PAGE_RETRIES_EXHAUSTED",
      attempts: 3,
      retries: 2,
    });
    const source = new FakeCatalogSource({
      0: pageResult(0, [article(1)], { totalPages: 2, total: 2 }),
      1: failure,
    });
    const result = await runCatalog({
      options: { runId: "failure", now: FIXED_NOW, checkpointDir, outputDir, maxPages: 5 },
      dependencies: { source },
    });
    assert.equal(result.metadata.status, "PAUSED");
    assert.equal(result.checkpoint.nextPage, 1);
    assert.equal(JSON.parse(fs.readFileSync(result.checkpoint.file, "utf8")).pendingErrors.length, 1);
  });

  const pages = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [
      index,
      pageResult(index, [article(index)], { totalPages: 5, total: 5 }),
    ]),
  );
  const limitedSource = new FakeCatalogSource(pages);
  const limited = await execute(limitedSource, { maxPages: 2 });
  assert.equal(limited.metadata.status, "LIMIT_REACHED");
  assert.deepEqual(limitedSource.readCalls, [0, 1]);

  let plannedSkus = null;
  const planSource = new FakeCatalogSource({
    0: pageResult(0, [article(1), article(2), article(3)], { totalPages: 1, total: 3 }),
  });
  const planned = await execute(
    planSource,
    { mode: CATALOG_MODE.PLAN_BATCH, maxItems: 2 },
    {
      planBatch: async ({ skus, maxItems }) => {
        plannedSkus = skus.slice(0, maxItems);
        return {
          outputFile: "mock-batch.json",
          metadata: { mode: "READ_ONLY", writesAllowed: false },
          summary: { processedCount: plannedSkus.length },
        };
      },
    },
  );
  assert.equal(plannedSkus.length, 2);
  assert.equal(planned.batch.metadata.writesAllowed, false);

  const startSource = new FakeCatalogSource(pages);
  const started = await execute(startSource, { startPage: 3, maxPages: 1 });
  assert.deepEqual(startSource.readCalls, [3]);
  assert.equal(started.skus[0].page, 3);

  let scanBatchCalled = false;
  await execute(new FakeCatalogSource({ 0: pageResult(0, [article(1)]) }), {}, {
    planBatch: async () => { scanBatchCalled = true; },
  });
  assert.equal(scanBatchCalled, false);
  assert.equal(planned.batch.summary.processedCount, 2);
  console.log("OK 20-26: pausa reanudable, limites, start-page y modos SCAN/PLAN read-only.");
}

async function testOrderDedupOutputAndFullGuard() {
  const source = new FakeCatalogSource({
    0: pageResult(
      0,
      [
        article(3, { codComercial: "C" }),
        article(1, { codComercial: "A" }),
        article(2, { codComercial: "B" }),
        article(4, { codComercial: "a" }),
      ],
      { totalPages: 1, total: 4 },
    ),
  });
  const result = await execute(source);
  assert.deepEqual(result.skus.map((item) => item.codComercial), ["C", "A", "B"]);
  assert.equal(result.summary.duplicateSkuCount, 1);

  await withTempRun(async ({ outputDir }) => {
    const unsafe = {
      metadata: { runId: "safe-output", token: "fixture" },
      errors: [{ message: "Authorization: demo cookie=demo" }],
    };
    const outputFile = persistCatalogRun(unsafe, outputDir);
    const text = fs.readFileSync(outputFile, "utf8");
    assert.equal(text.includes("fixture"), false);
    assert.equal(text.includes("Authorization: demo"), false);
    assert.doesNotThrow(() => JSON.parse(text));
  });

  assert.throws(
    () => validateRunnerOptions(CATALOG_MODE.SCAN_ONLY, { maxPages: null, full: false }),
    (error) => error.code === "CATALOG_FULL_FLAG_REQUIRED",
  );
  assert.equal(validateRunnerOptions(CATALOG_MODE.SCAN_ONLY, { full: true }).maxPages, null);
  console.log("OK 27-30: orden, deduplicacion, output seguro y full requiere flag.");
}

async function main() {
  await testPagesAndValidation();
  await testDuplicatesAndPaginationChanges();
  await testCheckpointAndResume();
  await testRetriesAndSessionRecovery();
  await testFailureLimitsAndModes();
  await testOrderDedupOutputAndFullGuard();
  console.log("Resultado: OK. Catalog runner cubre los 30 escenarios controlados.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test catalogo: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
