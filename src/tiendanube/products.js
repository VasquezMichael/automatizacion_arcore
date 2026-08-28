const { createTiendanubeClient } = require("./client");
const { normalizeSku } = require("./sku");

function buildApiError(message, response) {
  const error = new Error(message);
  error.response = response;
  return error;
}

function assertSuccess(response, label, acceptedStatuses = [200, 201]) {
  if (acceptedStatuses.includes(response.status)) return;
  throw buildApiError(`${label} fallo con status HTTP ${response.status}`, response);
}

function findExactVariantBySku(product, sku) {
  if (!product || !Array.isArray(product.variants)) return null;
  return product.variants.find((variant) => String(variant.sku || "") === String(sku));
}

function findNormalizedVariantBySku(product, normalizedSku) {
  if (!product || !Array.isArray(product.variants)) return null;
  return product.variants.find(
    (variant) => normalizeSku(variant.sku) === normalizedSku,
  );
}

function getPublished(product) {
  if (typeof product?.published === "boolean") return product.published;
  return product?.visibility === "visible";
}

function buildFoundProduct(product, variant, sourceSku, status, lookupMethod) {
  return {
    exists: true,
    productId: product.id,
    variantId: variant.id,
    sourceSku,
    matchedSku: variant.sku,
    normalizedSku: normalizeSku(sourceSku),
    published: getPublished(product),
    sku: variant.sku,
    product: {
      id: product.id,
      name: product.name,
      published: getPublished(product),
      visibility: product.visibility,
      variant,
    },
    status,
    lookupMethod,
  };
}

function buildMatchRecord(product, variant) {
  return {
    productId: product.id,
    variantId: variant.id,
    sku: variant.sku,
    matchedSku: variant.sku,
    normalizedSku: normalizeSku(variant.sku),
    published: getPublished(product),
    name: product.name,
    visibility: product.visibility,
  };
}

function collectVariantMatches(products, sourceSku) {
  const normalized = normalizeSku(sourceSku);
  const exactMatches = [];
  const normalizedMatches = [];

  for (const product of products) {
    const exactVariant = findExactVariantBySku(product, sourceSku);
    if (exactVariant) {
      exactMatches.push({ product, variant: exactVariant });
      continue;
    }

    const normalizedVariant = findNormalizedVariantBySku(product, normalized);
    if (normalizedVariant) {
      normalizedMatches.push({ product, variant: normalizedVariant });
    }
  }

  return {
    exactMatches,
    normalizedMatches,
  };
}

async function searchProductsByQuery(query, client) {
  const response = await client.listProducts({
    q: query,
    page: 1,
    perPage: 30,
  });

  assertSuccess(response, `GET /products?q=${query}`, [200]);
  return {
    status: response.status,
    products: Array.isArray(response.data) ? response.data : [],
  };
}

async function findProductBySkuViaSearch(sku, client) {
  const queries = Array.from(new Set([sku, normalizeSku(sku)].filter(Boolean)));
  const productsById = new Map();
  let status = null;

  for (const query of queries) {
    const result = await searchProductsByQuery(query, client);
    status = result.status;
    for (const product of result.products) {
      productsById.set(product.id, product);
    }
  }

  const products = Array.from(productsById.values());
  const { exactMatches, normalizedMatches } = collectVariantMatches(products, sku);

  if (exactMatches.length === 1) {
    return buildFoundProduct(
      exactMatches[0].product,
      exactMatches[0].variant,
      sku,
      status,
      "products-search-exact",
    );
  }

  if (exactMatches.length > 1) {
    return {
      exists: false,
      ambiguous: true,
      sourceSku: sku,
      normalizedSku: normalizeSku(sku),
      matches: exactMatches.map((match) => ({
        productId: match.product.id,
        variantId: match.variant.id,
        matchedSku: match.variant.sku,
      })),
      status,
    };
  }

  if (normalizedMatches.length === 1) {
    return buildFoundProduct(
      normalizedMatches[0].product,
      normalizedMatches[0].variant,
      sku,
      status,
      "products-search-normalized",
    );
  }

  if (normalizedMatches.length > 1) {
    return {
      exists: false,
      ambiguous: true,
      sourceSku: sku,
      normalizedSku: normalizeSku(sku),
      matches: normalizedMatches.map((match) => ({
        productId: match.product.id,
        variantId: match.variant.id,
        matchedSku: match.variant.sku,
      })),
      status,
    };
  }

  return {
    exists: false,
    ambiguous: false,
    sourceSku: sku,
    normalizedSku: normalizeSku(sku),
    productId: null,
    variantId: null,
    matchedSku: null,
    published: null,
    product: null,
    status,
  };
}

