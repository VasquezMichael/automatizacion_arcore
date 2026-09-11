const assert = require("assert/strict");
const {
  basePlan,
  clone,
  createPlan,
  runControlled,
  successfulRevalidation,
} = require("./testExecutor");
const {
  fakePriceAdapter,
  putCalls: pricePutCalls,
} = require("./testSinglePriceExecution");
const { createTiendanubeStatusAdapter } = require("./tiendanubeStatusAdapter");

const WRITE_ENV = {
  TIENDANUBE_DRY_RUN: "false",
  TIENDANUBE_EXECUTION_ENABLED: "true",
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "false",
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "true",
};

const ALL_DOMAIN_WRITE_ENV = {
  ...WRITE_ENV,
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "true",
};

function statusUpdatePlan(availability = "AVAILABLE") {
  const targetPublished = availability !== "UNAVAILABLE";
  const currentPublished = !targetPublished;
  const action = targetPublished ? "PUBLISH" : "UNPUBLISH";
  const plan = basePlan();
  plan.supplier.availability = availability;
  plan.tiendanube.matches[0].published = currentPublished;
  plan.plans.status = {
    action,
    desiredPublished: targetPublished,
    publications: [
      {
        productId: 101,
        variantId: 201,
        published: currentPublished,
        desiredPublished: targetPublished,
        action,
      },
    ],
  };
  return plan;
}

function fakeStatusAdapter({
  preWritePublished,
  verifiedPublished,
  productId = 101,
  variantId = 201,
  sku = "415 0000 10",
  verifiedProductId = productId,
  verifiedVariantId = variantId,
  verifiedSku = sku,
  updateError = null,
} = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    adapter: {
      async getProduct(requestedProductId) {
        reads += 1;
        calls.push({ method: "GET_PRODUCT", productId: requestedProductId });
        const verification = reads > 1;
        return {
          id: verification ? verifiedProductId : productId,
          published: verification ? verifiedPublished : preWritePublished,
          variants: [
            {
              id: verification ? verifiedVariantId : variantId,
              sku: verification ? verifiedSku : sku,
            },
          ],
        };
      },
      async updateProductPublished(requestedProductId, published) {
        calls.push({
          method: "PUT_STATUS",
          productId: requestedProductId,
          payload: { published },
        });
        if (updateError) throw updateError;
        return { id: requestedProductId, published };
      },
    },
  };
}

function statusAction(result) {
  return result.executionPlan.actions.find((action) => action.type === "STATUS");
}

function statusPutCalls(fake) {
  return fake.calls.filter((call) => call.method === "PUT_STATUS");
}

async function executeStatus(plan, fake, options = {}) {
  return runControlled(plan, successfulRevalidation(plan), {
    env: options.env || WRITE_ENV,
    statusAdapter: fake.adapter,
    ...(options.priceAdapter ? { priceAdapter: options.priceAdapter } : {}),
  });
}

async function testWriteGates() {
  const cases = [
    ["defaults", {}],
    ["solo dry-run false", { TIENDANUBE_DRY_RUN: "false" }],
    ["solo execution enabled", { TIENDANUBE_EXECUTION_ENABLED: "true" }],
  ];
  for (const [name, env] of cases) {
    const plan = statusUpdatePlan();
    const fake = fakeStatusAdapter({
      preWritePublished: false,
      verifiedPublished: true,
    });
    const result = await executeStatus(plan, fake, { env });
    assert.equal(statusPutCalls(fake).length, 0, name);
    assert.equal(statusAction(result).executionResult, "SIMULATED", name);
    assert.equal(result.writeOperationsAvailable, false, name);
  }
  console.log("OK A-C: los gates globales incompletos no habilitan STATUS.");
}

