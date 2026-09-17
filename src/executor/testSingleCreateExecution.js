const assert = require("assert/strict");
const { validateCreatePayload } = require("./tiendanubeCreateAdapter");
const {
  basePlan,
  clone,
  createPlan,
  runControlled,
  successfulRevalidation,
} = require("./testExecutor");

const OPEN_CREATE_ENV = {
  TIENDANUBE_DRY_RUN: "false",
  TIENDANUBE_EXECUTION_ENABLED: "true",
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "false",
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "false",
  TIENDANUBE_IMAGE_EXECUTION_ENABLED: "false",
  TIENDANUBE_CREATE_EXECUTION_ENABLED: "true",
};

function createRevalidation(plan, overrides = {}) {
  return {
    checkedAt: "2026-09-17T12:00:01.000Z",
    ok: true,
    status: "PASSED",
    absenceStatus: "STILL_ABSENT",
    issues: [],
    matches: [],
    plans: clone(plan.plans),
    ...overrides,
  };
}

function createAction(result) {
  return result.executionPlan?.actions.find(
    (action) => action.type === "CREATE_PRODUCT",
  );
}

function matchingRecord(product) {
  const variant = product.variants[0];
  return {
    productId: product.id,
    variantId: variant.id,
    sku: variant.sku,
    normalizedSku: variant.sku,
    price: variant.price,
    published: product.published,
    name: product.name,
  };
}

function fakeCreateAdapter(options = {}) {
  const calls = [];
  let createdProduct = null;
  let searchCount = 0;

  function productFromPayload(payload) {
    const product = {
      id: 501,
      name: payload.name,
      published: payload.published,
      variants: [
        {
          id: 601,
          sku: payload.variants[0].sku,
          price: payload.variants[0].price,
        },
      ],
      images: payload.images
        ? [{ id: 701, src: payload.images[0].src, position: 1 }]
        : [],
    };
    return options.mutateProduct ? options.mutateProduct(product) : product;
  }

  function currentMatches() {
    if (Array.isArray(options.initialMatches) && !createdProduct) {
      return clone(options.initialMatches);
    }
    if (!createdProduct) return [];
    const count = options.postCreateMatchCount ?? 1;
    if (count === 0) return [];
    const record = matchingRecord({
      ...createdProduct,
      variants: [
        {
          ...createdProduct.variants[0],
          sku: options.searchMatchedSku || createdProduct.variants[0].sku,
        },
      ],
    });
    return Array.from({ length: count }, (_, index) => ({
      ...record,
      productId: record.productId + index,
      variantId: record.variantId + index,
    }));
  }

  const adapter = {
    async findSkuMatches(normalizedSku) {
      calls.push({ method: "FIND_SKU", normalizedSku });
      searchCount += 1;
      if (options.preWriteSearchError && searchCount === 1) {
        throw Object.assign(new Error("search failed"), { code: "SEARCH_FAILED" });
      }
      if (options.searchSequence?.[searchCount - 1]) {
        return { normalizedSku, matches: clone(options.searchSequence[searchCount - 1]) };
      }
      return { normalizedSku, matches: currentMatches() };
    },

    async createProduct(payload) {
      calls.push({ method: "POST_PRODUCT", payload: clone(payload) });
      if (options.failBeforeResponse) {
        throw Object.assign(new Error("POST rejected"), {
          code: "CREATE_WRITE_FAILED",
          ambiguous: false,
        });
      }
      const product = productFromPayload(payload);
      if (options.ambiguous) {
        if (options.applyAmbiguous !== false) createdProduct = product;
        throw Object.assign(new Error("timeout"), {
          code: "CREATE_WRITE_AMBIGUOUS",
          ambiguous: true,
        });
      }
      createdProduct = product;
      return options.responseProduct
        ? options.responseProduct(product)
        : clone(product);
    },

    async getProduct(productId) {
      calls.push({ method: "GET_PRODUCT", productId });
      if (!createdProduct) throw new Error("product missing");
      return clone(createdProduct);
    },

    async listProductImages(productId) {
      calls.push({ method: "GET_IMAGES", productId });
      if (options.imageMissing) return [];
      return clone(createdProduct?.images || []);
    },
  };

  return { adapter, calls, get createdProduct() { return createdProduct; } };
}

