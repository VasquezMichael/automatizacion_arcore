const { classifyAvailability } = require("../classifier/availability");

function cleanString(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const normalized = value.replace(/\./g, "").replace(",", ".");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildExternalId({ codigo, marcaId, marca }) {
  const parts = ["arcore", marcaId || marca || "unknown-brand", codigo || "unknown-code"];
  return parts.map((part) => cleanString(part).toLowerCase()).join(":");
}

function normalizeProduct(rawProduct) {
  const stock = rawProduct.stock || {};
  const codigo = cleanString(rawProduct.codigo || stock.codigo);
  const searchedCode = cleanString(rawProduct.searchedCode || codigo);
  const matchedCode = cleanString(rawProduct.matchedCode || codigo);
  const matchType = cleanString(rawProduct.matchType || "exact");
  const marcaId = cleanString(rawProduct.marcaId || stock.marcaId);
  const marca = cleanString(rawProduct.marca || stock.marca);
  const descripcion = cleanString(
    stock.descripcion || rawProduct.descripcion || rawProduct.disponibilidadTexto,
  );
  const descripcionAlternativa = cleanString(
    stock.descripcionAlternativa || rawProduct.descripcionAlternativa,
  );
  const color = cleanString(stock.color || rawProduct.color);
  const nombre = cleanString(
    rawProduct.nombre || descripcion || descripcionAlternativa || codigo,
  );

  return {
    externalId: buildExternalId({ codigo: matchedCode || codigo, marcaId, marca }),
    searchedCode,
    matchedCode,
    matchType,
    codigo,
    marcaId,
    marca,
    nombre,
    descripcion,
    descripcionStock: descripcion,
    descripcionAlternativa,
    color,
    estadoDisponibilidad: classifyAvailability({
      descripcion,
      descripcionAlternativa,
      color,
    }),
    imageUrl: rawProduct.imageUrl || null,
    imageSource: cleanString(rawProduct.imageFuente || rawProduct.imageSource),
    imageWidth: toNumberOrNull(rawProduct.imageWidth),
    imageHeight: toNumberOrNull(rawProduct.imageHeight),
    observacionesImagen: cleanString(rawProduct.observaciones),
    precio: toNumberOrNull(rawProduct.precio),
    categoria: cleanString(rawProduct.categoria),
    subcategoria: cleanString(rawProduct.subcategoria),
    origen: "arcore",
    lastSyncAt: new Date().toISOString(),
    raw: rawProduct,
  };
}

function normalizeProducts(rawProducts) {
  return rawProducts.map(normalizeProduct);
}

module.exports = {
  normalizeProduct,
  normalizeProducts,
};