async function testAvailabilityMappings() {
  const cases = [
    ["AVAILABLE", false, true],
    ["PARTIAL", false, true],
    ["UNAVAILABLE", true, false],
  ];
  for (const [availability, current, target] of cases) {
    const plan = statusUpdatePlan(availability);
    const fake = fakeStatusAdapter({
      preWritePublished: current,
      verifiedPublished: target,
    });
    const result = await executeStatus(plan, fake);
    assert.deepEqual(statusPutCalls(fake), [
      { method: "PUT_STATUS", productId: 101, payload: { published: target } },
    ]);
    assert.equal(statusAction(result).executionResult, "WRITE_SUCCEEDED");
    assert.equal(result.result.executionStatus, "SUCCESS");
  }
  console.log("OK D-F/M: mapping STATUS y verificacion posterior correctos.");
}

async function testUnknownBlocksOnlyStatus() {
  const plan = statusUpdatePlan();
  plan.supplier.availability = "UNKNOWN";
  plan.plans.status.action = "STATUS_UNKNOWN";
  Object.assign(plan.plans.status.publications[0], {
    action: "STATUS_UNKNOWN",
    desiredPublished: null,
  });
  plan.plans.price.action = "PRICE_UPDATE";
  Object.assign(plan.plans.price.publications[0], {
    action: "PRICE_UPDATE",
    currentPrice: 100,
    requestedPrice: 150,
  });
  const statusFake = fakeStatusAdapter();
  const priceFake = fakePriceAdapter();
  const result = await executeStatus(plan, statusFake, {
    env: ALL_DOMAIN_WRITE_ENV,
    priceAdapter: priceFake.adapter,
  });
  assert.equal(statusPutCalls(statusFake).length, 0);
  assert.equal(pricePutCalls(priceFake).length, 1);
  assert.equal(statusAction(result).executionResult, "BLOCKED");
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");
  console.log("OK G/P: UNKNOWN bloquea STATUS y PRICE valido continua.");
}

async function testAlreadyAppliedCases() {
  const noChangePlan = basePlan();
  const noChangeFake = fakeStatusAdapter();
  const noChange = await executeStatus(noChangePlan, noChangeFake);
  assert.equal(noChangeFake.calls.length, 0);
  assert.equal(statusAction(noChange).executionResult, "SKIPPED_ALREADY_APPLIED");

  const changedPlan = statusUpdatePlan();
  const changedFake = fakeStatusAdapter({
    preWritePublished: true,
    verifiedPublished: true,
  });
  const changed = await executeStatus(changedPlan, changedFake);
  assert.equal(statusPutCalls(changedFake).length, 0);
  assert.equal(statusAction(changed).executionResult, "SKIPPED_ALREADY_APPLIED");
  assert.equal(changed.result.executionStatus, "NO_CHANGES");
  console.log("OK H-I: estado ya aplicado evita PUT de forma idempotente.");
}

async function testUnexpectedStateBlocksStatus() {
  const plan = statusUpdatePlan();
  const fake = fakeStatusAdapter({
    preWritePublished: null,
    verifiedPublished: true,
  });
  const result = await executeStatus(plan, fake);
  assert.equal(statusPutCalls(fake).length, 0);
  assert.equal(statusAction(result).executionResult, "BLOCKED");
  assert.equal(result.result.executionStatus, "BLOCKED");
  assert(statusAction(result).errors.some(
    (error) => error.code === "STATUS_PREWRITE_STATE_CHANGED",
  ));
  console.log("OK J: published inesperado bloquea STATUS sin PUT.");
}

async function testIdentityChangesBlockGlobally() {
  const cases = [
    { sku: "OTRO-SKU" },
    { productId: 999 },
    { variantId: 999 },
  ];
  for (const options of cases) {
    const plan = statusUpdatePlan();
    plan.plans.price.action = "PRICE_UPDATE";
    Object.assign(plan.plans.price.publications[0], {
      action: "PRICE_UPDATE",
      currentPrice: 100,
      requestedPrice: 150,
    });
    const statusFake = fakeStatusAdapter({
      preWritePublished: false,
      verifiedPublished: true,
      ...options,
    });
    const priceFake = fakePriceAdapter();
    const result = await executeStatus(plan, statusFake, {
      env: ALL_DOMAIN_WRITE_ENV,
      priceAdapter: priceFake.adapter,
    });
    assert.equal(statusPutCalls(statusFake).length, 0);
    assert.equal(pricePutCalls(priceFake).length, 0);
    assert.equal(statusAction(result).executionResult, "BLOCKED");
    assert.equal(result.result.executionStatus, "BLOCKED");
  }
  console.log("OK K-L: identidad/SKU inconsistentes bloquean todas las escrituras.");
}

