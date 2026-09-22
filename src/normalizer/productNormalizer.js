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
  const stockDiagnostics = rawProduct.stockDiagnostics || {};
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
  const estadoDisponibilidad = classifyAvailability({
    descripcion,
    descripcionAlternativa,
    color,
  });
  const availabilityErrorCode =
    rawProduct.stockErrorCode ||
    (rawProduct.stock && estadoDisponibilidad === "UNKNOWN"
      ? "STOCK_UNKNOWN_STATUS"
      : null);

  return {
    externalId: buildExternalId({ codigo: matchedCode || codigo, marcaId, marca }),
    articleId: cleanString(rawProduct.articleId) || null,
    codComercial: cleanString(rawProduct.codComercial || matchedCode) || null,
    searchedCode,
    matchedCode,
    matchType,
    supplierResolution: rawProduct.supplierResolution || null,
    extractionSource: cleanString(rawProduct.extractionSource) || null,
    domCardStatus: cleanString(rawProduct.domCardStatus) || null,
    warnings: Array.isArray(rawProduct.warnings) ? rawProduct.warnings : [],
    codigo,
    marcaId,
    marca,
    supermedida: cleanString(rawProduct.supermedida) || null,
    nombre,
    descripcion,
    descripcionStock: descripcion,
    descripcionAlternativa,
    color,
    estadoDisponibilidad,
    availabilitySource: {
      source: rawProduct.stock ? "ARCORE_STOCK_API" : "ARCORE_LISTING",
      url: stockDiagnostics.url || null,
      httpStatus: stockDiagnostics.httpStatus || null,
      codigo: stockDiagnostics.codigo || rawProduct.stockCodigo || null,
      marcaId: stockDiagnostics.marcaId || marcaId || null,
      supermedida: stockDiagnostics.supermedida || rawProduct.supermedida || null,
      descripcion: stock.descripcion || rawProduct.disponibilidadTexto || null,
      descripcionAlternativa: stock.descripcionAlternativa || null,
      color: stock.color || null,
      notificationVisible:
        typeof stock.notificationVisible === "boolean"
          ? stock.notificationVisible
          : null,
      response: stockDiagnostics.response || null,
      responseType: stockDiagnostics.responseType || null,
      error: rawProduct.stockError || null,
      errorCode: availabilityErrorCode,
    },
    imageUrl: rawProduct.imageUrl || null,
    imageSource: cleanString(rawProduct.imageFuente || rawProduct.imageSource),
    imageSourceType: cleanString(rawProduct.imageSourceType) || null,
    imageWidth: toNumberOrNull(rawProduct.imageWidth),
    imageHeight: toNumberOrNull(rawProduct.imageHeight),
    observacionesImagen: cleanString(rawProduct.observaciones),
    precio: toNumberOrNull(rawProduct.precio),
    priceSourceLabel: rawProduct.priceSourceLabel || null,
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
