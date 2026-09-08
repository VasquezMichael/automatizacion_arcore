const { createTiendanubeClient } = require("./client");

function createTiendanubeReadOnlyClient() {
  const client = createTiendanubeClient();

  return Object.freeze({
    getProduct: client.getProduct,
    listProductImages: client.listProductImages,
    listProducts: client.listProducts,
  });
}

module.exports = {
  createTiendanubeReadOnlyClient,
};
