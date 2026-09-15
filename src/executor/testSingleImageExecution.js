const assert = require("assert/strict");
const {
  calculateExactImageHash,
} = require("../tiendanube/imageFingerprint");
const {
  basePlan,
  clone,
  createPlan,
  runControlled,
  successfulRevalidation,
} = require("./testExecutor");
const {
  legacyPlan,
  legacyRevalidation,
} = require("./testLegacyPriceExecution");
const { validateUploadPayload } = require("./tiendanubeImageAdapter");

const IMAGE_ENV = {
  TIENDANUBE_DRY_RUN: "false",
  TIENDANUBE_EXECUTION_ENABLED: "true",
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "false",
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "false",
  TIENDANUBE_IMAGE_EXECUTION_ENABLED: "true",
};

const SOURCE_URL = "https://www.arcore.com/source.png";
const OLD_URL = "https://tiendanube.example/old.png";
const NEW_URL = "https://tiendanube.example/new.png";
const SOURCE_BUFFER = Buffer.from("source-image-content");
const OLD_BUFFER = Buffer.from("different-old-image-content");

function fingerprint(buffer) {
  return calculateExactImageHash(buffer);
}

function imagePlan({ imageCount = 1, oldImageId = 401 } = {}) {
  const plan = basePlan();
  plan.supplier.imageUrl = SOURCE_URL;
  plan.plans.image = {
    action: "IMAGE_REPLACE",
    sourceImageUrl: SOURCE_URL,
    sourceHash: fingerprint(SOURCE_BUFFER),
    publications: [
      {
        productId: plan.tiendanube.productIds[0],
        variantId: plan.tiendanube.variantIds[0],
        tiendanubeImageCount: imageCount,
        tiendanubeImageIds: Array.from(
          { length: imageCount },
          (_value, index) => oldImageId + index,
        ),
        imageId: oldImageId,
        tiendanubeImageUrl: OLD_URL,
        sourceHash: fingerprint(SOURCE_BUFFER),
        tiendanubeHash: fingerprint(OLD_BUFFER),
        comparison: {
          exactMatch: false,
          perceptualMatch: false,
          targetExactHash: fingerprint(OLD_BUFFER),
        },
        action: "IMAGE_REPLACE",
        errors: [],
        warnings: imageCount > 1
          ? [{ code: "MULTIPLE_TN_IMAGES", message: "Multiples imagenes." }]
          : [],
      },
    ],
    errors: [],
    warnings: [],
  };
  return plan;
}

function compareBuffers(source, target) {
  const sourceExactHash = fingerprint(source);
  const targetExactHash = fingerprint(target);
  const exactMatch = sourceExactHash === targetExactHash;
  return Promise.resolve({
    exactMatch,
    perceptualMatch: exactMatch,
    method: exactMatch ? "EXACT" : "PERCEPTUAL",
    sourceExactHash,
    targetExactHash,
    distance: exactMatch ? 0 : 256,
    threshold: 20,
  });
}

function fakeImageTools(options = {}) {
  return {
    calculateExactImageHash,
    compareImageBuffers: compareBuffers,
    async downloadImageBuffer(url) {
      if (options.downloadErrorUrl === url) {
        const error = new Error(options.downloadErrorMessage || "Descarga simulada fallida.");
        error.code = options.downloadErrorCode || "IMAGE_DOWNLOAD_FAILED";
        error.contentType = options.contentType || null;
        error.url = url;
        throw error;
      }
      if (url === SOURCE_URL) return options.sourceBuffer || SOURCE_BUFFER;
      if (url === OLD_URL) return options.oldBuffer || OLD_BUFFER;
      if (url === NEW_URL) return options.newBuffer || SOURCE_BUFFER;
      throw new Error(`URL de prueba inesperada: ${url}`);
    },
  };
}

