const assert = require("assert/strict");
const {
  basePlan,
  clone,
  createPlan,
  runControlled,
  successfulRevalidation,
} = require("./testExecutor");
const { createTiendanubePriceAdapter } = require("./tiendanubePriceAdapter");

const WRITE_ENV = {
  TIENDANUBE_DRY_RUN: "false",
  TIENDANUBE_EXECUTION_ENABLED: "true",
};

function priceUpdatePlan() {
  const plan = basePlan();
  plan.plans.price.action = "PRICE_UPDATE";
  Object.assign(plan.plans.price.publications[0], {
    action: "PRICE_UPDATE",
    currentPrice: 100,
    requestedPrice: 150,
  });
  return plan;
}

function fakePriceAdapter({
  preWritePrice = 100,
  verifiedPrice = 150,
  sku = "415 0000 10",
  productId = 101,
  variantId = 201,
  variantProductId = productId,
  updateError = null,
} = {}) {
  const calls = [];
  let variantReads = 0;
  return {
    calls,
    adapter: {
      async getProduct(requestedProductId) {
        calls.push({ method: "GET_PRODUCT", productId: requestedProductId });
        return {
          id: productId,
          variants: [{ id: variantId, sku, price: preWritePrice }],
        };
      },
      async getProductVariant(requestedProductId, requestedVariantId) {
        variantReads += 1;
        calls.push({
          method: "GET_VARIANT",
          productId: requestedProductId,
          variantId: requestedVariantId,
        });
        return {
          id: variantId,
          product_id: variantProductId,
          sku,
          price: variantReads === 1 ? preWritePrice : verifiedPrice,
        };
      },
      async updateVariantPrice(requestedProductId, requestedVariantId, price) {
        calls.push({
          method: "PUT_PRICE",
          productId: requestedProductId,
          variantId: requestedVariantId,
          payload: { price },
        });
        if (updateError) throw updateError;
        return { id: requestedVariantId, price };
      },
    },
  };
}

function priceAction(result) {
  return result.executionPlan.actions.find((action) => action.type === "PRICE");
}

function putCalls(fake) {
  return fake.calls.filter((call) => call.method === "PUT_PRICE");
}

async function executePrice(plan, fake, env = WRITE_ENV) {
  return runControlled(plan, successfulRevalidation(plan), {
    env,
    priceAdapter: fake.adapter,
  });
}

async function testWriteGates() {
  const cases = [
    ["defaults", {}],
    ["solo dry-run false", { TIENDANUBE_DRY_RUN: "false" }],
    ["solo execution enabled", { TIENDANUBE_EXECUTION_ENABLED: "true" }],
  ];
  for (const [name, env] of cases) {
    const fake = fakePriceAdapter();
    const result = await executePrice(priceUpdatePlan(), fake, env);
    assert.equal(putCalls(fake).length, 0, name);
    assert.equal(priceAction(result).executionResult, "SIMULATED", name);
    assert.equal(result.result.writeAttempted, false, name);
    assert.equal(result.writeOperationsAvailable, false, name);
  }
  console.log("OK A-C: ambos gates son obligatorios.");
}

async function testBothGatesInvokeAdapter() {
  const fake = fakePriceAdapter();
  const result = await executePrice(priceUpdatePlan(), fake);
  assert.equal(putCalls(fake).length, 1);
  assert.deepEqual(putCalls(fake)[0].payload, { price: 150 });
  assert.equal(priceAction(result).executionResult, "WRITE_SUCCEEDED");
  assert.equal(result.writeOperationsAvailable, true);
  console.log("OK D: ambos gates habilitan solo el adaptador de precio.");
}

async function testMutableAdapterPayload() {
  const calls = [];
  const client = {
    async getProduct(productId) {
      return { status: 200, data: { id: productId } };
    },
    async getProductVariant(productId, variantId) {
      return { status: 200, data: { id: variantId, product_id: productId } };
    },
    async updateProductVariant(productId, variantId, payload) {
      calls.push({ productId, variantId, payload });
      return { status: 200, data: { id: variantId, ...payload } };
    },
  };
  const adapter = createTiendanubePriceAdapter(client);
  await adapter.updateVariantPrice(101, 201, 150);
  assert.deepEqual(calls, [
    { productId: 101, variantId: 201, payload: { price: 150 } },
  ]);
  assert.equal(adapter.updateProduct, undefined);
  console.log("OK D2: el adapter mutable envia exclusivamente { price }.");
}

async function testUnsupportedClassificationsRemainSimulation() {
  const creation = createPlan();
  const creationFake = fakePriceAdapter();
  const creationResult = await runControlled(
    creation,
    {
      ok: true,
      status: "STILL_ABSENT",
      issues: [],
      matches: [],
      plans: clone(creation.plans),
    },
    { env: WRITE_ENV, priceAdapter: creationFake.adapter },
  );
  assert.equal(putCalls(creationFake).length, 0);
  assert.equal(creationResult.writeOperationsAvailable, false);
  assert.equal(
    creationResult.executionPlan.actions.find((action) => action.type === "CREATE_PRODUCT")
      .executionResult,
    "SIMULATED",
  );
  console.log("OK F: CREATE_SINGLE sigue simulado.");
}

async function testPriceNoChangeDoesNotWrite() {
  const plan = basePlan();
  const fake = fakePriceAdapter();
  const result = await executePrice(plan, fake);
  assert.equal(fake.calls.length, 0);
  assert.equal(priceAction(result).executionResult, "SKIPPED_ALREADY_APPLIED");
  console.log("OK G: PRICE_NO_CHANGE no hace PUT ni GET mutable.");
}

