const { createTiendanubeClient } = require("../tiendanube/client");
const { findSkuMatches } = require("../tiendanube/products");
const { normalizeSku } = require("../tiendanube/sku");

function adapterError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function assertSuccess(response, operation, acceptedStatuses) {
  if (acceptedStatuses.includes(response?.status)) return response.data;
  throw adapterError(
    "CREATE_WRITE_FAILED",
    `${operation} fallo con status ${response?.status || "desconocido"}.`,
    { status: response?.status || null, ambiguous: false },
  );
}

function validateCreatePayload(payload) {
  const topLevelKeys = Object.keys(payload || {}).sort();
  const allowedTopLevel = payload?.images
    ? ["images", "name", "published", "variants"]
    : ["name", "published", "variants"];
  const variant = payload?.variants?.[0];
  const variantKeys = Object.keys(variant || {}).sort();
  const price = Number(variant?.price);

  if (
    topLevelKeys.join(",") !== allowedTopLevel.sort().join(",") ||
    typeof payload?.name !== "string" ||
    payload.name.trim() === "" ||
    typeof payload?.published !== "boolean" ||
    !Array.isArray(payload?.variants) ||
    payload.variants.length !== 1 ||
    variantKeys.join(",") !== "price,sku" ||
    normalizeSku(variant.sku) !== String(variant.sku) ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isInteger(price)
  ) {
    throw adapterError(
      "CREATE_PAYLOAD_INVALID",
      "CREATE permite solo name, published y una variante { sku, price } valida.",
    );
  }

  if (payload.images) {
    const image = payload.images[0];
    const imageKeys = Object.keys(image || {}).sort();
    let imageUrl;
    try {
      imageUrl = new URL(image?.src);
    } catch {
      imageUrl = null;
    }
    if (
      !Array.isArray(payload.images) ||
      payload.images.length !== 1 ||
      imageKeys.join(",") !== "position,src" ||
      image?.position !== 1 ||
      !imageUrl ||
      !["http:", "https:"].includes(imageUrl.protocol)
    ) {
      throw adapterError(
        "CREATE_PAYLOAD_INVALID",
        "La imagen inicial permite solo { src, position: 1 } con URL HTTP(S).",
      );
    }
  }

  return payload;
}

function createTiendanubeCreateAdapter(client = createTiendanubeClient()) {
  return Object.freeze({
    async findSkuMatches(normalizedSku) {
      return findSkuMatches(normalizedSku, client);
    },

    async createProduct(payload) {
      validateCreatePayload(payload);
      let response;
      try {
        response = await client.createProduct(payload);
      } catch (error) {
        throw adapterError(
          "CREATE_WRITE_AMBIGUOUS",
          "El POST de creacion no devolvio una respuesta concluyente.",
          {
            status: error.response?.status || error.status || null,
            ambiguous: true,
            causeCode: error.code || null,
          },
        );
      }
      return assertSuccess(response, "POST /products", [200, 201]);
    },

    async getProduct(productId) {
      return assertSuccess(
        await client.getProduct(productId),
        `GET /products/${productId}`,
        [200],
      );
    },

    async listProductImages(productId) {
      const images = [];
      const perPage = 50;
      let page = 1;
      while (true) {
        const current = assertSuccess(
          await client.listProductImages(productId, { page, perPage }),
          `GET /products/${productId}/images?page=${page}`,
          [200],
        );
        const pageImages = Array.isArray(current) ? current : [];
        images.push(...pageImages);
        if (pageImages.length < perPage) return images;
        page += 1;
      }
    },
  });
}

module.exports = {
  createTiendanubeCreateAdapter,
  validateCreatePayload,
};