function fakeImageAdapter(plan, options = {}) {
  const calls = [];
  const productId = plan.tiendanube.productIds[0];
  const variantId = plan.tiendanube.variantIds[0];
  const oldImageId = plan.plans.image.publications[0]?.imageId || 401;
  const initialImages = options.images || [
    { id: oldImageId, src: OLD_URL, position: 1 },
  ];
  let images = clone(initialImages);
  let uploadCompleted = false;
  let deleteCompleted = false;

  function currentImages() {
    let result = clone(images);
    if (uploadCompleted && !deleteCompleted && options.uploadVerificationMissing) {
      result = result.filter((image) => String(image.id) !== "999");
    }
    if (deleteCompleted && options.finalMissingNew) {
      result = result.filter((image) => String(image.id) !== "999");
    }
    if (deleteCompleted && options.removeSecondaryAfterDelete) {
      result = result.filter((image) => Number(image.position) === 1);
    }
    return result;
  }

  return {
    calls,
    get images() {
      return currentImages();
    },
    adapter: {
      async getProduct(requestedProductId) {
        calls.push({ method: "GET_PRODUCT", productId: requestedProductId });
        const afterUploadOverride = uploadCompleted
          ? options.postUploadIdentity || {}
          : {};
        return {
          id: options.productId ?? afterUploadOverride.productId ?? productId,
          variants: [
            {
              id: options.variantId ?? afterUploadOverride.variantId ?? variantId,
              sku: options.sku ?? afterUploadOverride.sku ?? plan.normalizedSku,
            },
          ],
        };
      },
      async listProductImages(requestedProductId) {
        calls.push({ method: "GET_IMAGES", productId: requestedProductId });
        return currentImages();
      },
      async uploadProductImage(requestedProductId, payload) {
        calls.push({ method: "POST_IMAGE", productId: requestedProductId, payload });
        if (options.uploadFailure) throw new Error("Upload simulado fallido.");
        uploadCompleted = true;
        images = images.map((image) => ({
          ...image,
          position: Number(image.position) + 1,
        }));
        images.push({ id: 999, src: NEW_URL, position: 1 });
        return options.uploadWithoutId ? {} : { id: 999, src: NEW_URL, position: 1 };
      },
      async deleteProductImage(requestedProductId, imageId) {
        calls.push({ method: "DELETE_IMAGE", productId: requestedProductId, imageId });
        if (options.deleteFailure) throw new Error("Delete simulado fallido.");
        deleteCompleted = true;
        images = images.filter((image) => String(image.id) !== String(imageId));
        return null;
      },
    },
  };
}

function calls(fake, method) {
  return fake.calls.filter((call) => call.method === method);
}

function imageAction(result) {
  return result.executionPlan.actions.find((action) => action.type === "IMAGE");
}

async function executeImage(plan, fake, options = {}) {
  return runControlled(
    plan,
    options.revalidation || successfulRevalidation(plan),
    {
      env: options.env || IMAGE_ENV,
      imageAdapter: fake.adapter,
      imageTools: options.imageTools || fakeImageTools(),
      ...(options.priceAdapter ? { priceAdapter: options.priceAdapter } : {}),
      ...(options.statusAdapter ? { statusAdapter: options.statusAdapter } : {}),
    },
  );
}

async function testSimpleReplacement() {
  const plan = imagePlan();
  const fake = fakeImageAdapter(plan);
  const result = await executeImage(plan, fake);
  const action = imageAction(result);
  assert.equal(calls(fake, "POST_IMAGE").length, 1);
  assert.equal(calls(fake, "DELETE_IMAGE").length, 1);
  assert.deepEqual(calls(fake, "POST_IMAGE")[0].payload, {
    src: SOURCE_URL,
    position: 1,
  });
  assert.equal(action.executionResult, "WRITE_SUCCEEDED");
  assert.equal(action.oldImageId, 401);
  assert.equal(action.newImageId, 999);
  assert.equal(action.uploadAttempted, true);
  assert.equal(action.uploadSucceeded, true);
  assert.equal(action.uploadVerified, true);
  assert.equal(action.deleteAttempted, true);
  assert.equal(action.deleteSucceeded, true);
  assert.equal(action.finalVerified, true);
  assert.equal(result.result.executionStatus, "SUCCESS");
  assert.doesNotThrow(() => validateUploadPayload({ src: SOURCE_URL, position: 1 }));
  assert.throws(
    () => validateUploadPayload({ src: SOURCE_URL, position: 1, name: "no" }),
    (error) => error.code === "INVALID_IMAGE_UPLOAD_PAYLOAD",
  );
  console.log("OK 1: upload, verificacion, delete y GET final exitosos.");
}

