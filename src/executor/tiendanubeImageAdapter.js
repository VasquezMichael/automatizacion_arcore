const { createTiendanubeClient } = require("../tiendanube/client");

function assertSuccess(response, operation, acceptedStatuses) {
  if (acceptedStatuses.includes(response?.status)) return response.data;

  const error = new Error(
    `${operation} fallo con status ${response?.status || "desconocido"}.`,
  );
  error.code = "TIENDANUBE_IMAGE_ADAPTER_ERROR";
  error.status = response?.status || null;
  throw error;
}

function validateUploadPayload(imagePayload) {
  const keys = Object.keys(imagePayload || {}).sort();
  if (
    keys.join(",") !== "position,src" ||
    typeof imagePayload.src !== "string" ||
    imagePayload.src.trim() === "" ||
    imagePayload.position !== 1
  ) {
    const error = new Error(
      "IMAGE upload permite exclusivamente { src, position: 1 }.",
    );
    error.code = "INVALID_IMAGE_UPLOAD_PAYLOAD";
    throw error;
  }
}

function createTiendanubeImageAdapter(client = createTiendanubeClient()) {
  return Object.freeze({
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
        const data = assertSuccess(
          await client.listProductImages(productId, { page, perPage }),
          `GET /products/${productId}/images?page=${page}`,
          [200],
        );
        const current = Array.isArray(data) ? data : [];
        images.push(...current);
        if (current.length < perPage) return images;
        page += 1;
      }
    },

    async uploadProductImage(productId, imagePayload) {
      validateUploadPayload(imagePayload);
      return assertSuccess(
        await client.createProductImage(productId, imagePayload),
        `POST /products/${productId}/images`,
        [200, 201],
      );
    },

    async deleteProductImage(productId, imageId) {
      return assertSuccess(
        await client.deleteProductImage(productId, imageId),
        `DELETE /products/${productId}/images/${imageId}`,
        [200, 204],
      );
    },
  });
}

module.exports = {
  createTiendanubeImageAdapter,
  validateUploadPayload,
};