function postCalls(fake) {
  return fake.calls.filter((call) => call.method === "POST_PRODUCT");
}

async function runCreate(plan, fake, options = {}) {
  return runControlled(
    plan,
    options.revalidation || createRevalidation(plan),
    {
      env: options.env || OPEN_CREATE_ENV,
      createAdapter: fake.adapter,
      ...(options.adapters || {}),
    },
  );
}

async function testSuccessfulCreate(resolutionType) {
  const plan = createPlan();
  if (resolutionType === "EXACT") {
    plan.supplierResolution = {
      type: "EXACT",
      sourceCode: plan.normalizedSku,
      matchedCode: plan.normalizedSku,
    };
    plan.matchedCode = plan.normalizedSku;
  }
  const fake = fakeCreateAdapter();
  const result = await runCreate(plan, fake);
  const action = createAction(result);
  assert.equal(postCalls(fake).length, 1);
  assert.equal(action.executionResult, "WRITE_SUCCEEDED");
  assert.equal(action.preWriteMatchCount, 0);
  assert.equal(action.postCreateMatchCount, 1);
  assert.equal(action.createAttempted, true);
  assert.equal(action.createSucceeded, true);
  assert.equal(action.createdProductId, 501);
  assert.equal(action.createdVariantId, 601);
  assert.equal(action.verified, true);
  assert.equal(action.updated, true);
  assert.equal(result.result.executionStatus, "SUCCESS");
  return { plan, fake, result, action };
}

async function testSuccessAndResolutionTypes() {
  await testSuccessfulCreate("SAFE_TRANSFORM");
  await testSuccessfulCreate("EXACT");
  console.log("OK 1-3: CREATE valido para SAFE_TRANSFORM y EXACT, con POST y GET verificados.");
}

async function testPreWriteDuplicateGuards() {
  for (const matchCount of [1, 2]) {
    const plan = createPlan();
    const matches = Array.from({ length: matchCount }, (_, index) => ({
      productId: 800 + index,
      variantId: 900 + index,
      sku: plan.normalizedSku,
    }));
    const fake = fakeCreateAdapter({ initialMatches: matches });
    const result = await runCreate(plan, fake);
    const action = createAction(result);
    assert.equal(postCalls(fake).length, 0);
    assert.equal(action.executionResult, "BLOCKED");
    assert(
      action.errors.some((error) =>
        matchCount === 1
          ? error.code === "CREATE_DUPLICATE_GUARD_TRIGGERED"
          : error.code === "CRITICAL_DUPLICATE_STATE"),
    );
  }
  console.log("OK 4-5: el chequeo inmediato bloquea una o multiples coincidencias.");
}

async function testPlanAndInputBlocks() {
  const revalidatedPlan = createPlan();
  const revalidatedFake = fakeCreateAdapter();
  const revalidated = await runCreate(revalidatedPlan, revalidatedFake, {
    revalidation: {
      ...createRevalidation(revalidatedPlan),
      ok: false,
      status: "FAILED",
      matches: [{ productId: 1, variantId: 2, sku: revalidatedPlan.normalizedSku }],
      issues: [{ code: "CREATE_ALREADY_EXISTS", message: "Ya existe." }],
    },
  });
  assert.equal(postCalls(revalidatedFake).length, 0);
  assert.equal(revalidated.result.executionStatus, "BLOCKED");

  const invalidPlans = [
    (() => createPlan({ availability: "UNKNOWN" }))(),
    (() => {
      const plan = createPlan();
      plan.supplier.name = "   ";
      return plan;
    })(),
    (() => {
      const plan = createPlan();
      plan.plans.price.calculation.calculatedPrice = 0;
      return plan;
    })(),
    (() => {
      const plan = createPlan();
      plan.plans.status.desiredPublished = null;
      return plan;
    })(),
  ];
  for (const plan of invalidPlans) {
    const fake = fakeCreateAdapter();
    await runCreate(plan, fake);
    assert.equal(postCalls(fake).length, 0);
  }
  console.log("OK 6-10: revalidation, disponibilidad, nombre, precio y published bloquean CREATE.");
}