async function findSkuMatches(sku, client = createTiendanubeClient()) {
  const queries = Array.from(new Set([sku, normalizeSku(sku)].filter(Boolean)));
  const productsById = new Map();
  const normalized = normalizeSku(sku);

  for (const query of queries) {
    const result = await searchProductsByQuery(query, client);
    for (const product of result.products) {
      productsById.set(product.id, product);
    }
  }

  const matchesByVariantId = new Map();

  for (const product of productsById.values()) {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    for (const variant of variants) {
      if (normalizeSku(variant.sku) === normalized) {
        matchesByVariantId.set(variant.id, buildMatchRecord(product, variant));
      }
    }
  }

  return {
    sourceSku: sku,
    normalizedSku: normalized,
    matches: Array.from(matchesByVariantId.values()),
  };
}

async function getProductById(productId, client = createTiendanubeClient()) {
  const response = await client.getProduct(productId);
  if (response.status === 404) return null;
  assertSuccess(response, `GET /products/${productId}`, [200]);
  return response.data;
}

async function getLegacyGroupMatches(group, client = createTiendanubeClient()) {
  const matches = [];
  const missing = [];

  for (let i = 0; i < group.productIds.length; i++) {
    const productId = group.productIds[i];
    const variantId = group.variantIds[i];
    const product = await getProductById(productId, client);

    if (!product) {
      missing.push({
        productId,
        variantId,
        reason: "PRODUCT_NOT_FOUND",
      });
      continue;
    }

    const variants = Array.isArray(product.variants) ? product.variants : [];
    const variant = variants.find((item) => item.id === variantId);

    if (!variant) {
      missing.push({
        productId,
        variantId,
        reason: "VARIANT_NOT_FOUND",
      });
      continue;
    }

    if (normalizeSku(variant.sku) !== group.normalizedSku) {
      missing.push({
        productId,
        variantId,
        reason: "SKU_CHANGED",
        currentSku: variant.sku,
      });
      continue;
    }

    matches.push(buildMatchRecord(product, variant));
  }

  return {
    normalizedSku: group.normalizedSku,
    expectedMatches: group.expectedMatches,
    actualMatches: matches.length,
    matches,
    missing,
  };
}

async function findProductBySku(sku, client = createTiendanubeClient()) {
  const response = await client.getProductBySku(sku);

  if (response.status === 404) {
    const fallbackMatch = await findProductBySkuViaSearch(sku, client);
    if (fallbackMatch.exists || fallbackMatch.ambiguous) return fallbackMatch;

    return {
      exists: false,
      ambiguous: false,
      productId: null,
      variantId: null,
      sourceSku: sku,
      matchedSku: null,
      normalizedSku: normalizeSku(sku),
      published: null,
      sku,
      product: null,
      status: response.status,
    };
  }

  assertSuccess(response, `GET /products/sku/${sku}`, [200]);

  const product = response.data;
  const variant = findExactVariantBySku(product, sku);

  if (!variant) {
    const fallbackMatch = await findProductBySkuViaSearch(sku, client);
    if (fallbackMatch.exists || fallbackMatch.ambiguous) return fallbackMatch;

    return {
      exists: false,
      ambiguous: false,
      productId: null,
      variantId: null,
      sourceSku: sku,
      matchedSku: null,
      normalizedSku: normalizeSku(sku),
      published: null,
      sku,
      product,
      status: response.status,
      warning:
        "Tiendanube devolvio un producto, pero ninguna variante coincide exactamente con el SKU.",
    };
  }

  return buildFoundProduct(product, variant, sku, response.status, "products-sku");
}

async function createProduct(productPayload, client = createTiendanubeClient()) {
  const response = await client.createProduct(productPayload);
  assertSuccess(response, "POST /products", [200, 201]);
  return response.data;
}

async function uploadProductImage(productId, imageUrl, client = createTiendanubeClient()) {
  const response = await client.createProductImage(productId, {
    src: imageUrl,
    position: 1,
  });
  assertSuccess(response, `POST /products/${productId}/images`, [200, 201]);
  return response.data;
}

async function listProductImages(productId, client = createTiendanubeClient()) {
  const response = await client.listProductImages(productId);
  assertSuccess(response, `GET /products/${productId}/images`, [200]);
  return Array.isArray(response.data) ? response.data : [];
}

async function deleteProductImage(productId, imageId, client = createTiendanubeClient()) {
  const response = await client.deleteProductImage(productId, imageId);
  assertSuccess(response, `DELETE /products/${productId}/images/${imageId}`, [200]);
  return response.data;
}

async function updateProductPublishedStatus(
  productId,
  published,
  client = createTiendanubeClient(),
) {
  const response = await client.updateProduct(productId, { published });
  assertSuccess(response, `PUT /products/${productId}`, [200]);
  return response.data;
}

module.exports = {
  createProduct,
  deleteProductImage,
  findProductBySku,
  findSkuMatches,
  getLegacyGroupMatches,
  listProductImages,
  updateProductPublishedStatus,
  uploadProductImage,
};