async function testInvalidPriceInputsBlockPrice() {
  const cases = [
    { supplierPrice: null },
    { calculatedPrice: 150.5 },
  ];
  for (const changes of cases) {
    const plan = priceUpdatePlan();
    if (Object.hasOwn(changes, "supplierPrice")) {
      plan.supplier.supplierPrice = changes.supplierPrice;
    }
    if (Object.hasOwn(changes, "calculatedPrice")) {
      plan.plans.price.calculation.calculatedPrice = changes.calculatedPrice;
      plan.plans.price.publications[0].requestedPrice = changes.calculatedPrice;
    }
    const fake = fakePriceAdapter();
    const result = await executePrice(plan, fake);
    assert.equal(putCalls(fake).length, 0);
    assert.equal(priceAction(result).executionResult, "BLOCKED");
  }
  console.log("OK G3: precios proveedor/final invalidos bloquean solo PRICE.");
}

async function testStatusAndImageRemainSimulation() {
  const plan = priceUpdatePlan();
  Object.assign(plan.plans.status.publications[0], {
    action: "PUBLISH",
    published: false,
    desiredPublished: true,
  });
  plan.plans.status.action = "PUBLISH";
  Object.assign(plan.plans.image.publications[0], {
    action: "IMAGE_REPLACE",
    imageId: 999,
  });
  plan.plans.image.action = "IMAGE_REPLACE";
  const fake = fakePriceAdapter();
  const result = await executePrice(plan, fake);
  assert.equal(putCalls(fake).length, 1);
  assert.equal(
    result.executionPlan.actions.find((action) => action.type === "STATUS")
      .executionResult,
    "SIMULATED",
  );
  assert.equal(
    result.executionPlan.actions.find((action) => action.type === "IMAGE")
      .executionResult,
    "SIMULATED",
  );
  console.log("OK G2: STATUS e IMAGE permanecen simulados con ambos gates.");
}

async function testAlreadyAppliedImmediatelyBeforePut() {
  const fake = fakePriceAdapter({ preWritePrice: 150 });
  const result = await executePrice(priceUpdatePlan(), fake);
  assert.equal(putCalls(fake).length, 0);
  assert.equal(priceAction(result).executionResult, "SKIPPED_ALREADY_APPLIED");
  assert.equal(result.result.writeAttempted, false);
  console.log("OK H: precio objetivo detectado antes del PUT -> ALREADY_APPLIED.");
}

async function testSkuChangedBlocksPrice() {
  const fake = fakePriceAdapter({ sku: "OTRO-SKU" });
  const result = await executePrice(priceUpdatePlan(), fake);
  assert.equal(putCalls(fake).length, 0);
  assert.equal(priceAction(result).executionResult, "BLOCKED");
  assert.equal(result.result.executionStatus, "BLOCKED");
  console.log("OK I: cambio de SKU bloquea precio.");
}

async function testIdMismatchBlocksPrice() {
  for (const options of [{ productId: 999 }, { variantId: 999 }, { variantProductId: 999 }]) {
    const fake = fakePriceAdapter(options);
    const result = await executePrice(priceUpdatePlan(), fake);
    assert.equal(putCalls(fake).length, 0);
    assert.equal(priceAction(result).executionResult, "BLOCKED");
  }
  console.log("OK J: inconsistencias de productId/variantId bloquean precio.");
}

async function testVerifiedWrite() {
  const fake = fakePriceAdapter();
  const result = await executePrice(priceUpdatePlan(), fake);
  const action = priceAction(result);
  assert.equal(action.executionResult, "WRITE_SUCCEEDED");
  assert.equal(action.writeAttempted, true);
  assert.equal(action.writeSucceeded, true);
  assert.equal(action.verified, true);
  assert.equal(action.updated, true);
  assert.equal(result.result.executionStatus, "SUCCESS");
  console.log("OK K: PUT exitoso y GET coincidente -> WRITE_SUCCEEDED.");
}

async function testVerificationMismatch() {
  const fake = fakePriceAdapter({ verifiedPrice: 149 });
  const result = await executePrice(priceUpdatePlan(), fake);
  const action = priceAction(result);
  assert.equal(action.executionResult, "WRITE_VERIFICATION_FAILED");
  assert.equal(action.writeAttempted, true);
  assert.equal(action.writeSucceeded, true);
  assert.equal(action.verified, false);
  assert.equal(action.updated, false);
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");
  console.log("OK L: GET no confirma precio -> WRITE_VERIFICATION_FAILED.");
}

async function testPutFailure() {
  const error = new Error("PUT simulado fallo");
  error.status = 500;
  const fake = fakePriceAdapter({ updateError: error });
  const result = await executePrice(priceUpdatePlan(), fake);
  const action = priceAction(result);
  assert.equal(action.executionResult, "WRITE_FAILED");
  assert.equal(action.writeAttempted, true);
  assert.equal(action.writeSucceeded, false);
  assert.equal(action.verified, false);
  assert.equal(action.updated, false);
  assert.equal(result.result.executionStatus, "FAILED");
  console.log("OK M: fallo de PUT queda aislado en PRICE.");
}

async function main() {
  await testWriteGates();
  await testBothGatesInvokeAdapter();
  await testMutableAdapterPayload();
  await testUnsupportedClassificationsRemainSimulation();
  await testPriceNoChangeDoesNotWrite();
  await testInvalidPriceInputsBlockPrice();
  await testStatusAndImageRemainSimulation();
  await testAlreadyAppliedImmediatelyBeforePut();
  await testSkuChangedBlocksPrice();
  await testIdMismatchBlocksPrice();
  await testVerifiedWrite();
  await testVerificationMismatch();
  await testPutFailure();
  console.log("Resultado: OK. Casos A-M cubiertos con adaptadores mock.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test de escritura PRICE SINGLE: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