async function testPostFailuresAndAmbiguity() {
  const failed = fakeCreateAdapter({ failBeforeResponse: true });
  const failedResult = await runCreate(createPlan(), failed);
  assert.equal(postCalls(failed).length, 1);
  assert.equal(createAction(failedResult).executionResult, "WRITE_FAILED");

  const recovered = fakeCreateAdapter({ ambiguous: true });
  const recoveredResult = await runCreate(createPlan(), recovered);
  assert.equal(postCalls(recovered).length, 1);
  assert.equal(createAction(recoveredResult).executionResult, "WRITE_SUCCEEDED");
  assert.equal(createAction(recoveredResult).createSucceeded, false);
  assert.equal(createAction(recoveredResult).verified, true);

  const missing = fakeCreateAdapter({ ambiguous: true, applyAmbiguous: false });
  const missingResult = await runCreate(createPlan(), missing);
  assert.equal(postCalls(missing).length, 1);
  assert.equal(createAction(missingResult).executionResult, "WRITE_VERIFICATION_FAILED");
  assert(createAction(missingResult).errors.some((error) => error.code === "CREATE_WRITE_AMBIGUOUS"));

  const duplicates = fakeCreateAdapter({
    ambiguous: true,
    postCreateMatchCount: 2,
  });
  const duplicateResult = await runCreate(createPlan(), duplicates);
  assert.equal(postCalls(duplicates).length, 1);
  assert(
    createAction(duplicateResult).errors.some(
      (error) => error.code === "CREATE_MULTIPLE_MATCHES_AFTER_WRITE",
    ),
  );
  console.log("OK 11-14: no hay retry ciego y el POST ambiguo se resuelve solo mediante lecturas.");
}

async function testVerificationFailures() {
  const cases = [
    {
      options: { responseProduct: (product) => ({ ...product, id: 999 }) },
      code: "CREATE_IDENTITY_MISMATCH",
    },
    {
      options: { mutateProduct: (product) => ({ ...product, variants: [{ ...product.variants[0], sku: "OTRO" }] }) },
      code: "CREATE_IDENTITY_MISMATCH",
    },
    {
      options: { mutateProduct: (product) => ({ ...product, variants: [{ ...product.variants[0], price: "999" }] }) },
      code: "CREATE_WRITE_VERIFICATION_FAILED",
    },
    {
      options: { mutateProduct: (product) => ({ ...product, published: !product.published }) },
      code: "CREATE_WRITE_VERIFICATION_FAILED",
    },
    {
      options: { mutateProduct: (product) => ({ ...product, name: "Nombre distinto" }) },
      code: "CREATE_WRITE_VERIFICATION_FAILED",
    },
  ];

  for (const item of cases) {
    const fake = fakeCreateAdapter(item.options);
    const result = await runCreate(createPlan(), fake);
    const action = createAction(result);
    assert.equal(action.executionResult, "WRITE_VERIFICATION_FAILED");
    assert(action.errors.some((error) => error.code === item.code));
  }
  console.log("OK 15-19: identidad, SKU, precio, published y nombre se verifican tras CREATE.");
}

async function testImagePolicy() {
  const withImage = await testSuccessfulCreate("SAFE_TRANSFORM");
  assert.equal(withImage.action.imageIncluded, true);
  assert(withImage.fake.calls.some((call) => call.method === "GET_IMAGES"));

  const missingImage = fakeCreateAdapter({ imageMissing: true });
  const missingResult = await runCreate(createPlan(), missingImage);
  assert.equal(createAction(missingResult).executionResult, "WRITE_VERIFICATION_FAILED");

  const noImagePlan = createPlan({ image: false });
  const noImageFake = fakeCreateAdapter();
  const noImageResult = await runCreate(noImagePlan, noImageFake);
  assert.equal(createAction(noImageResult).executionResult, "WRITE_SUCCEEDED");
  assert.equal(createAction(noImageResult).imageIncluded, false);
  assert.equal(noImageFake.calls.some((call) => call.method === "GET_IMAGES"), false);
  console.log("OK 20-22: imagen inicial se verifica y la politica permite CREATE sin imagen.");
}

async function testIdempotency() {
  const plan = createPlan();
  const fake = fakeCreateAdapter();
  const first = await runCreate(plan, fake);
  const second = await runCreate(plan, fake);
  assert.equal(createAction(first).executionResult, "WRITE_SUCCEEDED");
  assert.equal(createAction(second).executionResult, "BLOCKED");
  assert.equal(postCalls(fake).length, 1);
  console.log("OK 23: segunda ejecucion encuentra el SKU y no repite POST.");
}

