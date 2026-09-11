const assert = require("assert/strict");
const {
  WRITE_ENV,
  executeLegacy,
  fakeLegacyAdapter,
  fakeLegacyStatusAdapter,
  legacyPlan,
  legacyRevalidation,
  pairKey,
  putCalls,
} = require("./testLegacyPriceExecution");

const STATUS_WRITE_ENV = {
  ...WRITE_ENV,
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "false",
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "true",
};

const BOTH_WRITE_ENV = {
  ...WRITE_ENV,
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "true",
};

function statusPlan(currentPublished, availability = "AVAILABLE") {
  const prices = currentPublished.map(() => 150);
  const plan = legacyPlan(prices, 150);
  const desiredPublished = availability !== "UNAVAILABLE";
  plan.supplier.availability = availability;
  plan.tiendanube.matches.forEach((item, index) => {
    item.published = currentPublished[index];
  });
  plan.plans.status = {
    action: currentPublished.every((published) => published === desiredPublished)
      ? "STATUS_NO_CHANGE"
      : desiredPublished
        ? "PUBLISH"
        : "UNPUBLISH",
    desiredPublished,
    publications: plan.tiendanube.matches.map((item, index) => {
      const published = currentPublished[index];
      return {
        productId: item.productId,
        variantId: item.variantId,
        published,
        desiredPublished,
        action: published === desiredPublished
          ? "STATUS_NO_CHANGE"
          : desiredPublished
            ? "PUBLISH"
            : "UNPUBLISH",
      };
    }),
  };
  return plan;
}

function statusActions(result) {
  return result.executionPlan.actions.filter((action) => action.type === "STATUS");
}

function statusPutCalls(fake) {
  return fake.calls.filter((call) => call.method === "PUT_STATUS");
}

async function runStatus(plan, statusFake, options = {}) {
  const priceFake = options.priceFake || fakeLegacyAdapter(plan);
  const result = await executeLegacy(
    plan,
    priceFake,
    options.env || STATUS_WRITE_ENV,
    options.revalidation || legacyRevalidation(plan),
    statusFake,
  );
  return { result, priceFake };
}

async function testGates() {
  for (const [name, env, expectedExecutionStatus] of [
    ["default", {}, "SIMULATED"],
    ["solo dry-run false", { TIENDANUBE_DRY_RUN: "false" }, "SIMULATED"],
    ["solo execution enabled", { TIENDANUBE_EXECUTION_ENABLED: "true" }, "SIMULATED"],
    ["gates globales sin STATUS", WRITE_ENV, "NO_CHANGES"],
  ]) {
    const plan = statusPlan([false, false]);
    const statusFake = fakeLegacyStatusAdapter(plan);
    const { result } = await runStatus(plan, statusFake, { env });
    assert.equal(statusPutCalls(statusFake).length, 0, name);
    assert.equal(statusFake.calls.length, 0, name);
    assert(statusActions(result).every((action) =>
      action.executionResult === "SIMULATED"), name);
    assert.equal(result.result.executionStatus, expectedExecutionStatus, name);
  }
  console.log("OK A-B: STATUS LEGACY_GROUP requiere ambos gates.");
}

async function testAvailabilityMappings() {
  for (const [availability, currentPublished, expectedAction, count] of [
    ["AVAILABLE", false, "PUBLISH", 2],
    ["PARTIAL", false, "PUBLISH", 2],
    ["UNAVAILABLE", true, "UNPUBLISH", 3],
  ]) {
    const plan = statusPlan(Array(count).fill(currentPublished), availability);
    const statusFake = fakeLegacyStatusAdapter(plan);
    const { result } = await runStatus(plan, statusFake);
    assert.equal(statusPutCalls(statusFake).length, count, availability);
    assert(statusPutCalls(statusFake).every((call) =>
      Object.keys(call.payload).join() === "published"));
    assert(statusActions(result).every((action) =>
      action.plannedAction === expectedAction &&
      action.executionResult === "WRITE_SUCCEEDED"));
    assert.equal(result.result.statusSummary.executionStatus, "SUCCESS");
    assert.equal(result.result.statusSummary.verifiedCount, count);
  }
  console.log("OK C-E: AVAILABLE/PARTIAL publican y UNAVAILABLE despublica.");
}

