const assert = require("assert/strict");
const { selectArcoreImageSource } = require("../extractor/arcoreImageSource");
const { calculateExactImageHash } = require("../tiendanube/imageFingerprint");
const { clone, runControlled } = require("./testExecutor");
const {
  legacyPlan,
  legacyRevalidation,
  pairKey,
} = require("./testLegacyPriceExecution");

const IMAGE_ENV = {
  TIENDANUBE_DRY_RUN: "false",
  TIENDANUBE_EXECUTION_ENABLED: "true",
  TIENDANUBE_PRICE_EXECUTION_ENABLED: "false",
  TIENDANUBE_STATUS_EXECUTION_ENABLED: "false",
  TIENDANUBE_IMAGE_EXECUTION_ENABLED: "true",
};

const SOURCE_URL = "https://www.arcore.com/catalogoWeb/imagenes/legacy/full.png";
const SOURCE_BUFFER = Buffer.from("legacy-source-image");
const DIFFERENT_BUFFER = Buffer.from("legacy-target-image");

function fingerprint(buffer) {
  return calculateExactImageHash(buffer);
}

function oldUrl(productId) {
  return `https://tiendanube.example/${productId}/old.png`;
}

function newUrl(productId) {
  return `https://tiendanube.example/${productId}/new.png`;
}

