const assert = require("assert/strict");
const {
  basePlan,
  clone,
  createPlan,
  match,
  runControlled,
  successfulRevalidation,
} = require("./testExecutor");

const WRITE_ENV = {
  TIENDANUBE_DRY_RUN: "false",
  TIENDANUBE_EXECUTION_ENABLED: "true",
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "true",
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "false",
};

function pairKey(item) {
  return `${item.productId}:${item.variantId}`;
}

function legacyPlan(currentPrices = [100, 110, 120], targetPrice = 150) {
  const items = currentPrices.map((price, index) =>
    match(index + 1, { price: String(price) }),
  );
  const plan = basePlan({ classification: "LEGACY_GROUP" });
  plan.tiendanube = {
    matchCount: items.length,
    productIds: items.map((item) => item.productId),
    variantIds: items.map((item) => item.variantId),
    matches: items,
    legacyGroup: {
      normalizedSku: plan.normalizedSku,
      valid: true,
      expectedMatches: items.length,
      actualMatches: items.length,
      registeredProductIdsCount: items.length,
      registeredVariantIdsCount: items.length,
      issues: [],
    },
  };
  plan.plans.status = {
    action: "STATUS_NO_CHANGE",
    desiredPublished: true,
    publications: items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      published: true,
      desiredPublished: true,
      action: "STATUS_NO_CHANGE",
    })),
  };
  const pricePublications = items.map((item, index) => {
    const currentPrice = currentPrices[index];
    const action = currentPrice === targetPrice ? "PRICE_NO_CHANGE" : "PRICE_UPDATE";
    return {
      productId: item.productId,
      variantId: item.variantId,
      sku: item.sku,
      currentPrice,
      requestedPrice: targetPrice,
      action,
      errors: [],
    };
  });
  plan.plans.price = {
    action: pricePublications.every(
      (publication) => publication.action === "PRICE_NO_CHANGE",
    )
      ? "PRICE_NO_CHANGE"
      : "PRICE_UPDATE",
    calculation: {
      supplierPrice: 100,
      calculatedPrice: targetPrice,
    },
    publications: pricePublications,
    errors: [],
  };
  plan.plans.image = {
    action: "IMAGE_NO_CHANGE",
    sourceImageUrl: plan.supplier.imageUrl,
    sourceHash: "source-hash",
    publications: items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      imageId: 300 + item.productId,
      sourceHash: "source-hash",
      tiendanubeHash: "source-hash",
      action: "IMAGE_NO_CHANGE",
      errors: [],
      warnings: [],
    })),
    errors: [],
    warnings: [],
  };
  return plan;
}

function legacyRevalidation(plan) {
  return {
    ...successfulRevalidation(plan),
    legacyGroup: {
      ok: true,
      expectedMatches: plan.tiendanube.legacyGroup.expectedMatches,
      actualMatches: plan.tiendanube.legacyGroup.expectedMatches,
      registeredProductIdsCount: plan.tiendanube.productIds.length,
      registeredVariantIdsCount: plan.tiendanube.variantIds.length,
      issues: [],
      normalizedSku: plan.normalizedSku,
    },
  };
}

function fakeLegacyAdapter(plan, options = {}) {
  const calls = [];
  const publications = plan.plans.price.publications;
  const records = new Map(
    publications.map((publication) => [
      pairKey(publication),
      {
        productId: publication.productId,
        variantId: publication.variantId,
        sku: plan.normalizedSku,
        price: publication.currentPrice,
      },
    ]),
  );

  for (const [pair, price] of Object.entries(options.preWritePrices || {})) {
    records.get(pair).price = price;
  }

  return {
    calls,
    records,
    adapter: {
      async getProduct(productId) {
        calls.push({ method: "GET_PRODUCT", productId });
        const record = Array.from(records.values()).find(
          (item) => String(item.productId) === String(productId),
        );
        const override = options.identityOverrides?.[pairKey(record || {})] || {};
        return {
          id: override.productId ?? record.productId,
          variants: [
            {
              id: override.variantId ?? record.variantId,
              sku: override.sku ?? record.sku,
              price: record.price,
            },
          ],
        };
      },
      async getProductVariant(productId, variantId) {
        calls.push({ method: "GET_VARIANT", productId, variantId });
        const record = records.get(`${productId}:${variantId}`);
        const override = options.identityOverrides?.[pairKey(record || {})] || {};
        return {
          id: override.variantId ?? record.variantId,
          product_id: override.parentProductId ?? record.productId,
          sku: override.sku ?? record.sku,
          price: record.price,
        };
      },
      async updateVariantPrice(productId, variantId, price) {
        const pair = `${productId}:${variantId}`;
        calls.push({ method: "PUT_PRICE", productId, variantId, payload: { price } });
        if (options.putFailures?.includes(pair)) {
          const error = new Error(`PUT simulado fallo para ${pair}`);
          error.status = 500;
          throw error;
        }
        records.get(pair).price = options.verificationMismatches?.includes(pair)
          ? price - 1
          : price;
        return { id: variantId, price };
      },
    },
  };
}

