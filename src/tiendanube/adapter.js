function buildStubResult(action, payload = {}) {
  return {
    ok: true,
    stub: true,
    action,
    message:
      "Tiendanube adapter stub: no se realizo ninguna llamada real a la API.",
    payload,
  };
}

async function findBySku(sku) {
  console.log(`[TiendanubeStub] findBySku(${sku})`);
  return buildStubResult("findBySku", {
    sku,
    found: false,
    product: null,
  });
}

async function createProduct(productPayload) {
  console.log(`[TiendanubeStub] createProduct(${productPayload?.sku || "sin sku"})`);
  return buildStubResult("createProduct", {
    sku: productPayload?.sku || null,
    productPayload,
  });
}

async function updateProduct(productId, productPayload) {
  console.log(`[TiendanubeStub] updateProduct(${productId})`);
  return buildStubResult("updateProduct", {
    productId,
    sku: productPayload?.sku || null,
    productPayload,
  });
}

async function uploadImage(productId, imagePayload) {
  console.log(`[TiendanubeStub] uploadImage(${productId})`);
  return buildStubResult("uploadImage", {
    productId,
    imagePayload,
  });
}

module.exports = {
  createProduct,
  findBySku,
  updateProduct,
  uploadImage,
};