async function testVerificationMismatch() {
  const plan = statusUpdatePlan();
  const fake = fakeStatusAdapter({
    preWritePublished: false,
    verifiedPublished: false,
  });
  const result = await executeStatus(plan, fake);
  const action = statusAction(result);
  assert.equal(statusPutCalls(fake).length, 1);
  assert.equal(action.executionResult, "WRITE_VERIFICATION_FAILED");
  assert.equal(action.writeAttempted, true);
  assert.equal(action.writeSucceeded, true);
  assert.equal(action.verified, false);
  assert.equal(action.updated, false);
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");
  console.log("OK N: GET posterior no coincidente queda trazado.");
}

async function testPutFailure() {
  const error = new Error("PUT STATUS simulado fallo");
  error.status = 500;
  const plan = statusUpdatePlan();
  const fake = fakeStatusAdapter({
    preWritePublished: false,
    verifiedPublished: true,
    updateError: error,
  });
  const result = await executeStatus(plan, fake);
  const action = statusAction(result);
  assert.equal(statusPutCalls(fake).length, 1);
  assert.equal(action.executionResult, "WRITE_FAILED");
  assert.equal(action.writeAttempted, true);
  assert.equal(action.writeSucceeded, false);
  assert.equal(action.verified, false);
  assert.equal(result.result.executionStatus, "FAILED");
  console.log("OK O: fallo de PUT STATUS queda trazado.");
}

async function testInvalidPriceDoesNotBlockStatus() {
  const plan = statusUpdatePlan();
  plan.supplier.supplierPrice = null;
  plan.plans.price = {
    action: "INVALID_SUPPLIER_PRICE",
    calculation: null,
    publications: [],
    errors: [{ code: "INVALID_SUPPLIER_PRICE", message: "Precio invalido." }],
  };
  plan.errors = clone(plan.plans.price.errors);
  const fake = fakeStatusAdapter({
    preWritePublished: false,
    verifiedPublished: true,
  });
  const result = await executeStatus(plan, fake);
  assert.equal(statusPutCalls(fake).length, 1);
  assert.equal(statusAction(result).executionResult, "WRITE_SUCCEEDED");
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");
  console.log("OK Q: precio invalido no bloquea STATUS valido.");
}

async function testMixedDomainFailureIsPartial() {
  const plan = statusUpdatePlan();
  plan.plans.price.action = "PRICE_UPDATE";
  Object.assign(plan.plans.price.publications[0], {
    action: "PRICE_UPDATE",
    currentPrice: 100,
    requestedPrice: 150,
  });
  const statusFake = fakeStatusAdapter({
    preWritePublished: false,
    verifiedPublished: true,
  });
  const error = new Error("PUT PRICE simulado fallo");
  error.status = 500;
  const priceFake = fakePriceAdapter({ updateError: error });
  const result = await executeStatus(plan, statusFake, {
    env: ALL_DOMAIN_WRITE_ENV,
    priceAdapter: priceFake.adapter,
  });
  assert.equal(statusAction(result).executionResult, "WRITE_SUCCEEDED");
  assert.equal(
    result.executionPlan.actions.find((action) => action.type === "PRICE")
      .executionResult,
    "WRITE_FAILED",
  );
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");
  console.log("OK resumen: un write confirmado y otro fallido -> PARTIAL_FAILURE.");
}