async function testUnknownBlocksOnlyStatus() {
  const plan = statusPlan([true, true], "UNKNOWN");
  plan.plans.status.action = "STATUS_UNKNOWN";
  plan.plans.status.desiredPublished = null;
  plan.plans.status.publications.forEach((publication) => {
    publication.action = "STATUS_UNKNOWN";
    publication.desiredPublished = null;
  });
  plan.plans.price.publications.forEach((publication) => {
    publication.action = "PRICE_UPDATE";
    publication.currentPrice = 100;
  });
  plan.plans.price.action = "PRICE_UPDATE";
  const statusFake = fakeLegacyStatusAdapter(plan);
  const priceFake = fakeLegacyAdapter(plan);
  const { result } = await runStatus(plan, statusFake, {
    priceFake,
    env: BOTH_WRITE_ENV,
  });
  assert.equal(statusFake.calls.length, 0);
  assert.equal(putCalls(priceFake).length, 2);
  assert.equal(result.result.statusSummary.executionStatus, "BLOCKED");
  assert.equal(result.result.priceSummary.executionStatus, "SUCCESS");
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");
  console.log("OK F: UNKNOWN bloquea STATUS y permite PRICE valido.");
}

async function testInvalidGroupBlocksBeforeAdapters() {
  const plan = statusPlan([false, false]);
  plan.tiendanube.legacyGroup.valid = false;
  const statusFake = fakeLegacyStatusAdapter(plan);
  const priceFake = fakeLegacyAdapter(plan);
  const { result } = await runStatus(plan, statusFake, { priceFake });
  assert.equal(statusFake.calls.length, 0);
  assert.equal(priceFake.calls.length, 0);
  assert.equal(result.result.executionStatus, "BLOCKED");

  const changedPlan = statusPlan([false, false]);
  const changedRevalidation = legacyRevalidation(changedPlan);
  changedRevalidation.legacyGroup.actualMatches += 1;
  const changedStatusFake = fakeLegacyStatusAdapter(changedPlan);
  const changedPriceFake = fakeLegacyAdapter(changedPlan);
  const changed = await runStatus(changedPlan, changedStatusFake, {
    priceFake: changedPriceFake,
    revalidation: changedRevalidation,
  });
  assert.equal(changedStatusFake.calls.length, 0);
  assert.equal(changedPriceFake.calls.length, 0);
  assert.equal(changed.result.result.executionStatus, "BLOCKED");
  assert(changed.result.errors.some((error) =>
    error.code === "LEGACY_STATUS_COUNT_MISMATCH"));
  console.log("OK G: grupo legacy invalido bloquea todo antes de adapters.");
}

async function testWhitelistStructureBlocksBeforeAdapters() {
  const cases = [
    ["publicacion extra", (plan, revalidation) => {
      revalidation.matches.push({ ...revalidation.matches[0], productId: 99, variantId: 199 });
      revalidation.legacyGroup.actualMatches += 1;
    }],
    ["publicacion faltante", (plan, revalidation) => {
      revalidation.matches.pop();
      revalidation.legacyGroup.actualMatches -= 1;
    }],
    ["SKU incorrecto", (plan, revalidation) => {
      revalidation.matches[0].sku = "SKU-DISTINTO";
    }],
  ];

  for (const [name, mutate] of cases) {
    const plan = statusPlan([false, false]);
    const revalidation = legacyRevalidation(plan);
    mutate(plan, revalidation);
    const statusFake = fakeLegacyStatusAdapter(plan);
    const priceFake = fakeLegacyAdapter(plan);
    const { result } = await runStatus(plan, statusFake, {
      priceFake,
      revalidation,
    });
    assert.equal(statusFake.calls.length, 0, name);
    assert.equal(priceFake.calls.length, 0, name);
    assert.equal(result.result.executionStatus, "BLOCKED", name);
  }
  console.log("OK G2-G4: extra, faltante y SKU incorrecto bloquean antes de adapters.");
}

async function testAlreadyAppliedAndUnexpectedState() {
  const plan = statusPlan([false, false, false]);
  const firstPair = pairKey(plan.plans.status.publications[0]);
  const statusFake = fakeLegacyStatusAdapter(plan, {
    preWritePublished: { [firstPair]: true },
  });
  const { result } = await runStatus(plan, statusFake);
  assert.equal(statusPutCalls(statusFake).length, 2);
  assert.equal(statusActions(result)[0].executionResult, "SKIPPED_ALREADY_APPLIED");
  assert.equal(result.result.statusSummary.skippedAlreadyAppliedCount, 1);

  const changedPlan = statusPlan([false, false, false]);
  const secondPair = pairKey(changedPlan.plans.status.publications[1]);
  const changedFake = fakeLegacyStatusAdapter(changedPlan, {
    preWritePublished: { [secondPair]: null },
  });
  const changed = await runStatus(changedPlan, changedFake);
  assert.equal(statusPutCalls(changedFake).length, 2);
  assert.equal(statusActions(changed.result)[1].executionResult, "BLOCKED");
  assert.equal(statusActions(changed.result)[2].executionResult, "WRITE_SUCCEEDED");
  assert.equal(changed.result.result.statusSummary.executionStatus, "PARTIAL_FAILURE");
  console.log("OK H-I: idempotencia por publicacion y cambio inesperado local.");
}

