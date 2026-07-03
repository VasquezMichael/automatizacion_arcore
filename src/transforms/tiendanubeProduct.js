function buildTiendanubeReadyProduct(product) {
  const missingFields = [];

  if (!product.precio) missingFields.push("price");
  if (!product.categoria) missingFields.push("category");
  if (!product.nombre) missingFields.push("name");

  return {
    sku: product.codigo,
    name: product.nombre,
    description:
      product.descripcionAlternativa ||
      product.descripcionStock ||
      product.nombre ||
      "",
    price: product.precio,
    images: product.imageUrl
      ? [
          {
            src: product.imageUrl,
            width: product.imageWidth,
            height: product.imageHeight,
            source: product.imageSource,
          },
        ]
      : [],
    availabilityStatus: product.estadoDisponibilidad,
    source: product.origen,
    sourceExternalId: product.externalId,
    brand: product.marca || product.marcaId || "",
    category: product.categoria || "",
    subcategory: product.subcategoria || "",
    pendingMapping: missingFields,
    rawNormalizedProduct: product,
  };
}

function buildTiendanubeReadyProducts(products) {
  return products.map(buildTiendanubeReadyProduct);
}

module.exports = {
  buildTiendanubeReadyProduct,
  buildTiendanubeReadyProducts,
};