async function testUnsupportedDomainsRemainWithoutStatusWrites() {
  const legacy = statusUpdatePlan();
  legacy.classification = "LEGACY_GROUP";
  legacy.tiendanube.legacyGroup = { valid: false, expectedMatches: 2 };
  const legacyFake = fakeStatusAdapter();
  const legacyResult = await runControlled(
    legacy,
    { ok: false, status: "FAILED", issues: [] },
    { env: WRITE_ENV, statusAdapter: legacyFake.adapter },
  );
  assert.equal(statusPutCalls(legacyFake).length, 0);
  assert.equal(legacyResult.result.executionStatus, "BLOCKED");

  const creation = createPlan();
  const creationFake = fakeStatusAdapter();
  const creationResult = await runControlled(
    creation,
    {
      ok: true,
      status: "STILL_ABSENT",
      issues: [],
      matches: [],
      plans: clone(creation.plans),
    },
    { env: WRITE_ENV, statusAdapter: creationFake.adapter },
  );
  assert.equal(statusPutCalls(creationFake).length, 0);
  assert.equal(
    creationResult.executionPlan.actions.find((action) => action.type === "CREATE_PRODUCT")
      .executionResult,
    "SIMULATED",
  );
  console.log("OK R-S: LEGACY_GROUP invalido y CREATE_SINGLE no escriben STATUS.");
}

async function testImageRemainsSimulation() {
  const noSourcePlan = statusUpdatePlan();
  noSourcePlan.supplier.imageUrl = null;
  noSourcePlan.plans.image = {
    action: "NO_SOURCE_IMAGE",
    sourceImageUrl: null,
    sourceHash: null,
    publications: [],
    errors: [],
    warnings: [{ code: "NO_SOURCE_IMAGE" }],
  };
  const noSourceFake = fakeStatusAdapter({
    preWritePublished: false,
    verifiedPublished: true,
  });
  const noSourceResult = await executeStatus(noSourcePlan, noSourceFake);
  assert.equal(statusPutCalls(noSourceFake).length, 1);
  assert.equal(
    noSourceResult.executionPlan.actions.find((action) => action.type === "IMAGE")
      .executionResult,
    "SIMULATED",
  );

  const replacePlan = statusUpdatePlan();
  replacePlan.plans.image.action = "IMAGE_REPLACE";
  replacePlan.plans.image.publications[0].action = "IMAGE_REPLACE";
  const replaceFake = fakeStatusAdapter({
    preWritePublished: false,
    verifiedPublished: true,
  });
  const replaceResult = await executeStatus(replacePlan, replaceFake);
  assert.equal(statusPutCalls(replaceFake).length, 1);
  assert.equal(
    replaceResult.executionPlan.actions.find((action) => action.type === "IMAGE")
      .executionResult,
    "SIMULATED",
  );
  console.log("OK T: NO_SOURCE_IMAGE no bloquea STATUS e IMAGE sigue sin writes.");
}

async function testMutableAdapterPayload() {
  const calls = [];
  const client = {
    async getProduct(productId) {
      return { status: 200, data: { id: productId } };
    },
    async updateProduct(productId, payload) {
      calls.push({ productId, payload });
      return { status: 200, data: { id: productId, ...payload } };
    },
  };
  const adapter = createTiendanubeStatusAdapter(client);
  await adapter.updateProductPublished(101, true);
  assert.deepEqual(calls, [{ productId: 101, payload: { published: true } }]);
  await assert.rejects(
    () => adapter.updateProductPublished(101, "true"),
    (error) => error.code === "INVALID_PUBLISHED_VALUE",
  );
  assert.equal(adapter.updateProductVariant, undefined);
  console.log("OK payload: adapter STATUS envia exclusivamente { published }.");
}

async function main() {
  await testWriteGates();
  await testAvailabilityMappings();
  await testUnknownBlocksOnlyStatus();
  await testAlreadyAppliedCases();
  await testUnexpectedStateBlocksStatus();
  await testIdentityChangesBlockGlobally();
  await testVerificationMismatch();
  await testPutFailure();
  await testInvalidPriceDoesNotBlockStatus();
  await testMixedDomainFailureIsPartial();
  await testUnsupportedDomainsRemainWithoutStatusWrites();
  await testImageRemainsSimulation();
  await testMutableAdapterPayload();
  console.log("Resultado: OK. Casos A-T cubiertos con adaptadores mock.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test STATUS SINGLE: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  fakeStatusAdapter,
  main,
  statusPutCalls,
  statusUpdatePlan,
};