function legacyImagePlan(modes = ["replace", "replace"], options = {}) {
  const plan = legacyPlan(modes.map(() => 150), 150);
  plan.supplier.imageUrl = SOURCE_URL;
  plan.supplier.imageSourceType = options.imageSourceType || "COVER_FULL";
  const publications = plan.tiendanube.matches.map((item, index) => {
    const oldImageId = 401 + index * 10;
    const secondaryIds = options.secondaryIdsByIndex?.[index] || [];
    const imageIds = [oldImageId, ...secondaryIds];
    const noChange = modes[index] === "no-change";
    return {
      productId: item.productId,
      variantId: item.variantId,
      imageId: oldImageId,
      tiendanubeImageUrl: oldUrl(item.productId),
      tiendanubeImageCount: imageIds.length,
      tiendanubeImageIds: imageIds,
      sourceHash: fingerprint(SOURCE_BUFFER),
      tiendanubeHash: fingerprint(noChange ? SOURCE_BUFFER : DIFFERENT_BUFFER),
      comparison: {
        exactMatch: noChange,
        perceptualMatch: noChange,
        targetExactHash: fingerprint(noChange ? SOURCE_BUFFER : DIFFERENT_BUFFER),
      },
      action: noChange ? "IMAGE_NO_CHANGE" : "IMAGE_REPLACE",
      errors: [],
      warnings: secondaryIds.length > 0
        ? [{ code: "MULTIPLE_TN_IMAGES", message: "Hay imagenes secundarias." }]
        : [],
    };
  });
  plan.plans.image = {
    action: publications.every((item) => item.action === "IMAGE_NO_CHANGE")
      ? "IMAGE_NO_CHANGE"
      : "IMAGE_REPLACE",
    sourceImageUrl: SOURCE_URL,
    sourceHash: fingerprint(SOURCE_BUFFER),
    publications,
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

function optionSet(options, name) {
  return new Set(options[name] || []);
}

function fakeLegacyImageAdapter(plan, options = {}) {
  const calls = [];
  const uploadFailures = optionSet(options, "uploadFailures");
  const uploadVerificationMissing = optionSet(options, "uploadVerificationMissing");
  const uploadDifferent = optionSet(options, "uploadDifferent");
  const deleteFailures = optionSet(options, "deleteFailures");
  const finalKeepOld = optionSet(options, "finalKeepOld");
  const finalRemoveSecondary = optionSet(options, "finalRemoveSecondary");
  const equivalentPairs = optionSet(options, "equivalentPairs");
  const records = new Map();

  for (const publication of plan.plans.image.publications) {
    const pair = pairKey(publication);
    const customImages = options.imagesByPair?.[pair];
    const images = customImages || publication.tiendanubeImageIds.map((id, index) => ({
      id,
      src: index === 0
        ? oldUrl(publication.productId)
        : `https://tiendanube.example/${publication.productId}/secondary-${id}.png`,
      position: index + 1,
    }));
    records.set(pair, {
      pair,
      productId: publication.productId,
      variantId: publication.variantId,
      sku: plan.normalizedSku,
      oldImageId: publication.imageId,
      newImageId: 1401 + records.size * 10,
      images: clone(images),
      uploadCompleted: false,
      deleteCompleted: false,
    });
  }

  function recordByProduct(productId) {
    return Array.from(records.values()).find(
      (record) => String(record.productId) === String(productId),
    );
  }

  function visibleImages(record) {
    let images = clone(record.images);
    if (record.uploadCompleted && !record.deleteCompleted && uploadVerificationMissing.has(record.pair)) {
      images = images.filter((image) => String(image.id) !== String(record.newImageId));
    }
    if (record.deleteCompleted && finalRemoveSecondary.has(record.pair)) {
      images = images.filter((image) => String(image.id) === String(record.newImageId));
    }
    return images;
  }

  const adapter = {
    async getProduct(productId) {
      calls.push({ method: "GET_PRODUCT", productId });
      const record = recordByProduct(productId);
      if (!record) throw new Error(`Producto de prueba inexistente: ${productId}`);
      const override = record.uploadCompleted
        ? options.postUploadIdentity?.[record.pair] || options.identityOverrides?.[record.pair] || {}
        : options.identityOverrides?.[record.pair] || {};
      return {
        id: override.productId ?? record.productId,
        variants: [{
          id: override.variantId ?? record.variantId,
          sku: override.sku ?? record.sku,
        }],
      };
    },
    async listProductImages(productId) {
      calls.push({ method: "GET_IMAGES", productId });
      const record = recordByProduct(productId);
      if (!record) throw new Error(`Producto de prueba inexistente: ${productId}`);
      return visibleImages(record);
    },
    async uploadProductImage(productId, payload) {
      const record = recordByProduct(productId);
      calls.push({ method: "POST_IMAGE", productId, payload });
      if (uploadFailures.has(record.pair)) throw new Error("Upload simulado fallido.");
      record.uploadCompleted = true;
      record.images = record.images.map((image) => ({
        ...image,
        position: Number(image.position) + 1,
      }));
      record.images.unshift({
        id: record.newImageId,
        src: newUrl(productId),
        position: 1,
      });
      return { id: record.newImageId, src: newUrl(productId), position: 1 };
    },
    async deleteProductImage(productId, imageId) {
      const record = recordByProduct(productId);
      calls.push({ method: "DELETE_IMAGE", productId, imageId });
      if (deleteFailures.has(record.pair)) throw new Error("Delete simulado fallido.");
      record.deleteCompleted = true;
      if (!finalKeepOld.has(record.pair)) {
        record.images = record.images.filter(
          (image) => String(image.id) !== String(imageId),
        );
      }
      return null;
    },
  };

  const imageTools = {
    calculateExactImageHash,
    compareImageBuffers: compareBuffers,
    async downloadImageBuffer(url) {
      if (url === SOURCE_URL) return SOURCE_BUFFER;
      const record = Array.from(records.values()).find(
        (item) => url === oldUrl(item.productId) || url === newUrl(item.productId),
      );
      if (!record) throw new Error(`URL de prueba inesperada: ${url}`);
      if (url === newUrl(record.productId)) {
        return uploadDifferent.has(record.pair) ? DIFFERENT_BUFFER : SOURCE_BUFFER;
      }
      return equivalentPairs.has(record.pair) ? SOURCE_BUFFER : DIFFERENT_BUFFER;
    },
  };

  return { adapter, calls, imageTools, records };
}

function calls(fake, method) {
  return fake.calls.filter((call) => call.method === method);
}

function imageActions(result) {
  return result.executionPlan.actions.filter((action) => action.type === "IMAGE");
}

async function executeImage(plan, fake, options = {}) {
  return runControlled(
    plan,
    options.revalidation || legacyRevalidation(plan),
    {
      env: options.env || IMAGE_ENV,
      imageAdapter: fake.adapter,
      imageTools: fake.imageTools,
      ...(options.priceAdapter ? { priceAdapter: options.priceAdapter } : {}),
      ...(options.statusAdapter ? { statusAdapter: options.statusAdapter } : {}),
    },
  );
}

async function testSuccessfulAndMixedExecution() {
  const plan = legacyImagePlan();
  const fake = fakeLegacyImageAdapter(plan);
  const result = await executeImage(plan, fake);
  assert.equal(calls(fake, "POST_IMAGE").length, 2);
  assert.equal(calls(fake, "DELETE_IMAGE").length, 2);
  assert(imageActions(result).every((action) => action.executionResult === "WRITE_SUCCEEDED"));
  assert.equal(result.result.imageSummary.executionStatus, "SUCCESS");
  assert.equal(result.result.imageSummary.expectedPublicationCount, 2);
  assert.equal(result.result.imageSummary.actualPublicationCount, 2);
  assert.equal(result.result.imageSummary.uploadAttemptedCount, 2);
  assert.equal(result.result.imageSummary.deleteSucceededCount, 2);

  const mixedPlan = legacyImagePlan(["no-change", "replace"]);
  const mixedFake = fakeLegacyImageAdapter(mixedPlan, {
    equivalentPairs: [pairKey(mixedPlan.plans.image.publications[0])],
  });
  const mixed = await executeImage(mixedPlan, mixedFake);
  assert.equal(calls(mixedFake, "POST_IMAGE").length, 1);
  assert.equal(calls(mixedFake, "DELETE_IMAGE").length, 1);
  assert.equal(imageActions(mixed)[0].executionResult, "SKIPPED_ALREADY_APPLIED");
  assert.equal(imageActions(mixed)[1].executionResult, "WRITE_SUCCEEDED");
  assert.equal(mixed.result.imageSummary.skippedAlreadyAppliedCount, 1);
  console.log("OK 1-2: reemplazo total y grupo mixto escriben solo publicaciones elegibles.");
}

async function testPreWriteEquivalenceAndIdempotency() {
  const plan = legacyImagePlan();
  const pairs = plan.plans.image.publications.map(pairKey);
  const fake = fakeLegacyImageAdapter(plan, { equivalentPairs: pairs });
  const result = await executeImage(plan, fake);
  assert.equal(calls(fake, "POST_IMAGE").length, 0);
  assert(imageActions(result).every(
    (action) => action.executionResult === "SKIPPED_ALREADY_APPLIED",
  ));

  const rebuilt = legacyImagePlan(["no-change", "no-change"]);
  const rebuiltPairs = rebuilt.plans.image.publications.map(pairKey);
  const secondFake = fakeLegacyImageAdapter(rebuilt, { equivalentPairs: rebuiltPairs });
  const second = await executeImage(rebuilt, secondFake);
  assert.equal(calls(secondFake, "POST_IMAGE").length, 0);
  assert.equal(calls(secondFake, "DELETE_IMAGE").length, 0);
  assert.equal(second.result.imageSummary.executionStatus, "NO_CHANGES");
  console.log("OK 3/19: equivalencia pre-write y segunda planificacion son idempotentes.");
}

async function testStructuralIntegrity() {
  const cases = [
    ["faltante", (plan, revalidation) => {
      revalidation.matches.pop();
      revalidation.legacyGroup.actualMatches -= 1;
    }],
    ["extra", (plan, revalidation) => {
      revalidation.matches.push({ ...revalidation.matches[0], productId: 999, variantId: 1999 });
      revalidation.legacyGroup.actualMatches += 1;
    }],
    ["whitelist", (plan, revalidation) => {
      revalidation.matches[0].productId = 999;
    }],
    ["SKU", (plan, revalidation) => {
      revalidation.matches[0].sku = "SKU-DISTINTO";
    }],
  ];
  for (const [name, mutate] of cases) {
    const plan = legacyImagePlan();
    const revalidation = legacyRevalidation(plan);
    mutate(plan, revalidation);
    const fake = fakeLegacyImageAdapter(plan);
    const result = await executeImage(plan, fake, { revalidation });
    assert.equal(fake.calls.length, 0, name);
    assert(imageActions(result).every((action) => action.executionResult === "BLOCKED"), name);
    assert.equal(result.result.executionStatus, "BLOCKED", name);
    assert(result.errors.some((error) => error.code === "GROUP_INTEGRITY_FAILED"), name);
  }
  console.log("OK 4-7: cardinalidad, whitelist y SKU bloquean el grupo antes del adapter.");
}

async function testRuntimeIntegrityStopsRemaining() {
  for (const [name, buildOptions, expectedCode] of [
    [
      "identidad",
      (plan) => ({ identityOverrides: { [pairKey(plan.plans.image.publications[0])]: { variantId: 999 } } }),
      "IMAGE_PREWRITE_IDENTITY_MISMATCH",
    ],
    [
      "oldImageId",
      (plan) => {
        const publication = plan.plans.image.publications[0];
        return {
          imagesByPair: {
            [pairKey(publication)]: [{ id: 999, src: oldUrl(publication.productId), position: 1 }],
          },
        };
      },
      "IMAGE_PREWRITE_PRIMARY_CHANGED",
    ],
    [
      "imageSet",
      (plan) => {
        const publication = plan.plans.image.publications[0];
        return {
          imagesByPair: {
            [pairKey(publication)]: [
              { id: publication.imageId, src: oldUrl(publication.productId), position: 1 },
              { id: 999, src: "https://tiendanube.example/extra.png", position: 2 },
            ],
          },
        };
      },
      "IMAGE_PREWRITE_PRIMARY_CHANGED",
    ],
  ]) {
    const plan = legacyImagePlan();
    const fake = fakeLegacyImageAdapter(plan, buildOptions(plan));
    const result = await executeImage(plan, fake);
    assert.equal(calls(fake, "POST_IMAGE").length, 0, name);
    assert(imageActions(result)[0].errors.some((error) => error.code === expectedCode), name);
    assert.equal(imageActions(result)[1].executionResult, "BLOCKED", name);
    assert.equal(
      calls(fake, "GET_PRODUCT").filter(
        (call) => call.productId === plan.plans.image.publications[1].productId,
      ).length,
      0,
      name,
    );
  }
  console.log("OK 8-10/20: fallos criticos de identidad o set detienen publicaciones restantes.");
}

async function testIndependentFailuresContinue() {
  const uploadPlan = legacyImagePlan();
  const firstPair = pairKey(uploadPlan.plans.image.publications[0]);
  const uploadFake = fakeLegacyImageAdapter(uploadPlan, { uploadFailures: [firstPair] });
  const upload = await executeImage(uploadPlan, uploadFake);
  assert.equal(imageActions(upload)[0].executionResult, "WRITE_FAILED");
  assert.equal(imageActions(upload)[1].executionResult, "WRITE_SUCCEEDED");
  assert.equal(calls(uploadFake, "POST_IMAGE").length, 2);
  assert.equal(calls(uploadFake, "DELETE_IMAGE").length, 1);

  const verifyPlan = legacyImagePlan();
  const verifyPair = pairKey(verifyPlan.plans.image.publications[0]);
  const verifyFake = fakeLegacyImageAdapter(verifyPlan, {
    uploadVerificationMissing: [verifyPair],
  });
  const verify = await executeImage(verifyPlan, verifyFake);
  assert.equal(imageActions(verify)[0].executionResult, "WRITE_VERIFICATION_FAILED");
  assert.equal(imageActions(verify)[1].executionResult, "WRITE_SUCCEEDED");
  assert.equal(calls(verifyFake, "DELETE_IMAGE").length, 1);

  const deletePlan = legacyImagePlan();
  const deletePair = pairKey(deletePlan.plans.image.publications[0]);
  const deleteFake = fakeLegacyImageAdapter(deletePlan, { deleteFailures: [deletePair] });
  const deleted = await executeImage(deletePlan, deleteFake);
  assert.equal(imageActions(deleted)[0].executionResult, "PARTIAL_FAILURE");
  assert.equal(imageActions(deleted)[0].partial, true);
  assert.equal(imageActions(deleted)[1].executionResult, "WRITE_SUCCEEDED");
  assert.equal(deleted.result.imageSummary.partialFailureCount, 1);
  const deleteRecord = deleteFake.records.get(deletePair);
  assert(deleteRecord.images.some((image) => image.id === deleteRecord.oldImageId));
  assert(deleteRecord.images.some((image) => image.id === deleteRecord.newImageId));
  console.log("OK 11-13: fallos locales preservan seguridad y permiten continuar el grupo.");
}

async function testFinalVerificationAndSecondaries() {
  const finalPlan = legacyImagePlan();
  const finalPair = pairKey(finalPlan.plans.image.publications[0]);
  const finalFake = fakeLegacyImageAdapter(finalPlan, { finalKeepOld: [finalPair] });
  const finalResult = await executeImage(finalPlan, finalFake);
  assert.equal(imageActions(finalResult)[0].executionResult, "WRITE_VERIFICATION_FAILED");
  assert.equal(imageActions(finalResult)[1].executionResult, "WRITE_SUCCEEDED");

  const secondaryPlan = legacyImagePlan(["replace", "replace"], {
    secondaryIdsByIndex: [[402, 403], []],
  });
  const secondaryFake = fakeLegacyImageAdapter(secondaryPlan);
  const secondaryResult = await executeImage(secondaryPlan, secondaryFake);
  const record = secondaryFake.records.get(pairKey(secondaryPlan.plans.image.publications[0]));
  assert.equal(imageActions(secondaryResult)[0].executionResult, "WRITE_SUCCEEDED");
  assert(record.images.some((image) => image.id === 402));
  assert(record.images.some((image) => image.id === 403));
  assert.deepEqual(imageActions(secondaryResult)[0].secondaryImageIds, ["402", "403"]);

  const ambiguousPlan = legacyImagePlan(["replace", "replace"], {
    secondaryIdsByIndex: [[402], []],
  });
  const ambiguousPublication = ambiguousPlan.plans.image.publications[0];
  const ambiguousFake = fakeLegacyImageAdapter(ambiguousPlan, {
    imagesByPair: {
      [pairKey(ambiguousPublication)]: [
        { id: ambiguousPublication.imageId, src: oldUrl(ambiguousPublication.productId), position: 1 },
        { id: 402, src: "https://tiendanube.example/secondary.png", position: 1 },
      ],
    },
  });
  const ambiguous = await executeImage(ambiguousPlan, ambiguousFake);
  assert.equal(calls(ambiguousFake, "POST_IMAGE").length, 0);
  assert(imageActions(ambiguous)[0].errors.some(
    (error) => error.code === "IMAGE_PRIMARY_AMBIGUOUS",
  ));
  assert.equal(imageActions(ambiguous)[1].executionResult, "BLOCKED");
  console.log("OK 14-16: verificacion final, secundarias y primaria ambigua quedan controladas.");
}

async function testDomainIsolationAndGates() {
  const plan = legacyImagePlan();
  plan.supplier.availability = "UNAVAILABLE";
  plan.plans.status.action = "UNPUBLISH";
  plan.plans.status.desiredPublished = false;
  plan.plans.status.publications.forEach((publication) => {
    publication.action = "UNPUBLISH";
    publication.desiredPublished = false;
  });
  plan.plans.price.action = "PRICE_UPDATE";
  plan.plans.price.publications.forEach((publication) => {
    publication.action = "PRICE_UPDATE";
    publication.currentPrice = 100;
  });
  const fake = fakeLegacyImageAdapter(plan);
  const result = await executeImage(plan, fake);
  assert.equal(calls(fake, "POST_IMAGE").length, 2);
  assert.equal(result.imageWriteRequested, true);
  assert.equal(result.priceWriteRequested, false);
  assert.equal(result.statusWriteRequested, false);
  assert.equal(result.writeOperationsAvailableByDomain.image, true);
  const isolatedActions = result.executionPlan.actions
    .filter((action) => ["PRICE", "STATUS"].includes(action.type));
  assert(
    isolatedActions.every((action) => action.executionResult === "SIMULATED"),
    JSON.stringify(isolatedActions),
  );

  for (const [name, env] of [
    ["image gate", { ...IMAGE_ENV, TIENDANUBE_IMAGE_EXECUTION_ENABLED: "false" }],
    ["global gate", { ...IMAGE_ENV, TIENDANUBE_EXECUTION_ENABLED: "false" }],
    ["dry-run", { ...IMAGE_ENV, TIENDANUBE_DRY_RUN: "true" }],
  ]) {
    const gatedPlan = legacyImagePlan();
    const gatedFake = fakeLegacyImageAdapter(gatedPlan);
    const gated = await executeImage(gatedPlan, gatedFake, { env });
    assert.equal(gatedFake.calls.length, 0, name);
    assert.equal(gated.imageWriteRequested, false, name);
    assert(imageActions(gated).every(
      (action) => action.executionResult === "SIMULATED",
    ), name);
  }

  const noSourcePlan = legacyImagePlan();
  noSourcePlan.supplier.imageUrl = null;
  noSourcePlan.supplier.imageSourceType = null;
  noSourcePlan.plans.image = {
    action: "NO_SOURCE_IMAGE",
    sourceImageUrl: null,
    sourceHash: null,
    publications: [],
    errors: [],
    warnings: [{ code: "NO_SOURCE_IMAGE", message: "Sin imagen proveedor." }],
  };
  const noSourceFake = fakeLegacyImageAdapter(noSourcePlan);
  const noSource = await executeImage(noSourcePlan, noSourceFake);
  assert.equal(noSourceFake.calls.length, 0);
  assert.equal(noSource.writeOperationsAvailableByDomain.image, false);
  console.log("OK 17-18: el gate IMAGE queda aislado de PRICE y STATUS.");
}

async function testResolutionTypesAndSources() {
  for (const type of ["SAFE_TRANSFORM", "EXACT"]) {
    const plan = legacyImagePlan();
    if (type === "SAFE_TRANSFORM") {
      plan.warnings.push({
        code: "ARCORE_SAFE_TRANSFORM_USED",
        message: "Se aplico APPEND_TRAILING_ZERO.",
      });
    }
    plan.supplierResolution = type === "EXACT"
      ? {
        type,
        sourceCode: plan.normalizedSku,
        matchedCode: plan.normalizedSku,
        rule: null,
      }
      : plan.supplierResolution;
    const fake = fakeLegacyImageAdapter(plan);
    const result = await executeImage(plan, fake);
    assert.equal(calls(fake, "POST_IMAGE").length, 2, type);
    assert.equal(result.result.imageSummary.executionStatus, "SUCCESS", type);
    if (type === "SAFE_TRANSFORM") {
      assert(result.warnings.some(
        (warning) => warning.code === "ARCORE_SAFE_TRANSFORM_USED",
      ));
    }
  }

  const full = selectArcoreImageSource({
    cover: {
      foto: "16/LK/full.png",
      thumbnail: "thumbnails/16/LK/thumb_min.png",
    },
    fotos: [{ foto: "16/LK/secondary.png" }],
  });
  assert.equal(full.imageSourceType, "COVER_FULL");
  assert.equal(full.imageUrl, "https://www.arcore.com/catalogoWeb/imagenes/16/LK/full.png");

  const fallback = selectArcoreImageSource({
    cover: { foto: "", thumbnail: "thumbnails/16/LK/thumb_min.png" },
    fotos: [{ foto: "16/LK/secondary.png" }],
  });
  assert.equal(fallback.imageSourceType, "COVER_THUMBNAIL_FALLBACK");
  assert.equal(
    fallback.imageUrl,
    "https://www.arcore.com/catalogoWeb/imagenes/thumbnails/16/LK/thumb_min.png",
  );
  console.log("OK 21-24: EXACT/SAFE_TRANSFORM y seleccion cover foto/thumbnail son explicitos.");
}

async function main() {
  await testSuccessfulAndMixedExecution();
  await testPreWriteEquivalenceAndIdempotency();
  await testStructuralIntegrity();
  await testRuntimeIntegrityStopsRemaining();
  await testIndependentFailuresContinue();
  await testFinalVerificationAndSecondaries();
  await testDomainIsolationAndGates();
  await testResolutionTypesAndSources();
  console.log("Resultado: OK. Casos 1-24 de IMAGE LEGACY_GROUP cubiertos con adapters mock.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test IMAGE LEGACY_GROUP: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
