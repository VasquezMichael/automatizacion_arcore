const fs = require("fs");
const path = require("path");
const { normalizeSku } = require("../tiendanube/sku");

const CLIENT_SCOPE_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "config",
  "client-scope-skus.json",
);

class ClientScopeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ClientScopeError";
    this.code = code;
    if (details) this.details = details;
  }
}

function requirePositiveInteger(value, field, details = {}) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_INVALID_COUNT",
      `${field} debe ser un entero positivo.`,
      details,
    );
  }
}

function validateScopeItem(item, index, seen) {
  const sourceSku = typeof item?.sourceSku === "string" ? item.sourceSku : "";
  if (!sourceSku || sourceSku !== sourceSku.trim()) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_INVALID_SOURCE_SKU",
      `sourceSku invalido en la posicion ${index}.`,
      { index },
    );
  }

  const normalizedSku = normalizeSku(sourceSku);
  if (!normalizedSku || item.normalizedSku !== normalizedSku) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_NORMALIZATION_MISMATCH",
      `normalizedSku no coincide con normalizeSku() para ${sourceSku}.`,
      { index, sourceSku, expected: normalizedSku, actual: item.normalizedSku },
    );
  }
  if (seen.has(normalizedSku)) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_DUPLICATE_NORMALIZED_SKU",
      `El SKU normalizado ${normalizedSku} aparece mas de una vez.`,
      { index, normalizedSku },
    );
  }
  seen.add(normalizedSku);

  requirePositiveInteger(item.occurrenceCount, "occurrenceCount", { index, sourceSku });
  if (!Array.isArray(item.publicationIds) || item.publicationIds.length !== item.occurrenceCount) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_OCCURRENCE_MISMATCH",
      `occurrenceCount no coincide con publicationIds para ${sourceSku}.`,
      { index, sourceSku },
    );
  }
  if (!Array.isArray(item.productIds) || !Array.isArray(item.sourcePages)) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_REFERENCES_INVALID",
      `Las referencias de origen son invalidas para ${sourceSku}.`,
      { index, sourceSku },
    );
  }
}

function validateClientScope(scope) {
  if (!scope || scope.schemaVersion !== 1 || !Array.isArray(scope.items)) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_SCHEMA_INVALID",
      "El archivo de scope no cumple el schemaVersion 1.",
    );
  }
  if (scope.items.length !== 85) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_UNIQUE_COUNT_MISMATCH",
      `El scope debe contener exactamente 85 SKU unicos; contiene ${scope.items.length}.`,
    );
  }

  const seen = new Set();
  scope.items.forEach((item, index) => validateScopeItem(item, index, seen));
  const rowsWithSku = scope.items.reduce((total, item) => total + item.occurrenceCount, 0);
  const publicationReferenceCount = scope.items.reduce(
    (total, item) => total + item.publicationIds.length,
    0,
  );
  const missingSkuCount = scope.missingSkuRows?.count;
  requirePositiveInteger(missingSkuCount, "missingSkuRows.count");

  if (rowsWithSku !== 171 || publicationReferenceCount !== 171) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_ROW_COUNT_MISMATCH",
      "El scope debe representar exactamente 171 filas con SKU.",
      { rowsWithSku, publicationReferenceCount },
    );
  }
  if (missingSkuCount !== 5 || scope.source?.rowsWithoutSku !== 5) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_MISSING_SKU_COUNT_MISMATCH",
      "Las filas sin SKU deben permanecer separadas y sumar exactamente 5.",
    );
  }
  if (scope.source?.rowsWithSku !== rowsWithSku) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_SOURCE_SUMMARY_MISMATCH",
      "source.rowsWithSku no coincide con las apariciones del scope.",
    );
  }
  const totalPublicationRows = rowsWithSku + missingSkuCount;
  if (scope.source?.totalPublicationRows !== totalPublicationRows || totalPublicationRows !== 176) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_TOTAL_ROW_COUNT_MISMATCH",
      "El total reproducido debe ser 176 publicaciones.",
      { totalPublicationRows },
    );
  }

  return {
    totalPublicationRows,
    rowsWithSku,
    rowsWithoutSku: missingSkuCount,
    uniqueSkuCount: scope.items.length,
    duplicateAppearanceCount: rowsWithSku - scope.items.length,
    publicationReferenceCount,
    productReferenceCount: scope.items.reduce(
      (total, item) => total + item.productIds.length,
      0,
    ),
  };
}

function loadClientScope(filePath = CLIENT_SCOPE_FILE) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new ClientScopeError(
      "CLIENT_SCOPE_FILE_NOT_FOUND",
      `No existe el archivo de scope: ${resolvedPath}`,
    );
  }

  let scope;
  try {
    scope = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    throw new ClientScopeError("CLIENT_SCOPE_JSON_INVALID", "El scope JSON no es valido.", {
      cause: error.message,
    });
  }

  return {
    filePath: resolvedPath,
    scope,
    summary: validateClientScope(scope),
  };
}

module.exports = {
  CLIENT_SCOPE_FILE,
  ClientScopeError,
  loadClientScope,
  validateClientScope,
};
