const { testMarcaId, testSupermedida } = require("../config");
const { extractProductImages } = require("../imageProbe");
const { findProductImage } = require("../productImage");
const { queryStock } = require("../stockClient");

function productKey(product) {
  return [product.codigo || "", product.marcaId || product.marca || ""].join("|");
}

function dedupeProducts(products) {
  const byKey = new Map();

  for (const product of products) {
    const key = productKey(product);
    if (!product.codigo || byKey.has(key)) continue;
    byKey.set(key, product);
  }

  return Array.from(byKey.values());
}

async function enrichWithStock(product) {
  const marcaId = product.marcaId || product.marca || testMarcaId || "";

  if (!product.codigo || !marcaId) {
    return {
      ...product,
      stock: null,
      stockError: "No se pudo consultar stock: falta codigo o marcaId.",
    };
  }

  try {
    const stock = await queryStock({
      codigo: product.codigo,
      marcaId,
      supermedida: testSupermedida || "",
    });

    return {
      ...product,
      marcaId,
      stock,
    };
  } catch (error) {
    return {
      ...product,
      marcaId,
      stock: null,
      stockError: error.message,
    };
  }
}

async function enrichWithImage(product) {
  if (product.imageUrl || !product.codigo) return product;

  try {
    const imageData = await findProductImage(product.codigo);

    return {
      ...product,
      imageUrl: imageData.imageUrl,
      imageWidth: imageData.imageWidth,
      imageHeight: imageData.imageHeight,
      imageFuente: imageData.fuente,
      observaciones: imageData.observaciones,
    };
  } catch (error) {
    return {
      ...product,
      imageError: error.message,
    };
  }
}

async function extractProviderProducts() {
  const rawProducts = dedupeProducts(await extractProductImages());
  const enrichedProducts = [];

  for (let i = 0; i < rawProducts.length; i++) {
    const product = rawProducts[i];
    console.log(
      `[${i + 1}/${rawProducts.length}] Preparando producto ${product.codigo || "sin codigo"}`,
    );
    const withStock = await enrichWithStock(product);
    enrichedProducts.push(await enrichWithImage(withStock));
  }

  return enrichedProducts;
}

module.exports = {
  extractProviderProducts,
};
