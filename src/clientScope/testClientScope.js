const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeSku } = require("../tiendanube/sku");
const { loadClientScope, validateClientScope } = require("./clientScope");
const { persistClientScopeReport } = require("./clientScopeOutput");
const { runClientScope } = require("./clientScopeRunner");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fakeBatch(skus) {
  return {
    metadata: {
      batchId: "client-scope-test",
      mode: "READ_ONLY",
      concurrency: 1,
      writesAllowed: false,
      itemOrder: skus.map(normalizeSku),
    },
    summary: {
      inputCount: skus.length,
      uniqueSkuCount: skus.length,
      duplicateInputCount: 0,
      processedCount: skus.length,
      succeededCount: skus.length,
      blockedCount: 0,
      failedCount: 0,
      manualReviewCount: 0,
      classifications: { SINGLE: skus.length, LEGACY_GROUP: 0, CREATE_SINGLE: 0, MANUAL_REVIEW: 0 },
      supplierResolutions: { EXACT: skus.length, SAFE_TRANSFORM: 0, NOT_FOUND: 0, AMBIGUOUS: 0 },
    },
    items: skus.map((sourceSku) => ({
      inputSku: sourceSku,
      normalizedSku: normalizeSku(sourceSku),
      matchedCode: normalizeSku(sourceSku),
      supplierResolution: { type: "EXACT" },
      classification: "SINGLE",
      availability: "AVAILABLE",
      tiendanube: { matchCount: 1, legacyGroup: null },
      status: "SUCCEEDED",
      requiresManualReview: false,
      result: { writeAttempted: false, readOnly: true },
      plans: { status: null, price: null, image: null, create: null },
      warnings: [],
      errors: [],
    })),
  };
}

function testScopeSource() {
  const loaded = loadClientScope();
  assert.equal(loaded.scope.items.length, 85);
  assert.equal(loaded.summary.totalPublicationRows, 176);
  assert.equal(loaded.summary.rowsWithSku, 171);
  assert.equal(loaded.summary.rowsWithoutSku, 5);
  assert.equal(loaded.summary.duplicateAppearanceCount, 86);
  assert.equal(new Set(loaded.scope.items.map((item) => item.normalizedSku)).size, 85);
  assert.ok(loaded.scope.items.every((item) => item.normalizedSku));
  assert.ok(
    loaded.scope.items.every((item) => normalizeSku(item.sourceSku) === item.normalizedSku),
  );
  assert.ok(
    loaded.scope.items.every((item) => item.occurrenceCount === item.publicationIds.length),
  );
  console.log("OK 1-6: carga, conteos, deduplicacion, occurrences y normalizacion.");
}

function testPreservationAndMissingRows() {
  const { scope } = loadClientScope();
  const rare = ["415 0768 09 0", "415 0549 10 0", "628 3585 09 0", "24046020"];
  for (const sourceSku of rare) {
    assert.equal(scope.items.some((item) => item.sourceSku === sourceSku), true);
  }
  assert.equal(scope.missingSkuRows.count, 5);
  assert.equal(scope.missingSkuRows.referencesComplete, false);
  assert.equal(scope.items.some((item) => !item.sourceSku), false);
  assert.deepEqual(
    scope.items.slice(0, 3).map((item) => item.sourceSku),
    ["415 0768 09", "415 0322 10", "500 1568 10"],
  );
  console.log("OK 7-10: SKU raros, filas sin SKU separadas, sin inferencia y orden estable.");
}

function testValidationFailures() {
  const { scope } = loadClientScope();
  const duplicate = clone(scope);
  duplicate.items[1].normalizedSku = duplicate.items[0].normalizedSku;
  duplicate.items[1].sourceSku = duplicate.items[0].sourceSku;
  assert.throws(
    () => validateClientScope(duplicate),
    (error) => error.code === "CLIENT_SCOPE_DUPLICATE_NORMALIZED_SKU",
  );
  const occurrence = clone(scope);
  occurrence.items[0].occurrenceCount += 1;
  assert.throws(
    () => validateClientScope(occurrence),
    (error) => error.code === "CLIENT_SCOPE_OCCURRENCE_MISMATCH",
  );
  console.log("OK 11-12: duplicados y occurrenceCount inconsistentes se rechazan.");
}

async function testReadOnlyRunnerAndSerialization() {
  let received = null;
  const report = await runClientScope(
    { persist: false, runId: "client-scope-test", now: new Date("2026-09-22T00:00:00Z") },
    {
      runBatchSync: async (input) => {
        received = input;
        return fakeBatch(input.skus);
      },
    },
  );
  assert.equal(received.mode, "READ_ONLY");
  assert.equal(received.options.concurrency, 1);
  assert.equal(received.skus.length, 85);
  assert.equal(new Set(received.skus.map(normalizeSku)).size, 85);
  assert.equal(report.items.length, 85);
  assert.deepEqual(report.clientVsTiendanubeSummary, {
    CLIENT_MULTIPLE_TIENDANUBE_SINGLE: 85,
  });
  assert.deepEqual(report.functionalProblems, {});
  assert.deepEqual(report.availabilitySummary, { AVAILABLE: 85 });
  assert.deepEqual(report.tiendanubeSummary, {
    single: 85,
    legacyGroup: 0,
    createSingle: 0,
    manualReview: 0,
    confirmedNoMatch: 0,
    multipleMatchesNotWhitelisted: 0,
  });
  assert.deepEqual(report.plannedActions.create, { NOT_APPLICABLE: 85 });
  assert.equal(report.security.writeAttempted, 0);
  assert.equal(Object.values(report.security).some((value) => value === true), false);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-scope-output-"));
  try {
    report.metadata.token = "fixture-secret";
    const outputFile = persistClientScopeReport(report, tempDir);
    const serialized = fs.readFileSync(outputFile, "utf8");
    const parsed = JSON.parse(serialized);
    assert.equal(serialized.includes("fixture-secret"), false);
    assert.equal(parsed.items.length, 85);
    assert.equal(parsed.missingSkuRows.count, 5);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log("OK 13-16: runner recibe 85, READ_ONLY, cero writes y salida sanitizada.");
}

async function main() {
  testScopeSource();
  testPreservationAndMissingRows();
  testValidationFailures();
  await testReadOnlyRunnerAndSerialization();
  console.log("Resultado: OK. Client scope cubre los 16 escenarios controlados.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test client scope: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