async function testIdentityFailureStopsGroup() {
  const plan = statusPlan([false, false, false]);
  const secondPair = pairKey(plan.plans.status.publications[1]);
  const statusFake = fakeLegacyStatusAdapter(plan, {
    identityOverrides: { [secondPair]: { sku: "SKU-DISTINTO" } },
  });
  const priceFake = fakeLegacyAdapter(plan);
  const { result } = await runStatus(plan, statusFake, {
    priceFake,
    env: BOTH_WRITE_ENV,
  });
  assert.equal(statusPutCalls(statusFake).length, 1);
  assert.equal(statusActions(result)[1].executionResult, "BLOCKED");
  assert.equal(statusActions(result)[2].executionResult, "BLOCKED");
  assert.equal(putCalls(priceFake).length, 0);
  assert(result.errors.some((error) => error.code === "GROUP_INTEGRITY_FAILED"));
  assert.equal(result.result.executionStatus, "PARTIAL_FAILURE");

  const firstPlan = statusPlan([false, false, false]);
  const firstPair = pairKey(firstPlan.plans.status.publications[0]);
  const firstFake = fakeLegacyStatusAdapter(firstPlan, {
    identityOverrides: { [firstPair]: { variantId: 999 } },
  });
  const firstPriceFake = fakeLegacyAdapter(firstPlan);
  const first = await runStatus(firstPlan, firstFake, {
    priceFake: firstPriceFake,
    env: BOTH_WRITE_ENV,
  });
  assert.equal(statusPutCalls(firstFake).length, 0);
  assert.equal(putCalls(firstPriceFake).length, 0);
  assert(statusActions(first.result).every((action) =>
    action.executionResult === "BLOCKED"));
  assert.equal(first.result.result.executionStatus, "BLOCKED");
  console.log("OK J: inconsistencia de identidad detiene el grupo y PRICE restante.");
}

async function testPostWriteIdentityFailureStopsGroup() {
  const plan = statusPlan([false, false, false]);
  const firstPair = pairKey(plan.plans.status.publications[0]);
  const statusFake = fakeLegacyStatusAdapter(plan, {
    postWriteIdentityOverrides: { [firstPair]: { sku: "SKU-DISTINTO" } },
  });
  const { result } = await runStatus(plan, statusFake);
  assert.equal(statusPutCalls(statusFake).length, 1);
  assert.equal(statusActions(result)[0].executionResult, "WRITE_VERIFICATION_FAILED");
  assert.equal(statusActions(result)[1].executionResult, "BLOCKED");
  assert.equal(statusActions(result)[2].executionResult, "BLOCKED");
  assert.equal(result.result.statusSummary.executionStatus, "PARTIAL_FAILURE");
  assert(result.errors.some((error) => error.code === "GROUP_INTEGRITY_FAILED"));
  console.log("OK J2: identidad post-write incorrecta detiene publicaciones restantes.");
}

async function testWriteAndVerificationFailuresContinue() {
  const putPlan = statusPlan([false, false, false]);
  const failedPair = pairKey(putPlan.plans.status.publications[1]);
  const putFake = fakeLegacyStatusAdapter(putPlan, { putFailures: [failedPair] });
  const putResult = await runStatus(putPlan, putFake);
  assert.equal(statusPutCalls(putFake).length, 3);
  assert.equal(statusActions(putResult.result)[1].executionResult, "WRITE_FAILED");
  assert.equal(statusActions(putResult.result)[2].executionResult, "WRITE_SUCCEEDED");
  assert.equal(putResult.result.result.statusSummary.failedCount, 1);

  const verifyPlan = statusPlan([false, false, false]);
  const mismatchPair = pairKey(verifyPlan.plans.status.publications[1]);
  const verifyFake = fakeLegacyStatusAdapter(verifyPlan, {
    verificationMismatches: [mismatchPair],
  });
  const verifyResult = await runStatus(verifyPlan, verifyFake);
  assert.equal(statusPutCalls(verifyFake).length, 3);
  assert.equal(
    statusActions(verifyResult.result)[1].executionResult,
    "WRITE_VERIFICATION_FAILED",
  );
  assert.equal(statusActions(verifyResult.result)[2].executionResult, "WRITE_SUCCEEDED");
  assert.equal(verifyResult.result.result.statusSummary.executionStatus, "PARTIAL_FAILURE");
  console.log("OK K-M: exito, fallo PUT y fallo de verificacion quedan trazados.");
}