async function testNoWritePlans() {
  const noChange = basePlan();
  const noChangeFake = fakeImageAdapter(imagePlan());
  const noChangeResult = await executeImage(noChange, noChangeFake, {
    revalidation: successfulRevalidation(noChange),
  });
  assert.equal(noChangeFake.calls.length, 0);
  assert.equal(imageAction(noChangeResult).executionResult, "SKIPPED_ALREADY_APPLIED");

  const noSource = basePlan();
  noSource.supplier.imageUrl = null;
  noSource.plans.image = {
    action: "NO_SOURCE_IMAGE",
    sourceImageUrl: null,
    sourceHash: null,
    publications: [],
    warnings: [{ code: "NO_SOURCE_IMAGE", message: "Sin imagen." }],
    errors: [],
  };
  const noSourceFake = fakeImageAdapter(imagePlan());
  const noSourceResult = await executeImage(noSource, noSourceFake, {
    revalidation: successfulRevalidation(noSource),
  });
  assert.equal(noSourceFake.calls.length, 0);
  assert.equal(imageAction(noSourceResult).executionResult, "SIMULATED");

  const createImage = imagePlan();
  createImage.plans.image.action = "IMAGE_CREATE";
  Object.assign(createImage.plans.image.publications[0], {
    action: "IMAGE_CREATE",
    imageId: null,
    tiendanubeHash: null,
    tiendanubeImageCount: 0,
  });
  const createImageFake = fakeImageAdapter(imagePlan());
  const createImageResult = await executeImage(createImage, createImageFake, {
    revalidation: successfulRevalidation(createImage),
  });
  assert.equal(createImageFake.calls.length, 0);
  assert.equal(imageAction(createImageResult).executionResult, "SIMULATED");
  console.log("OK 2-3: no-change, sin fuente e IMAGE_CREATE realizan cero writes.");
}

async function testSourceDownloadFailures() {
  for (const [code, contentType] of [
    ["IMAGE_DOWNLOAD_FAILED", null],
    ["INVALID_IMAGE_CONTENT_TYPE", "text/html"],
  ]) {
    const plan = imagePlan();
    const fake = fakeImageAdapter(plan);
    const result = await executeImage(plan, fake, {
      imageTools: fakeImageTools({
        downloadErrorUrl: SOURCE_URL,
        downloadErrorCode: code,
        contentType,
      }),
    });
    assert.equal(calls(fake, "POST_IMAGE").length, 0, code);
    assert.equal(calls(fake, "DELETE_IMAGE").length, 0, code);
    assert.equal(imageAction(result).executionResult, "BLOCKED", code);
    assert(imageAction(result).errors.some((error) => error.code === code), code);
  }
  console.log("OK 4-5: descarga fallida y content-type invalido bloquean antes del upload.");
}

async function testPreWriteIdentityAndPrimary() {
  for (const [name, options, expectedCode] of [
    ["productId", { productId: 9999 }, "IMAGE_PREWRITE_IDENTITY_MISMATCH"],
    ["SKU", { sku: "SKU-DISTINTO" }, "IMAGE_PREWRITE_IDENTITY_MISMATCH"],
    [
      "primaria",
      { images: [{ id: 777, src: OLD_URL, position: 1 }] },
      "IMAGE_PREWRITE_PRIMARY_CHANGED",
    ],
  ]) {
    const plan = imagePlan();
    const fake = fakeImageAdapter(plan, options);
    const result = await executeImage(plan, fake);
    assert.equal(calls(fake, "POST_IMAGE").length, 0, name);
    assert.equal(imageAction(result).executionResult, "BLOCKED", name);
    assert(imageAction(result).errors.some((error) => error.code === expectedCode), name);
  }
  console.log("OK 6-8: identidad, SKU y primaria inesperada bloquean sin upload.");
}