function priceActions(result) {
  return result.executionPlan.actions.filter((action) => action.type === "PRICE");
}

function putCalls(fake) {
  return fake.calls.filter((call) => call.method === "PUT_PRICE");
}

async function executeLegacy(plan, fake, env = WRITE_ENV, revalidation) {
  return runControlled(plan, revalidation || legacyRevalidation(plan), {
    env,
    priceAdapter: fake.adapter,
  });
}

async function testGates() {
  const cases = [
    ["default", {}],
    ["solo dry-run false", { TIENDANUBE_DRY_RUN: "false" }],
    ["solo execution enabled", { TIENDANUBE_EXECUTION_ENABLED: "true" }],
  ];
  for (const [name, env] of cases) {
    const plan = legacyPlan();
    const fake = fakeLegacyAdapter(plan);
    const result = await executeLegacy(plan, fake, env);
    assert.equal(putCalls(fake).length, 0, name);
    assert.equal(result.result.executionStatus, "SIMULATED", name);
    assert.equal(result.result.writeAttemptedCount, 0, name);
  }
  console.log("OK A-B: LEGACY_GROUP requiere gates globales y PRICE.");
}

async function testValidGroupWritesEligiblePublications() {
  const plan = legacyPlan();
  const fake = fakeLegacyAdapter(plan);
  const result = await executeLegacy(plan, fake);
  assert.equal(putCalls(fake).length, 3);
  assert(putCalls(fake).every((call) => Object.keys(call.payload).join() === "price"));
  assert(priceActions(result).every((action) => action.executionResult === "WRITE_SUCCEEDED"));
  assert.equal(result.result.executionStatus, "SUCCESS");
  assert.equal(result.result.writeAttemptedCount, 3);
  assert.equal(result.result.writeSucceededCount, 3);
  assert.equal(result.result.verifiedCount, 3);
  console.log("OK C-H: grupo valido actualiza y verifica cada publicacion.");
}

async function testInvalidGroupBlocksGlobally() {
  const plan = legacyPlan();
  plan.tiendanube.legacyGroup.valid = false;
  const fake = fakeLegacyAdapter(plan);
  const result = await executeLegacy(plan, fake);
  assert.equal(fake.calls.length, 0);
  assert.equal(result.result.executionStatus, "BLOCKED");
  assert.equal(result.result.writeAttempted, false);
  console.log("OK D: grupo legacy invalido bloquea globalmente.");
}

async function testStructuralChangeBlocksBeforeAdapter() {
  const plan = legacyPlan();
  const revalidation = legacyRevalidation(plan);
  revalidation.legacyGroup.actualMatches += 1;
  const fake = fakeLegacyAdapter(plan);
  const result = await executeLegacy(plan, fake, WRITE_ENV, revalidation);
  assert.equal(fake.calls.length, 0);
  assert.equal(result.result.executionStatus, "BLOCKED");
  assert(result.errors.some((error) => error.code === "LEGACY_GROUP_COUNT_MISMATCH"));
  console.log("OK D2: cambio estructural bloquea antes de consultar el adapter mutable.");
}

async function testInvalidSupplierPriceBlocksWithoutAdapter() {
  const plan = legacyPlan();
  plan.supplier.supplierPrice = 0;
  const fake = fakeLegacyAdapter(plan);
  const result = await executeLegacy(plan, fake);
  assert.equal(fake.calls.length, 0);
  assert.equal(result.result.executionStatus, "BLOCKED");
  assert(result.warnings.some((warning) => warning.code === "ZERO_SUPPLIER_PRICE"));
  console.log("OK D3: precio proveedor invalido bloquea sin consultar el adapter.");
}

async function testAlreadyAppliedPublication() {
  const plan = legacyPlan([100, 110]);
  const firstPair = pairKey(plan.plans.price.publications[0]);
  const fake = fakeLegacyAdapter(plan, { preWritePrices: { [firstPair]: 150 } });
  const result = await executeLegacy(plan, fake);
  assert.equal(putCalls(fake).length, 1);
  assert.equal(priceActions(result)[0].executionResult, "SKIPPED_ALREADY_APPLIED");
  assert.equal(result.result.skippedAlreadyAppliedCount, 1);
  assert.equal(result.result.executionStatus, "SUCCESS");
  console.log("OK E: precio ya aplicado evita PUT para esa publicacion.");
}