async function testMixedSummaryAndSecondExecution() {
  const plan = statusPlan([false, false, false]);
  const firstPair = pairKey(plan.plans.status.publications[0]);
  const thirdPair = pairKey(plan.plans.status.publications[2]);
  const mixedFake = fakeLegacyStatusAdapter(plan, {
    preWritePublished: { [firstPair]: true },
    putFailures: [thirdPair],
  });
  const mixed = await runStatus(plan, mixedFake);
  const summary = mixed.result.result.statusSummary;
  assert.equal(summary.totalPublications, 3);
  assert.equal(summary.writeAttemptedCount, 2);
  assert.equal(summary.writeSucceededCount, 1);
  assert.equal(summary.skippedAlreadyAppliedCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.verifiedCount, 2);
  assert.equal(summary.executionStatus, "PARTIAL_FAILURE");

  const idempotentPlan = statusPlan([false, false]);
  const idempotentStatus = fakeLegacyStatusAdapter(idempotentPlan);
  const idempotentPrice = fakeLegacyAdapter(idempotentPlan);
  await runStatus(idempotentPlan, idempotentStatus, { priceFake: idempotentPrice });
  const second = await runStatus(idempotentPlan, idempotentStatus, {
    priceFake: idempotentPrice,
  });
  assert.equal(statusPutCalls(idempotentStatus).length, 2);
  assert(statusActions(second.result).every((action) =>
    action.executionResult === "SKIPPED_ALREADY_APPLIED"));
  assert.equal(second.result.result.statusSummary.executionStatus, "NO_CHANGES");
  assert.equal(second.result.result.executionStatus, "NO_CHANGES");
  console.log("OK N-O: resumen mixto e idempotencia de segunda ejecucion.");
}

async function testAllStatusNoChange() {
  const plan = statusPlan([true, true], "AVAILABLE");
  const statusFake = fakeLegacyStatusAdapter(plan);
  const { result } = await runStatus(plan, statusFake);
  assert.equal(statusPutCalls(statusFake).length, 0);
  assert(statusActions(result).every((action) =>
    action.executionResult === "SKIPPED_ALREADY_APPLIED"));
  assert.equal(result.result.statusSummary.executionStatus, "NO_CHANGES");
  console.log("OK O2: STATUS_NO_CHANGE completo realiza cero PUT.");
}

async function testPriceDomainDoesNotEnableStatus() {
  const plan = statusPlan([false, false]);
  plan.plans.price.action = "PRICE_UPDATE";
  plan.plans.price.publications.forEach((publication) => {
    publication.action = "PRICE_UPDATE";
    publication.currentPrice = 100;
  });
  const statusFake = fakeLegacyStatusAdapter(plan);
  const priceFake = fakeLegacyAdapter(plan);
  const { result } = await runStatus(plan, statusFake, {
    env: WRITE_ENV,
    priceFake,
  });
  assert.equal(statusFake.calls.length, 0);
  assert.equal(putCalls(priceFake).length, 2);
  assert(statusActions(result).every((action) =>
    action.executionResult === "SIMULATED"));
  assert.equal(result.writeOperationsAvailableByDomain.status, false);
  assert.equal(result.writeOperationsAvailableByDomain.price, true);
  console.log("OK O3: PRICE habilitado no abre STATUS legacy.");
}

async function testDomainIndependence() {
  const plan = statusPlan([false, false]);
  plan.supplier.supplierPrice = 0;
  plan.plans.image.action = "NO_SOURCE_IMAGE";
  plan.plans.image.publications = [];
  plan.supplier.imageUrl = null;
  const statusFake = fakeLegacyStatusAdapter(plan);
  const priceFake = fakeLegacyAdapter(plan);
  const { result } = await runStatus(plan, statusFake, { priceFake });
  assert.equal(statusPutCalls(statusFake).length, 2);
  assert.equal(putCalls(priceFake).length, 0);
  assert.equal(result.result.statusSummary.executionStatus, "SUCCESS");
  assert.equal(result.result.priceSummary.executionStatus, "BLOCKED");
  assert.equal(
    result.executionPlan.actions.find((action) => action.type === "IMAGE").executionResult,
    "SIMULATED",
  );
  console.log("OK P-R: PRICE bloqueado e IMAGE sin fuente no bloquean STATUS.");
}

async function main() {
  await testGates();
  await testAvailabilityMappings();
  await testUnknownBlocksOnlyStatus();
  await testInvalidGroupBlocksBeforeAdapters();
  await testWhitelistStructureBlocksBeforeAdapters();
  await testAlreadyAppliedAndUnexpectedState();
  await testIdentityFailureStopsGroup();
  await testPostWriteIdentityFailureStopsGroup();
  await testWriteAndVerificationFailuresContinue();
  await testMixedSummaryAndSecondExecution();
  await testAllStatusNoChange();
  await testPriceDomainDoesNotEnableStatus();
  await testDomainIndependence();
  console.log("Resultado: OK. Casos A-R cubiertos con adaptadores mock.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test STATUS LEGACY_GROUP: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