async function testGatesAndIsolation() {
  const environments = [
    { ...OPEN_CREATE_ENV, TIENDANUBE_CREATE_EXECUTION_ENABLED: "false" },
    { ...OPEN_CREATE_ENV, TIENDANUBE_EXECUTION_ENABLED: "false" },
    { ...OPEN_CREATE_ENV, TIENDANUBE_DRY_RUN: "true" },
    {
      ...OPEN_CREATE_ENV,
      TIENDANUBE_CREATE_EXECUTION_ENABLED: "false",
      TIENDANUBE_PRICE_EXECUTION_ENABLED: "true",
    },
  ];
  for (const env of environments) {
    const fake = fakeCreateAdapter();
    const result = await runCreate(createPlan(), fake, { env });
    assert.equal(postCalls(fake).length, 0);
    assert.equal(createAction(result).executionResult, "SIMULATED");
  }

  const isolated = fakeCreateAdapter();
  const isolatedResult = await runCreate(createPlan(), isolated);
  assert.equal(isolatedResult.createWriteRequested, true);
  assert.equal(isolatedResult.priceWriteRequested, false);
  assert.equal(isolatedResult.statusWriteRequested, false);
  assert.equal(isolatedResult.imageWriteRequested, false);
  assert.deepEqual(isolatedResult.writeOperationsAvailableByDomain, {
    price: false,
    status: false,
    image: false,
    create: true,
  });
  console.log("OK 24-28: CREATE requiere sus tres gates y queda aislado por dominio.");
}

async function testUnsupportedClassifications() {
  const plans = [
    (() => {
      const plan = basePlan({ classification: "LEGACY_GROUP" });
      plan.tiendanube.legacyGroup = { valid: true };
      return plan;
    })(),
    basePlan(),
    (() => {
      const plan = basePlan({ classification: "MANUAL_REVIEW" });
      plan.supplierResolution = { type: "AMBIGUOUS" };
      plan.errors = [{ code: "MANUAL_REVIEW", message: "Revision manual." }];
      return plan;
    })(),
  ];
  for (const plan of plans) {
    const fake = fakeCreateAdapter();
    const revalidation = successfulRevalidation(plan);
    await runControlled(plan, revalidation, {
      env: OPEN_CREATE_ENV,
      createAdapter: fake.adapter,
    });
    assert.equal(postCalls(fake).length, 0);
  }
  console.log("OK 29-31: LEGACY_GROUP, SINGLE y MANUAL_REVIEW nunca ejecutan CREATE.");
}

async function testPayloadAllowlistAndNoFollowupWrites() {
  const run = await testSuccessfulCreate("SAFE_TRANSFORM");
  const payload = postCalls(run.fake)[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ["images", "name", "published", "variants"]);
  assert.deepEqual(Object.keys(payload.variants[0]).sort(), ["price", "sku"]);
  assert.deepEqual(Object.keys(payload.images[0]).sort(), ["position", "src"]);
  assert.doesNotThrow(() => validateCreatePayload(payload));
  assert.throws(
    () => validateCreatePayload({ ...payload, description: "No permitido" }),
    (error) => error.code === "CREATE_PAYLOAD_INVALID",
  );
  assert.equal(
    run.fake.calls.filter((call) => call.method === "POST_PRODUCT").length,
    1,
  );
  assert.equal(
    run.fake.calls.some((call) =>
      ["PUT_PRICE", "PUT_STATUS", "POST_IMAGE", "DELETE_IMAGE"].includes(call.method)),
    false,
  );
  console.log("OK 32-33: payload allowlist estricto y ningun write posterior PRICE/STATUS/IMAGE.");
}

async function main() {
  await testSuccessAndResolutionTypes();
  await testPreWriteDuplicateGuards();
  await testPlanAndInputBlocks();
  await testPostFailuresAndAmbiguity();
  await testVerificationFailures();
  await testImagePolicy();
  await testIdempotency();
  await testGatesAndIsolation();
  await testUnsupportedClassifications();
  await testPayloadAllowlistAndNoFollowupWrites();
  console.log("Resultado: OK. CREATE_SINGLE cubre los 33 escenarios controlados sin HTTP real.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test CREATE_SINGLE: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { fakeCreateAdapter, main };