async function testUploadAndVerificationFailures() {
  const uploadPlan = imagePlan();
  const uploadFake = fakeImageAdapter(uploadPlan, { uploadFailure: true });
  const uploadResult = await executeImage(uploadPlan, uploadFake);
  assert.equal(calls(uploadFake, "POST_IMAGE").length, 1);
  assert.equal(calls(uploadFake, "DELETE_IMAGE").length, 0);
  assert.equal(imageAction(uploadResult).executionResult, "WRITE_FAILED");
  assert(imageAction(uploadResult).errors.some(
    (error) => error.code === "IMAGE_WRITE_FAILED"));
  assert(uploadFake.images.some((image) => image.id === 401));

  const verifyPlan = imagePlan();
  const verifyFake = fakeImageAdapter(verifyPlan, { uploadVerificationMissing: true });
  const verifyResult = await executeImage(verifyPlan, verifyFake);
  assert.equal(calls(verifyFake, "POST_IMAGE").length, 1);
  assert.equal(calls(verifyFake, "DELETE_IMAGE").length, 0);
  assert.equal(imageAction(verifyResult).executionResult, "WRITE_VERIFICATION_FAILED");
  assert(imageAction(verifyResult).errors.some(
    (error) => error.code === "IMAGE_WRITE_VERIFICATION_FAILED"));
  assert(verifyFake.images.some((image) => image.id === 401));

  const noIdPlan = imagePlan();
  const noIdFake = fakeImageAdapter(noIdPlan, { uploadWithoutId: true });
  const noIdResult = await executeImage(noIdPlan, noIdFake);
  assert.equal(calls(noIdFake, "DELETE_IMAGE").length, 0);
  assert.equal(imageAction(noIdResult).executionResult, "WRITE_VERIFICATION_FAILED");
  console.log("OK 9-10: upload o verificacion fallidos preservan la imagen vieja.");
}

async function testDeleteAndFinalVerificationFailures() {
  const deletePlan = imagePlan();
  const deleteFake = fakeImageAdapter(deletePlan, { deleteFailure: true });
  const deleteResult = await executeImage(deletePlan, deleteFake);
  const deleteAction = imageAction(deleteResult);
  assert.equal(calls(deleteFake, "DELETE_IMAGE").length, 1);
  assert.equal(deleteAction.executionResult, "PARTIAL_FAILURE");
  assert.equal(deleteAction.partial, true);
  assert.equal(deleteAction.updated, true);
  assert(deleteAction.errors.some((error) => error.code === "IMAGE_OLD_DELETE_FAILED"));
  assert(deleteFake.images.some((image) => image.id === 401));
  assert(deleteFake.images.some((image) => image.id === 999));
  assert.equal(deleteResult.result.executionStatus, "PARTIAL_FAILURE");

  const finalPlan = imagePlan();
  const finalFake = fakeImageAdapter(finalPlan, { finalMissingNew: true });
  const finalResult = await executeImage(finalPlan, finalFake);
  assert.equal(calls(finalFake, "DELETE_IMAGE").length, 1);
  assert.equal(imageAction(finalResult).executionResult, "WRITE_VERIFICATION_FAILED");
  assert.equal(imageAction(finalResult).finalVerified, false);
  console.log("OK 11-12: delete fallido es parcial y GET final fallido queda trazado.");
}

async function testPreWriteFingerprintDrift() {
  const sourcePlan = imagePlan();
  const sourceFake = fakeImageAdapter(sourcePlan);
  const sourceResult = await executeImage(sourcePlan, sourceFake, {
    imageTools: fakeImageTools({ sourceBuffer: Buffer.from("new-source") }),
  });
  assert.equal(calls(sourceFake, "POST_IMAGE").length, 0);
  assert(imageAction(sourceResult).errors.some(
    (error) => error.code === "IMAGE_SUPPLIER_DRIFT"));

  const targetPlan = imagePlan();
  const targetFake = fakeImageAdapter(targetPlan);
  const targetResult = await executeImage(targetPlan, targetFake, {
    imageTools: fakeImageTools({ oldBuffer: Buffer.from("changed-target") }),
  });
  assert.equal(calls(targetFake, "POST_IMAGE").length, 0);
  assert(imageAction(targetResult).errors.some(
    (error) => error.code === "IMAGE_TARGET_DRIFT"));

  const countPlan = imagePlan();
  const countFake = fakeImageAdapter(countPlan, {
    images: [
      { id: 401, src: OLD_URL, position: 1 },
      { id: 402, src: NEW_URL, position: 2 },
    ],
  });
  const countResult = await executeImage(countPlan, countFake);
  assert.equal(calls(countFake, "POST_IMAGE").length, 0);
  assert(imageAction(countResult).errors.some(
    (error) => error.code === "IMAGE_PREWRITE_PRIMARY_CHANGED"));

  const identityPlan = imagePlan({ imageCount: 2 });
  const identityRevalidation = successfulRevalidation(identityPlan);
  identityRevalidation.plans.image.publications[0].tiendanubeImageIds = [401, 999];
  const identityFake = fakeImageAdapter(identityPlan, {
    images: [
      { id: 401, src: OLD_URL, position: 1 },
      { id: 402, src: NEW_URL, position: 2 },
    ],
  });
  const identityResult = await executeImage(identityPlan, identityFake, {
    revalidation: identityRevalidation,
  });
  assert.equal(identityFake.calls.length, 0);
  assert.equal(imageAction(identityResult).executionResult, "BLOCKED");
  console.log("OK drift: fuente, target, cantidad o identidad bloquean antes del upload.");
}

