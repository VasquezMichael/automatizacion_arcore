const assert = require("assert/strict");
const { findSkuMatches } = require("../tiendanube/products");
const { executeSyncPlan } = require("./executeSyncPlan");
const { sanitizeForPersistence } = require("./executionLog");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function match(index = 1, overrides = {}) {
  return {
    productId: 100 + index,
    variantId: 200 + index,
    sku: "415 0000 10",
    normalizedSku: "415000010",
    name: `Producto ${index}`,
    published: true,
    price: "150.00",
    promotionalPrice: null,
    visibility: "visible",
    ...overrides,
  };
}

function statusPublication(item, overrides = {}) {
  return {
    productId: item.productId,
    variantId: item.variantId,
    published: item.published,
    desiredPublished: true,
    action: "STATUS_NO_CHANGE",
    ...overrides,
  };
}

function pricePublication(item, overrides = {}) {
  return {
    productId: item.productId,
    variantId: item.variantId,
    currentPrice: 150,
    requestedPrice: 150,
    action: "PRICE_NO_CHANGE",
    errors: [],
    ...overrides,
  };
}

function imagePublication(item, overrides = {}) {
  return {
    productId: item.productId,
    variantId: item.variantId,
    imageId: 300 + item.productId,
    sourceHash: "source-hash",
    tiendanubeHash: "target-hash",
    action: "IMAGE_NO_CHANGE",
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function basePlan(overrides = {}) {
  const item = match();
  const plan = {
    sourceSku: "415 0000 10",
    normalizedSku: "415000010",
    matchedCode: "4150000100",
    matchType: "SAFE_TRANSFORM",
    supplierResolution: {
      type: "SAFE_TRANSFORM",
      sourceCode: "415000010",
      matchedCode: "4150000100",
      rule: "APPEND_TRAILING_ZERO",
    },
    classification: "SINGLE",
    supplier: {
      name: "Producto Arcore",
      availability: "AVAILABLE",
      supplierPrice: 100,
      imageUrl: "https://www.arcore.com/image.png",
    },
    tiendanube: {
      matchCount: 1,
      productIds: [item.productId],
      variantIds: [item.variantId],
      matches: [item],
      legacyGroup: null,
    },
    plans: {
      status: {
        action: "STATUS_NO_CHANGE",
        desiredPublished: true,
        publications: [statusPublication(item)],
      },
      price: {
        action: "PRICE_NO_CHANGE",
        calculation: {
          supplierPrice: 100,
          calculatedPrice: 150,
        },
        publications: [pricePublication(item)],
        errors: [],
      },
      image: {
        action: "IMAGE_NO_CHANGE",
        sourceImageUrl: "https://www.arcore.com/image.png",
        sourceHash: "source-hash",
        publications: [imagePublication(item)],
        errors: [],
        warnings: [],
      },
    },
    warnings: [],
    errors: [],
    ...overrides,
  };
  return plan;
}

function successfulRevalidation(plan, planOverrides = {}) {
  return {
    checkedAt: "2026-09-09T12:00:01.000Z",
    ok: true,
    status: "PASSED",
    issues: [],
    matches: clone(plan.tiendanube.matches),
    plans: {
      status: clone(plan.plans.status),
      price: clone(plan.plans.price),
      image: clone(plan.plans.image),
      ...planOverrides,
    },
  };
}

async function runControlled(plan, revalidation, options = {}) {
  let clientAccessed = false;
  const client = new Proxy(
    {},
    {
      get() {
        clientAccessed = true;
        throw new Error("La prueba controlada no debe ejecutar operaciones HTTP.");
      },
    },
  );
  const result = await executeSyncPlan(plan.sourceSku, {
    client,
    env: options.env || {
      TIENDANUBE_DRY_RUN: "true",
      TIENDANUBE_EXECUTION_ENABLED: "false",
    },
    now: new Date("2026-09-09T12:00:00.000Z"),
    persist: false,
    syncProduct: async () => clone(plan),
    revalidateSyncPlan: async () => clone(revalidation),
    ...(options.priceAdapter ? { priceAdapter: options.priceAdapter } : {}),
  });
  assert.equal(clientAccessed, false);
  return result;
}

async function testSingleNoChanges() {
  const plan = basePlan();
  const result = await runControlled(plan, successfulRevalidation(plan));
  assert.equal(result.result.executionStatus, "NO_CHANGES");
  assert.equal(result.result.skippedAlreadyApplied, 3);
  assert.equal(result.result.wouldWrite, 0);
  console.log("OK SINGLE sin cambios -> NO_CHANGES.");
}

async function testSinglePriceUpdate() {
  const plan = basePlan();
  plan.plans.price.action = "PRICE_UPDATE";
  Object.assign(plan.plans.price.publications[0], {
    action: "PRICE_UPDATE",
    currentPrice: 100,
  });
  const result = await runControlled(plan, successfulRevalidation(plan));
  assert.equal(result.result.executionStatus, "SIMULATED");
  assert.equal(result.result.wouldWrite, 1);
  assert.equal(
    result.executionPlan.actions.find((action) => action.type === "PRICE")
      .simulationResult,
    "WOULD_UPDATE",
  );
  console.log("OK SINGLE con PRICE_UPDATE -> WOULD_UPDATE sin write.");
}

async function testValidLegacyGroup() {
  const items = [match(1), match(2)];
  const plan = basePlan({
    classification: "LEGACY_GROUP",
    tiendanube: {
      matchCount: 2,
      productIds: items.map((item) => item.productId),
      variantIds: items.map((item) => item.variantId),
      matches: items,
      legacyGroup: { valid: true, expectedMatches: 2, actualMatches: 2, issues: [] },
    },
  });
  plan.plans.status.publications = items.map((item) => statusPublication(item));
  plan.plans.price.publications = items.map((item) => pricePublication(item));
  plan.plans.image.action = "IMAGE_REPLACE";
  plan.plans.image.publications = items.map((item) =>
    imagePublication(item, { action: "IMAGE_REPLACE" }),
  );
  const result = await runControlled(plan, successfulRevalidation(plan));
  assert.equal(result.result.executionStatus, "SIMULATED");
  assert.equal(result.result.wouldWrite, 2);
  assert.equal(
    result.executionPlan.actions.filter(
      (action) => action.simulationResult === "WOULD_REPLACE",
    ).length,
    2,
  );
  console.log("OK LEGACY_GROUP valido -> acciones por publicacion.");
}

async function testSingleUnknownStatusWithValidPrice() {
  const plan = basePlan();
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
  const result = await runControlled(plan, successfulRevalidation(plan));
  const status = result.executionPlan.actions.find((action) => action.type === "STATUS");
  const price = result.executionPlan.actions.find((action) => action.type === "PRICE");
  assert.equal(status.simulationResult, "NOT_EXECUTABLE");
  assert.equal(price.simulationResult, "WOULD_UPDATE");
  assert.equal(result.result.executionStatus, "SIMULATED_WITH_BLOCKS");
  assert.equal(result.result.wouldWrite, 1);
  assert.equal(result.errors.length, 0);
  console.log("OK SINGLE STATUS_UNKNOWN bloquea solo STATUS.");
}

async function testSingleInvalidPriceWithValidStatus() {
  const plan = basePlan();
  plan.supplier.supplierPrice = null;
  plan.plans.status.action = "PUBLISH";
  Object.assign(plan.plans.status.publications[0], {
    action: "PUBLISH",
    published: false,
    desiredPublished: true,
  });
  plan.plans.price = {
    action: "INVALID_SUPPLIER_PRICE",
    calculation: null,
    publications: [],
    errors: [
      {
        code: "INVALID_SUPPLIER_PRICE",
        message: "Precio proveedor invalido.",
      },
    ],
  };
  plan.errors = clone(plan.plans.price.errors);
  const result = await runControlled(plan, successfulRevalidation(plan));
  const status = result.executionPlan.actions.find((action) => action.type === "STATUS");
  const price = result.executionPlan.actions.find((action) => action.type === "PRICE");
  assert.equal(status.simulationResult, "WOULD_UPDATE");
  assert.equal(price.simulationResult, "NOT_EXECUTABLE");
  assert.equal(result.result.executionStatus, "SIMULATED_WITH_BLOCKS");
  assert.equal(result.result.wouldWrite, 1);
  assert.equal(result.errors.length, 0);
  console.log("OK SINGLE precio invalido bloquea solo PRICE.");
}

async function testSingleNoSourceImageWithPriceUpdate() {
  const plan = basePlan();
  plan.supplier.imageUrl = null;
  plan.plans.price.action = "PRICE_UPDATE";
  Object.assign(plan.plans.price.publications[0], {
    action: "PRICE_UPDATE",
    currentPrice: 100,
    requestedPrice: 150,
  });
  plan.plans.image = {
    action: "NO_SOURCE_IMAGE",
    sourceImageUrl: null,
    sourceHash: null,
    publications: [],
    errors: [],
    warnings: [{ code: "NO_SOURCE_IMAGE" }],
  };
  const result = await runControlled(plan, successfulRevalidation(plan));
  const price = result.executionPlan.actions.find((action) => action.type === "PRICE");
  const image = result.executionPlan.actions.find((action) => action.type === "IMAGE");
  assert.equal(price.simulationResult, "WOULD_UPDATE");
  assert.equal(image.simulationResult, "SKIPPED_NO_SOURCE_IMAGE");
  assert.equal(result.result.executionStatus, "SIMULATED");
  assert.equal(result.result.wouldWrite, 1);
  console.log("OK SINGLE NO_SOURCE_IMAGE no bloquea PRICE.");
}

async function testInvalidLegacyGroup() {
  const plan = basePlan({ classification: "LEGACY_GROUP" });
  plan.tiendanube.legacyGroup = {
    valid: false,
    expectedMatches: 2,
    actualMatches: 1,
    issues: [{ code: "COUNT_MISMATCH" }],
  };
  const result = await runControlled(plan, {
    ok: false,
    status: "FAILED",
    issues: [],
  });
  assert.equal(result.result.executionStatus, "BLOCKED");
  assert(result.errors.some((error) => error.code === "INVALID_LEGACY_GROUP"));
  console.log("OK LEGACY_GROUP invalido -> BLOCKED.");
}

function createPlan({ image = true, supplierPrice = 100, availability = "AVAILABLE" } = {}) {
  const plan = basePlan({
    classification: "CREATE_SINGLE",
    supplier: {
      name: "Nombre minimo Arcore",
      availability,
      supplierPrice,
      imageUrl: image ? "https://www.arcore.com/image.png" : null,
    },
    tiendanube: {
      matchCount: 0,
      productIds: [],
      variantIds: [],
      matches: [],
      legacyGroup: null,
    },
  });
  plan.plans.status = {
    action: availability === "UNKNOWN" ? "STATUS_UNKNOWN" : "STATUS_FOR_CREATION",
    desiredPublished: availability === "UNKNOWN" ? null : true,
    publications: [],
  };
  plan.plans.price = {
    action: supplierPrice > 0 ? "PRICE_FOR_CREATION" : "INVALID_SUPPLIER_PRICE",
    calculation:
      supplierPrice > 0 ? { supplierPrice, calculatedPrice: supplierPrice * 1.5 } : null,
    publications: [],
    errors: [],
  };
  plan.plans.image = {
    action: image ? "IMAGE_FOR_CREATION" : "NO_SOURCE_IMAGE",
    sourceImageUrl: image ? plan.supplier.imageUrl : null,
    sourceHash: image ? "source-hash" : null,
    publications: [],
    errors: [],
    warnings: [],
  };
  return plan;
}

async function testCreateWithImage() {
  const plan = createPlan({ image: true });
  const result = await runControlled(plan, {
    ok: true,
    status: "STILL_ABSENT",
    issues: [],
    matches: [],
    plans: clone(plan.plans),
  });
  const action = result.executionPlan.actions.find(
    (item) => item.type === "CREATE_PRODUCT",
  );
  assert.equal(action.simulationResult, "WOULD_CREATE");
  assert.equal(action.desiredState.primaryImage, plan.supplier.imageUrl);
  assert.equal(action.desiredState.nameSource, "ARCORE_MINIMAL");
  console.log("OK CREATE_SINGLE con imagen -> WOULD_CREATE.");
}

async function testCreateWithoutImage() {
  const plan = createPlan({ image: false });
  const result = await runControlled(plan, {
    ok: true,
    status: "STILL_ABSENT",
    issues: [],
    matches: [],
    plans: clone(plan.plans),
  });
  const action = result.executionPlan.actions.find(
    (item) => item.type === "CREATE_PRODUCT",
  );
  assert.equal(action.simulationResult, "WOULD_CREATE");
  assert.equal(action.desiredState.primaryImage, null);
  assert(!action.desiredState.allowedFields.includes("primaryImage"));
  console.log("OK CREATE_SINGLE sin imagen -> WOULD_CREATE con imagen opcional.");
}

async function testCreateInvalidPrice() {
  for (const supplierPrice of [0, null]) {
    const plan = createPlan({ supplierPrice });
    const result = await runControlled(plan, {
      ok: true,
      status: "STILL_ABSENT",
      issues: [],
    });
    assert.equal(result.result.executionStatus, "BLOCKED");
    assert(result.errors.some((error) => error.code === "INVALID_SUPPLIER_PRICE"));
    if (supplierPrice === 0) {
      assert(result.errors.some((error) => error.code === "ZERO_SUPPLIER_PRICE"));
    } else {
      assert(!result.errors.some((error) => error.code === "ZERO_SUPPLIER_PRICE"));
    }
  }
  console.log("OK CREATE_SINGLE con precio faltante/cero -> BLOCKED.");
}

async function testUnknownAvailability() {
  const plan = createPlan({ availability: "UNKNOWN" });
  const result = await runControlled(plan, {
    ok: true,
    status: "STILL_ABSENT",
    issues: [],
  });
  assert.equal(result.result.executionStatus, "BLOCKED");
  assert(result.errors.some((error) => error.code === "STATUS_UNKNOWN"));
  console.log("OK UNKNOWN availability -> BLOCKED para CREATE_SINGLE.");
}

async function testManualReview() {
  const plan = basePlan({
    classification: "MANUAL_REVIEW",
    supplierResolution: {
      type: "AMBIGUOUS",
      sourceCode: "415000010",
      candidates: [{ code: "4150000100" }, { code: "415000010" }],
    },
  });
  plan.errors = [{ code: "MANUAL_REVIEW", message: "SKU ambiguo." }];
  const result = await runControlled(plan, {
    ok: false,
    status: "FAILED",
    issues: [],
  });
  assert.equal(result.result.executionStatus, "BLOCKED");
  assert(result.errors.some((error) => error.code === "MANUAL_REVIEW"));
  console.log("OK MANUAL_REVIEW -> BLOCKED.");
}

async function testChangedState() {
  const plan = basePlan();
  plan.plans.price.action = "PRICE_UPDATE";
  Object.assign(plan.plans.price.publications[0], {
    action: "PRICE_UPDATE",
    currentPrice: 100,
    requestedPrice: 150,
  });
  const currentPricePlan = clone(plan.plans.price);
  currentPricePlan.publications[0].currentPrice = 120;
  const result = await runControlled(
    plan,
    successfulRevalidation(plan, { price: currentPricePlan }),
  );
  assert.equal(result.result.executionStatus, "BLOCKED");
  assert.equal(result.revalidation.status, "FAILED");
  assert(result.errors.some((error) => error.code === "REVALIDATION_FAILED"));
  assert.equal(result.result.wouldWrite, 0);
  console.log("OK cambio entre plan y revalidacion -> REVALIDATION_FAILED.");
}

function testPersistenceSanitizer() {
  const sanitized = sanitizeForPersistence({
    sourceSku: "415000010",
    token: "secret-token",
    nested: {
      Authorization: "Bearer secret",
      cookie: "session=secret",
      safe: true,
    },
  });
  assert.deepEqual(sanitized, {
    sourceSku: "415000010",
    nested: { safe: true },
  });
  console.log("OK persistencia elimina claves sensibles.");
}

async function testSkuRevalidationPagination() {
  const products = Array.from({ length: 31 }, (_, index) => ({
    id: 1000 + index,
    name: `Producto paginado ${index + 1}`,
    published: true,
    variants: [
      {
        id: 2000 + index,
        sku: "415 0000 10",
        price: "150.00",
      },
    ],
  }));
  const requestedPages = [];
  const client = {
    listProducts: async ({ page, perPage }) => {
      requestedPages.push(page);
      const start = (page - 1) * perPage;
      return { status: 200, data: products.slice(start, start + perPage) };
    },
  };
  const result = await findSkuMatches("415 0000 10", client);
  assert.equal(result.matches.length, 31);
  assert(requestedPages.includes(2));
  console.log("OK revalidacion SKU recorre toda la paginacion.");
}

async function main() {
  await testSingleNoChanges();
  await testSinglePriceUpdate();
  await testValidLegacyGroup();
  await testSingleUnknownStatusWithValidPrice();
  await testSingleInvalidPriceWithValidStatus();
  await testSingleNoSourceImageWithPriceUpdate();
  await testInvalidLegacyGroup();
  await testCreateWithImage();
  await testCreateWithoutImage();
  await testCreateInvalidPrice();
  await testUnknownAvailability();
  await testManualReview();
  await testChangedState();
  testPersistenceSanitizer();
  await testSkuRevalidationPagination();
  console.log("Resultado: OK. Executor seguro con writes deshabilitados por defecto.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test del executor: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  basePlan,
  clone,
  createPlan,
  main,
  match,
  runControlled,
  successfulRevalidation,
};
