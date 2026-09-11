const assert = require("assert/strict");
const { readExecutionGates } = require("./executionGuards");
const {
  basePlan,
  clone,
  createPlan,
  runControlled,
  successfulRevalidation,
} = require("./testExecutor");
const {
  fakeLegacyAdapter,
  fakeLegacyStatusAdapter,
  legacyPlan,
  legacyRevalidation,
  putCalls: legacyPricePutCalls,
} = require("./testLegacyPriceExecution");
const {
  fakePriceAdapter,
  putCalls: pricePutCalls,
} = require("./testSinglePriceExecution");
const {
  fakeStatusAdapter,
  statusPutCalls,
  statusUpdatePlan,
} = require("./testSingleStatusExecution");

const GLOBAL_OPEN_ENV = {
  TIENDANUBE_DRY_RUN: "false",
  TIENDANUBE_EXECUTION_ENABLED: "true",
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "false",
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "false",
};

function domainEnv({ price = false, status = false } = {}) {
  return {
    ...GLOBAL_OPEN_ENV,
    TIENDANUBE_PRICE_EXECUTION_ENABLED: String(price),
    TIENDANUBE_STATUS_EXECUTION_ENABLED: String(status),
  };
}

function dualUpdatePlan() {
  const plan = statusUpdatePlan("AVAILABLE");
  plan.plans.price.action = "PRICE_UPDATE";
  Object.assign(plan.plans.price.publications[0], {
    action: "PRICE_UPDATE",
    currentPrice: 100,
    requestedPrice: 150,
  });
  return plan;
}

function action(result, type) {
  return result.executionPlan.actions.find((item) => item.type === type);
}

async function runDual(env) {
  const plan = dualUpdatePlan();
  const priceFake = fakePriceAdapter();
  const statusFake = fakeStatusAdapter({
    preWritePublished: false,
    verifiedPublished: true,
  });
  const result = await runControlled(plan, successfulRevalidation(plan), {
    env,
    priceAdapter: priceFake.adapter,
    statusAdapter: statusFake.adapter,
  });
  return { result, priceFake, statusFake };
}

function assertNoWrites(run, name) {
  assert.equal(pricePutCalls(run.priceFake).length, 0, `${name}: PRICE`);
  assert.equal(statusPutCalls(run.statusFake).length, 0, `${name}: STATUS`);
  assert.equal(run.priceFake.calls.length, 0, `${name}: adapter PRICE`);
  assert.equal(run.statusFake.calls.length, 0, `${name}: adapter STATUS`);
  assert.equal(run.result.result.writeAttempted, false, name);
}

async function testDefaultsAndGlobalGates() {
  const defaults = readExecutionGates({});
  assert.deepEqual(
    {
      dryRun: defaults.dryRun,
      executionEnabled: defaults.executionEnabled,
      priceExecutionEnabled: defaults.priceExecutionEnabled,
      statusExecutionEnabled: defaults.statusExecutionEnabled,
      globalWriteRequested: defaults.globalWriteRequested,
      priceWriteRequested: defaults.priceWriteRequested,
      statusWriteRequested: defaults.statusWriteRequested,
    },
    {
      dryRun: true,
      executionEnabled: false,
      priceExecutionEnabled: false,
      statusExecutionEnabled: false,
      globalWriteRequested: false,
      priceWriteRequested: false,
      statusWriteRequested: false,
    },
  );

  assertNoWrites(await runDual({}), "defaults");
  const globalOnly = await runDual(GLOBAL_OPEN_ENV);
  assertNoWrites(globalOnly, "solo gates globales");
  assert.equal(globalOnly.result.globalWriteRequested, true);
  assert.equal(globalOnly.result.priceWriteRequested, false);
  assert.equal(globalOnly.result.statusWriteRequested, false);
  assert.equal(globalOnly.result.effectiveDryRun, true);

  const dryRun = await runDual({
    ...domainEnv({ price: true, status: true }),
    TIENDANUBE_DRY_RUN: "true",
  });
  assertNoWrites(dryRun, "dry-run");
  assert.equal(dryRun.result.globalWriteRequested, false);

  const executionDisabled = await runDual({
    ...domainEnv({ price: true, status: true }),
    TIENDANUBE_EXECUTION_ENABLED: "false",
  });
  assertNoWrites(executionDisabled, "execution disabled");
  assert.equal(executionDisabled.result.globalWriteRequested, false);
  console.log("OK 1-2/6-7: defaults y gates globales cerrados producen cero PUT.");
}

async function testPriceDomainIsolation() {
  const run = await runDual(domainEnv({ price: true }));
  assert.equal(pricePutCalls(run.priceFake).length, 1);
  assert.equal(statusPutCalls(run.statusFake).length, 0);
  assert.equal(run.statusFake.calls.length, 0);
  assert.equal(action(run.result, "PRICE").executionResult, "WRITE_SUCCEEDED");
  assert.equal(action(run.result, "STATUS").executionResult, "SIMULATED");
  assert.equal(run.result.globalWriteRequested, true);
  assert.equal(run.result.priceWriteRequested, true);
  assert.equal(run.result.statusWriteRequested, false);
  assert.deepEqual(run.result.writeOperationsAvailableByDomain, {
    price: true,
    status: false,
    image: false,
    create: false,
  });
  console.log("OK 3/8: PRICE SINGLE escribe sin habilitar STATUS.");
}

