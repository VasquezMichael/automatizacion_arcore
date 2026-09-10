const { createTiendanubeClient } = require("../tiendanube/client");

function assertSuccess(response, operation) {
  if (response?.status >= 200 && response.status < 300) return;

  const error = new Error(`${operation} fallo con status ${response?.status || "desconocido"}.`);
  error.code = "TIENDANUBE_STATUS_ADAPTER_ERROR";
  error.status = response?.status || null;
  throw error;
}

function assertPublished(published) {
  if (typeof published === "boolean") return;

  const error = new Error("STATUS requiere un valor published booleano.");
  error.code = "INVALID_PUBLISHED_VALUE";
  throw error;
}

function createTiendanubeStatusAdapter(client = createTiendanubeClient()) {
  return Object.freeze({
    async getProduct(productId) {
      const response = await client.getProduct(productId);
      assertSuccess(response, `GET /products/${productId}`);
      return response.data;
    },

    async updateProductPublished(productId, published) {
      assertPublished(published);
      const response = await client.updateProduct(productId, { published });
      assertSuccess(response, `PUT /products/${productId}`);
      return response.data;
    },
  });
}

module.exports = {
  createTiendanubeStatusAdapter,
};