async function testMultipleImages() {
  const images = [
    { id: 401, src: OLD_URL, position: 1 },
    { id: 402, src: "https://tiendanube.example/secondary-1.png", position: 2 },
    { id: 403, src: "https://tiendanube.example/secondary-2.png", position: 3 },
  ];
  const plan = imagePlan({ imageCount: images.length });
  const fake = fakeImageAdapter(plan, { images });
  const result = await executeImage(plan, fake);
  assert.equal(imageAction(result).executionResult, "WRITE_SUCCEEDED");
  assert(fake.images.some((image) => image.id === 402));
  assert(fake.images.some((image) => image.id === 403));
  assert(!fake.images.some((image) => image.id === 401));

  const ambiguousPlan = imagePlan({ imageCount: 2 });
  const ambiguousFake = fakeImageAdapter(ambiguousPlan, {
    images: [
      { id: 401, src: OLD_URL, position: 1 },
      { id: 402, src: "https://tiendanube.example/secondary.png", position: 1 },
    ],
  });
  const ambiguousResult = await executeImage(ambiguousPlan, ambiguousFake);
  assert.equal(calls(ambiguousFake, "POST_IMAGE").length, 0);
  assert.equal(imageAction(ambiguousResult).executionResult, "BLOCKED");
  assert(imageAction(ambiguousResult).errors.some(
    (error) => error.code === "IMAGE_PRIMARY_AMBIGUOUS"));

  const missingSecondaryPlan = imagePlan({ imageCount: images.length });
  const missingSecondaryFake = fakeImageAdapter(missingSecondaryPlan, {
    images,
    removeSecondaryAfterDelete: true,
  });
  const missingSecondaryResult = await executeImage(
    missingSecondaryPlan,
    missingSecondaryFake,
  );
  assert.equal(
    imageAction(missingSecondaryResult).executionResult,
    "WRITE_VERIFICATION_FAILED",
  );
  assert.equal(
    imageAction(missingSecondaryResult).verifiedState.secondaryImagesPreserved,
    false,
  );
  console.log("OK 13-14: secundarias verificadas y primaria ambigua bloqueada.");
}

async function testPreWriteAlreadyAppliedAndIdempotency() {
  const plan = imagePlan();
  const fake = fakeImageAdapter(plan);
  const tools = fakeImageTools({ oldBuffer: SOURCE_BUFFER });
  const first = await executeImage(plan, fake, { imageTools: tools });
  assert.equal(calls(fake, "POST_IMAGE").length, 0);
  assert.equal(imageAction(first).executionResult, "SKIPPED_ALREADY_APPLIED");
  assert.equal(imageAction(first).verified, true);

  const second = await executeImage(plan, fake, { imageTools: tools });
  assert.equal(calls(fake, "POST_IMAGE").length, 0);
  assert.equal(imageAction(second).executionResult, "SKIPPED_ALREADY_APPLIED");
  console.log("OK 15/20: equivalencia pre-write e idempotencia producen cero writes.");
}

