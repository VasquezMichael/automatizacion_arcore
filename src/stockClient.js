const axios = require("axios");
const { baseUrl } = require("./config");
const { loadStorageState, storageStateExists } = require("./session");

function buildCookieHeader() {
  const storageState = loadStorageState();

  if (!storageState.cookies || !Array.isArray(storageState.cookies)) {
    throw new Error(
      "El archivo storageState.json no contiene cookies válidas.",
    );
  }

  const cookiePairs = storageState.cookies
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`);

  return cookiePairs.join("; ");
}

function buildSafeDiagnostics({ endpoint, params, response }) {
  return {
    url: axios.getUri({ url: endpoint, params }),
    codigo: params.codigo,
    marcaId: params.marcaId,
    supermedida: params.supermedida,
    httpStatus: response?.status || null,
    response: response?.data ?? null,
  };
}

function printDiagnostics(diagnostics) {
  if (String(process.env.ARCORE_STOCK_DIAGNOSTIC || "").toLowerCase() !== "true") {
    return;
  }

  console.log("[ARCORE_STOCK_DIAGNOSTIC]");
  console.log(JSON.stringify(diagnostics, null, 2));
}

async function queryStockDetailed({ codigo, marcaId, supermedida }) {
  if (!storageStateExists()) {
    throw new Error(
      "No existe sesión guardada. Ejecuta npm run login antes de correr la consulta de stock.",
    );
  }

  const cookieHeader = buildCookieHeader();
  const endpoint = `${baseUrl}/api/stocks`;
  const params = {
    codigo,
    marcaId,
    supermedida,
  };

  const response = await axios.get(endpoint, {
    params,
    headers: {
      Cookie: cookieHeader,
      Accept: "application/json",
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  const diagnostics = buildSafeDiagnostics({ endpoint, params, response });
  printDiagnostics(diagnostics);

  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`Consulta de stock fallo con status HTTP ${response.status}.`);
    error.code = "STOCK_REQUEST_FAILED";
    error.diagnostics = diagnostics;
    throw error;
  }

  return {
    data: response.data,
    diagnostics,
  };
}

async function queryStock(params) {
  const result = await queryStockDetailed(params);
  return result.data;
}

module.exports = {
  queryStock,
  queryStockDetailed,
};
