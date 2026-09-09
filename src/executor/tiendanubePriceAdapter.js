const { createTiendanubeClient } = require("../tiendanube/client");

function assertSuccess(response, operation) {
  if (response?.status >= 200 && response.status < 300) return response.data;

  const error = new Error(`${operation} fallo con status ${response?.status || "desconocido"}.`);
  error.code = "TIENDANUBE_PRICE_ADAPTER_ERROR";
  error.status = response?.status || null;
  throw error;
}

function createTiendanubePriceAdapter(client = createTiendanubeClient()) {
  return Object.freeze({
    async getProduct(productId) {
      return assertSuccess(
        await client.getProduct(productId),
        `GET /products/${productId}`,
      );
    },

    async getProductVariant(productId, variantId) {
      return assertSuccess(
        await client.getProductVariant(productId, variantId),
        `GET /products/${productId}/variants/${variantId}`,
      );
    },

    async updateVariantPrice(productId, variantId, price) {
      return assertSuccess(
        await client.updateProductVariant(productId, variantId, { price }),
        `PUT /products/${productId}/variants/${variantId}`,
      );
    },
  });
}

module.exports = {
  createTiendanubePriceAdapter,
};