async function testDomainIsolationAndGates() {
  const plan = imagePlan();
  plan.supplier.availability = "UNAVAILABLE";
  plan.plans.status.action = "UNPUBLISH";
  Object.assign(plan.plans.status.publications[0], {
    action: "UNPUBLISH",
    desiredPublished: false,
  });
  plan.plans.price.action = "PRICE_UPDATE";
  Object.assign(plan.plans.price.publications[0], {
    action: "PRICE_UPDATE",
    currentPrice: 100,
  });
  const fake = fakeImageAdapter(plan);
  const result = await executeImage(plan, fake);
  assert.equal(calls(fake, "POST_IMAGE").length, 1);
  assert.equal(result.imageWriteRequested, true);
  assert.equal(result.priceWriteRequested, false);
  assert.equal(result.statusWriteRequested, false);
  assert.deepEqual(result.writeOperationsAvailableByDomain, {
    price: false,
    status: false,
    image: true,
    create: false,
  });
  assert.equal(result.executionPlan.actions.find((item) => item.type === "PRICE").executionResult, "SIMULATED");
  assert.equal(result.executionPlan.actions.find((item) => item.type === "STATUS").executionResult, "SIMULATED");

  for (const [name, env] of [
    ["image gate cerrado", { ...IMAGE_ENV, TIENDANUBE_IMAGE_EXECUTION_ENABLED: "false" }],
    ["global cerrado", { ...IMAGE_ENV, TIENDANUBE_EXECUTION_ENABLED: "false" }],
    ["dry-run", { ...IMAGE_ENV, TIENDANUBE_DRY_RUN: "true" }],
  ]) {
    const gatedPlan = imagePlan();
    const gatedFake = fakeImageAdapter(gatedPlan);
    const gatedResult = await executeImage(gatedPlan, gatedFake, { env });
    assert.equal(gatedFake.calls.length, 0, name);
    assert.equal(gatedResult.imageWriteRequested, false, name);
  }
  console.log("OK 16-17: IMAGE aislada y gates cerrados impiden acceso al adapter.");
}

async function testUnsupportedClassifications() {
  const legacy = legacyPlan([150, 150]);
  legacy.plans.image = clone(imagePlan({ imageCount: 1 }).plans.image);
  legacy.plans.image.publications = legacy.tiendanube.matches.map((item, index) => ({
    ...clone(legacy.plans.image.publications[0]),
    productId: item.productId,
    variantId: item.variantId,
    imageId: 401 + index,
  }));
  const legacyFake = fakeImageAdapter(imagePlan());
  const legacyResult = await runControlled(legacy, legacyRevalidation(legacy), {
    env: IMAGE_ENV,
    imageAdapter: legacyFake.adapter,
    imageTools: fakeImageTools(),
  });
  assert.equal(legacyFake.calls.length, 0);
  assert(legacyResult.executionPlan.actions
    .filter((item) => item.type === "IMAGE")
    .every((item) => item.executionResult === "SIMULATED"));
  assert.equal(legacyResult.writeOperationsAvailableByDomain.image, false);

  const creation = createPlan();
  const creationFake = fakeImageAdapter(imagePlan());
  const creationResult = await runControlled(
    creation,
    {
      ok: true,
      status: "STILL_ABSENT",
      issues: [],
      matches: [],
      plans: clone(creation.plans),
    },
    {
      env: IMAGE_ENV,
      imageAdapter: creationFake.adapter,
      imageTools: fakeImageTools(),
    },
  );
  assert.equal(creationFake.calls.length, 0);
  assert.equal(creationResult.writeOperationsAvailableByDomain.image, false);
  assert.equal(
    creationResult.executionPlan.actions.find((item) => item.type === "CREATE_PRODUCT")
      .executionResult,
    "SIMULATED",
  );
  console.log("OK 18-19: IMAGE legacy y CREATE_SINGLE permanecen sin writes.");
}

async function main() {
  await testSimpleReplacement();
  await testNoWritePlans();
  await testSourceDownloadFailures();
  await testPreWriteIdentityAndPrimary();
  await testUploadAndVerificationFailures();
  await testDeleteAndFinalVerificationFailures();
  await testPreWriteFingerprintDrift();
  await testMultipleImages();
  await testPreWriteAlreadyAppliedAndIdempotency();
  await testDomainIsolationAndGates();
  await testUnsupportedClassifications();
  console.log("Resultado: OK. Casos 1-20 cubiertos con adapters mock.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test IMAGE SINGLE: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