async function testUnexpectedPriceBlocksOnlyPublication() {
  const plan = legacyPlan();
  const secondPair = pairKey(plan.plans.price.publications[1]);
  const fake = fakeLegacyAdapter(plan, { preWritePrices: { [secondPair]: 125 } });
  const result = await executeLegacy(plan, fake);
  assert.equal(putCalls(fake).length, 2);
  assert.equal(priceActions(result)[1].executionResult, "BLOCKED");
  assert.equal(priceActions(result)[2].executionResult, "WRITE_SUCCEEDED");
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");
  assert.equal(result.result.blockedCount, 1);
  console.log("OK F: precio inesperado bloquea solo su publicacion.");
}

async function testIdentityFailureStopsRemainingWrites() {
  const plan = legacyPlan();
  const secondPair = pairKey(plan.plans.price.publications[1]);
  const fake = fakeLegacyAdapter(plan, {
    identityOverrides: { [secondPair]: { sku: "SKU-DISTINTO" } },
  });
  const result = await executeLegacy(plan, fake);
  assert.equal(putCalls(fake).length, 1);
  assert.equal(priceActions(result)[1].executionResult, "BLOCKED");
  assert.equal(priceActions(result)[2].executionResult, "BLOCKED");
  assert(result.errors.some((error) => error.code === "GROUP_INTEGRITY_FAILED"));
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");
  console.log("OK G: identidad inconsistente detiene writes restantes.");
}

async function testFirstIdentityFailurePreventsAllWrites() {
  const plan = legacyPlan();
  const firstPair = pairKey(plan.plans.price.publications[0]);
  const fake = fakeLegacyAdapter(plan, {
    identityOverrides: { [firstPair]: { variantId: 999 } },
  });
  const result = await executeLegacy(plan, fake);
  assert.equal(putCalls(fake).length, 0);
  assert(priceActions(result).every((action) => action.executionResult === "BLOCKED"));
  assert.equal(result.result.executionStatus, "BLOCKED");
  console.log("OK G2: fallo de identidad inicial impide todos los PUT.");
}

async function testPutFailureContinues() {
  const plan = legacyPlan();
  const secondPair = pairKey(plan.plans.price.publications[1]);
  const fake = fakeLegacyAdapter(plan, { putFailures: [secondPair] });
  const result = await executeLegacy(plan, fake);
  assert.equal(putCalls(fake).length, 3);
  assert.equal(priceActions(result)[1].executionResult, "WRITE_FAILED");
  assert.equal(priceActions(result)[2].executionResult, "WRITE_SUCCEEDED");
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");
  assert.equal(result.result.failedCount, 1);
  console.log("OK I: fallo de PUT es parcial y no detiene publicaciones independientes.");
}

async function testVerificationFailureContinues() {
  const plan = legacyPlan();
  const secondPair = pairKey(plan.plans.price.publications[1]);
  const fake = fakeLegacyAdapter(plan, { verificationMismatches: [secondPair] });
  const result = await executeLegacy(plan, fake);
  assert.equal(putCalls(fake).length, 3);
  assert.equal(priceActions(result)[1].executionResult, "WRITE_VERIFICATION_FAILED");
  assert.equal(priceActions(result)[2].executionResult, "WRITE_SUCCEEDED");
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");
  assert.equal(result.result.writeSucceededCount, 3);
  assert.equal(result.result.verifiedCount, 2);
  console.log("OK J: verificacion fallida produce PARTIAL_FAILURE y continua.");
}

async function testMixedAggregate() {
  const plan = legacyPlan([150, 110, 120]);
  const failedPair = pairKey(plan.plans.price.publications[2]);
  const fake = fakeLegacyAdapter(plan, { putFailures: [failedPair] });
  const result = await executeLegacy(plan, fake);
  assert.equal(putCalls(fake).length, 2);
  assert.equal(result.result.totalPublications, 3);
  assert.equal(result.result.writeAttemptedCount, 2);
  assert.equal(result.result.writeSucceededCount, 1);
  assert.equal(result.result.skippedAlreadyAppliedCount, 1);
  assert.equal(result.result.failedCount, 1);
  assert.equal(result.result.blockedCount, 0);
  assert.equal(result.result.verifiedCount, 2);
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");
  console.log("OK K: resumen agregado mixto correcto.");
}

