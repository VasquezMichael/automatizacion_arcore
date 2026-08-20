function cleanString(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function toPositivePrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed.toFixed(2);
}

function getConfiguredTestPrice() {
  return toPositivePrice(process.env.TIENDANUBE_TEST_PRICE);
}

function resolvePrice(product) {
  return toPositivePrice(product.precio) || getConfiguredTestPrice();
}

function buildDescription(product) {
  const parts = [
    product.descripcion,
    product.descripcionAlternativa,
    product.estadoDisponibilidad
      ? `Disponibilidad proveedor: ${product.estadoDisponibilidad}`
      : "",
    product.observacionesImagen ? `Imagen: ${product.observacionesImagen}` : "",
  ].filter(Boolean);

  return parts.join("\n");
}

function mapArcoreProductToTiendanube(product) {
  const sku = cleanString(product.codigo || product.matchedCode);
  const name = cleanString(
    product.nombre || product.descripcion || product.descripcionAlternativa || sku,
  );
  const price = resolvePrice(product);

  if (!sku) {
    throw new Error("No se puede crear producto Tiendanube: falta SKU/codigo.");
  }

  if (!name) {
    throw new Error("No se puede crear producto Tiendanube: falta nombre.");
  }

  if (!price) {
    throw new Error(
      "No hay precio proveedor valido ni TIENDANUBE_TEST_PRICE configurado.",
    );
  }

  const payload = {
    name,
    description: buildDescription(product),
    brand: cleanString(product.marca || product.marcaId) || undefined,
    published: false,
    variants: [
      {
        sku,
        price,
        stock_management: false,
      },
    ],
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined || payload[key] === "") {
      delete payload[key];
    }
  });

  return {
    sku,
    imageUrl: product.imageUrl || null,
    payload,
  };
}

module.exports = {
  mapArcoreProductToTiendanube,
};