async function testStatusDomainIsolation() {
  const run = await runDual(domainEnv({ status: true }));
  assert.equal(pricePutCalls(run.priceFake).length, 0);
  assert.equal(statusPutCalls(run.statusFake).length, 1);
  assert.equal(run.priceFake.calls.length, 0);
  assert.equal(action(run.result, "PRICE").executionResult, "SIMULATED");
  assert.equal(action(run.result, "STATUS").executionResult, "WRITE_SUCCEEDED");
  assert.equal(run.result.globalWriteRequested, true);
  assert.equal(run.result.priceWriteRequested, false);
  assert.equal(run.result.statusWriteRequested, true);
  assert.deepEqual(run.result.writeOperationsAvailableByDomain, {
    price: false,
    status: true,
    image: false,
    create: false,
  });
  console.log("OK 4/10: STATUS SINGLE escribe sin habilitar PRICE.");
}

async function testBothDomains() {
  const run = await runDual(domainEnv({ price: true, status: true }));
  assert.equal(pricePutCalls(run.priceFake).length, 1);
  assert.equal(statusPutCalls(run.statusFake).length, 1);
  assert.equal(action(run.result, "PRICE").executionResult, "WRITE_SUCCEEDED");
  assert.equal(action(run.result, "STATUS").executionResult, "WRITE_SUCCEEDED");
  assert.equal(run.result.priceWriteRequested, true);
  assert.equal(run.result.statusWriteRequested, true);
  assert.deepEqual(run.result.writeOperationsAvailableByDomain, {
    price: true,
    status: true,
    image: false,
    create: false,
  });
  console.log("OK 5: ambos gates permiten sus dominios elegibles.");
}

async function testLegacyDomainSupport() {
  const pricePlan = legacyPlan();
  const priceFake = fakeLegacyAdapter(pricePlan);
  const priceResult = await runControlled(
    pricePlan,
    legacyRevalidation(pricePlan),
    {
      env: domainEnv({ price: true }),
      priceAdapter: priceFake.adapter,
    },
  );
  assert.equal(legacyPricePutCalls(priceFake).length, 3);
  assert.equal(priceResult.writeOperationsAvailableByDomain.price, true);

  const statusPlan = legacyPlan([150, 150, 150]);
  statusPlan.supplier.availability = "UNAVAILABLE";
  statusPlan.plans.status = {
    action: "UNPUBLISH",
    desiredPublished: false,
    publications: statusPlan.tiendanube.matches.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      published: true,
      desiredPublished: false,
      action: "UNPUBLISH",
    })),
  };
  const statusFake = fakeLegacyStatusAdapter(statusPlan);
  const statusResult = await runControlled(
    statusPlan,
    legacyRevalidation(statusPlan),
    {
      env: domainEnv({ status: true }),
      statusAdapter: statusFake.adapter,
    },
  );
  assert.equal(
    statusFake.calls.filter((call) => call.method === "PUT_STATUS").length,
    3,
  );
  assert(
    statusResult.executionPlan.actions
      .filter((item) => item.type === "STATUS")
      .every((item) => item.executionResult === "WRITE_SUCCEEDED"),
  );
  assert.equal(statusResult.writeOperationsAvailableByDomain.status, true);
  assert.equal(statusResult.writeOperationsAvailableByDomain.price, false);
  console.log("OK 9/11: PRICE y STATUS legacy conservan gates independientes.");
}

async function testImageAndCreateRemainSimulation() {
  const imagePlan = basePlan();
  imagePlan.plans.image.action = "IMAGE_REPLACE";
  imagePlan.plans.image.publications[0].action = "IMAGE_REPLACE";
  const imageResult = await runControlled(
    imagePlan,
    successfulRevalidation(imagePlan),
    { env: domainEnv({ price: true, status: true }) },
  );
  assert.equal(action(imageResult, "IMAGE").executionResult, "SIMULATED");
  assert.equal(imageResult.writeOperationsAvailableByDomain.image, false);

  const creation = createPlan();
  const creationResult = await runControlled(
    creation,
    {
      ok: true,
      status: "STILL_ABSENT",
      issues: [],
      matches: [],
      plans: clone(creation.plans),
    },
    { env: domainEnv({ price: true, status: true }) },
  );
  assert.equal(action(creationResult, "CREATE_PRODUCT").executionResult, "SIMULATED");
  assert.equal(creationResult.writeOperationsAvailableByDomain.create, false);
  console.log("OK 12: IMAGE y CREATE_SINGLE permanecen sin rutas de escritura.");
}

async function main() {
  await testDefaultsAndGlobalGates();
  await testPriceDomainIsolation();
  await testStatusDomainIsolation();
  await testBothDomains();
  await testLegacyDomainSupport();
  await testImageAndCreateRemainSimulation();
  console.log("Resultado: OK. Gates PRICE y STATUS aislados con adapters mock.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test de gates por dominio: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