async function testSecondExecutionIsIdempotent() {
  const plan = legacyPlan([150, 150, 150]);
  const fake = fakeLegacyAdapter(plan);
  const result = await executeLegacy(plan, fake);
  assert.equal(putCalls(fake).length, 0);
  assert(priceActions(result).every((action) => action.executionResult === "SKIPPED_ALREADY_APPLIED"));
  assert.equal(result.result.executionStatus, "NO_CHANGES");
  assert.equal(result.result.skippedAlreadyAppliedCount, 3);
  assert.equal(result.result.verifiedCount, 3);
  assert.equal(
    fake.calls.filter((call) => call.method === "GET_PRODUCT").length,
    3,
  );
  assert.equal(
    fake.calls.filter((call) => call.method === "GET_VARIANT").length,
    3,
  );
  console.log("OK L: segunda ejecucion idempotente hace 0 PUT.");
}

async function testSingleRegression() {
  const plan = basePlan();
  plan.plans.price.action = "PRICE_UPDATE";
  Object.assign(plan.plans.price.publications[0], {
    action: "PRICE_UPDATE",
    currentPrice: 100,
    requestedPrice: 150,
  });
  const fake = fakeLegacyAdapter(plan);
  const result = await runControlled(plan, successfulRevalidation(plan), {
    env: WRITE_ENV,
    priceAdapter: fake.adapter,
  });
  assert.equal(putCalls(fake).length, 1);
  assert.equal(priceActions(result)[0].executionResult, "WRITE_SUCCEEDED");
  console.log("OK M: SINGLE conserva su camino de escritura.");
}

async function testOtherDomainsRemainWithoutWrites() {
  const plan = legacyPlan([100, 150]);
  plan.plans.status.action = "UNPUBLISH";
  plan.plans.status.publications.forEach((publication) => {
    publication.action = "UNPUBLISH";
    publication.desiredPublished = false;
  });
  plan.plans.image.action = "IMAGE_REPLACE";
  plan.plans.image.publications.forEach((publication) => {
    publication.action = "IMAGE_REPLACE";
  });
  const fake = fakeLegacyAdapter(plan);
  const statusCalls = [];
  const result = await runControlled(plan, legacyRevalidation(plan), {
    env: {
      ...WRITE_ENV,
      TIENDANUBE_STATUS_EXECUTION_ENABLED: "true",
    },
    priceAdapter: fake.adapter,
    statusAdapter: {
      async getProduct(productId) {
        statusCalls.push({ method: "GET_PRODUCT", productId });
        throw new Error("STATUS LEGACY_GROUP no debe acceder al adapter.");
      },
      async updateProductPublished(productId, published) {
        statusCalls.push({ method: "PUT_STATUS", productId, published });
        throw new Error("STATUS LEGACY_GROUP no debe ejecutar PUT.");
      },
    },
  });
  assert.equal(putCalls(fake).length, 1);
  assert.equal(statusCalls.length, 0);
  assert.deepEqual(putCalls(fake)[0].payload, { price: 150 });
  assert(
    result.executionPlan.actions
      .filter((action) => ["STATUS", "IMAGE"].includes(action.type))
      .every((action) => action.executionResult === "SIMULATED"),
  );

  const creation = createPlan();
  const createFake = fakeLegacyAdapter(legacyPlan());
  const createResult = await runControlled(
    creation,
    {
      ok: true,
      status: "STILL_ABSENT",
      issues: [],
      matches: [],
      plans: clone(creation.plans),
    },
    { env: WRITE_ENV, priceAdapter: createFake.adapter },
  );
  assert.equal(putCalls(createFake).length, 0);
  assert.equal(
    createResult.executionPlan.actions.find((action) => action.type === "CREATE_PRODUCT")
      .executionResult,
    "SIMULATED",
  );
  console.log("OK N: CREATE_SINGLE, STATUS LEGACY_GROUP e IMAGE siguen sin writes.");
}

async function main() {
  await testGates();
  await testValidGroupWritesEligiblePublications();
  await testInvalidGroupBlocksGlobally();
  await testStructuralChangeBlocksBeforeAdapter();
  await testInvalidSupplierPriceBlocksWithoutAdapter();
  await testAlreadyAppliedPublication();
  await testUnexpectedPriceBlocksOnlyPublication();
  await testIdentityFailureStopsRemainingWrites();
  await testFirstIdentityFailurePreventsAllWrites();
  await testPutFailureContinues();
  await testVerificationFailureContinues();
  await testMixedAggregate();
  await testSecondExecutionIsIdempotent();
  await testSingleRegression();
  await testOtherDomainsRemainWithoutWrites();
  console.log("Resultado: OK. Casos A-N cubiertos con adaptadores mock.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test PRICE LEGACY_GROUP: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  fakeLegacyAdapter,
  legacyPlan,
  legacyRevalidation,
  main,
  putCalls,
};
