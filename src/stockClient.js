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
  const contentType = response?.headers?.["content-type"] || "";
  return {
    url: axios.getUri({ url: endpoint, params }),
    codigo: params.codigo,
    marcaId: params.marcaId,
    supermedida: params.supermedida,
    httpStatus: response?.status || null,
    contentType,
    responseType: responseType(contentType),
    response: /application\/json/i.test(contentType) ? response?.data ?? null : null,
  };
}

function responseType(contentType) {
  if (/application\/json/i.test(contentType || "")) return "JSON";
  if (/text\/html/i.test(contentType || "")) return "HTML";
  return contentType ? "OTHER" : "UNKNOWN";
}

function stockError(code, message, diagnostics, cause) {
  const error = new Error(message);
  error.code = code;
  error.diagnostics = diagnostics;
  if (cause) error.cause = cause;
  return error;
}

function validateStockResponse(response, params) {
  const contentType = response.contentType || "";
  const diagnostics = {
    url: response.url || `${baseUrl}/api/stocks`,
    codigo: params.codigo,
    marcaId: params.marcaId,
    supermedida: params.supermedida,
    httpStatus: response.status ?? null,
    contentType,
    responseType: responseType(contentType),
    response: /application\/json/i.test(contentType) ? response.payload ?? null : null,
  };
  const loginRedirect =
    [301, 302, 303, 307, 308].includes(response.status) ||
    /\/auth\/login/i.test(response.url || "") ||
    /\/auth\/login/i.test(response.location || "");

  if (response.status === 401 || loginRedirect) {
    throw stockError(
      "STOCK_SESSION_EXPIRED",
      "La sesion Arcore no es valida para consultar stock.",
      diagnostics,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw stockError(
      "STOCK_HTTP_ERROR",
      `Consulta de stock fallo con status HTTP ${response.status}.`,
      diagnostics,
    );
  }
  if (!/application\/json/i.test(contentType)) {
    throw stockError(
      "STOCK_INVALID_RESPONSE",
      "Consulta de stock devolvio un contenido no JSON.",
      diagnostics,
    );
  }
  if (!response.payload || typeof response.payload !== "object" || Array.isArray(response.payload)) {
    throw stockError(
      "STOCK_INVALID_RESPONSE",
      "Consulta de stock devolvio un JSON con formato inesperado.",
      diagnostics,
    );
  }

  return { data: response.payload, diagnostics };
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

  let response;
  try {
    response = await axios.get(endpoint, {
      params,
      headers: {
        Cookie: cookieHeader,
        Accept: "application/json",
      },
      timeout: 15000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
  } catch (cause) {
    throw stockError(
      "STOCK_NETWORK_ERROR",
      "No se pudo completar la consulta de stock por un error de red.",
      {
        url: axios.getUri({ url: endpoint, params }),
        codigo,
        marcaId,
        supermedida,
        httpStatus: null,
        contentType: null,
        responseType: "UNKNOWN",
        response: null,
      },
      cause,
    );
  }

  const diagnostics = buildSafeDiagnostics({ endpoint, params, response });
  printDiagnostics(diagnostics);
  return validateStockResponse(
    {
      status: response.status,
      url: diagnostics.url,
      location: response.headers?.location || "",
      contentType: diagnostics.contentType,
      payload: response.data,
    },
    params,
  );
}

async function queryStock(params) {
  const result = await queryStockDetailed(params);
  return result.data;
}

module.exports = {
  buildSafeDiagnostics,
  queryStock,
  queryStockDetailed,
  responseType,
  validateStockResponse,
};
