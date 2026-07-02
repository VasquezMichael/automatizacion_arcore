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

async function queryStock({ codigo, marcaId, supermedida }) {
  if (!storageStateExists()) {
    throw new Error(
      "No existe sesión guardada. Ejecuta npm run login antes de correr la consulta de stock.",
    );
  }

  const cookieHeader = buildCookieHeader();
  const endpoint = `${baseUrl}/api/stocks`;

  const response = await axios.get(endpoint, {
    params: {
      codigo,
      marcaId,
      supermedida,
    },
    headers: {
      Cookie: cookieHeader,
      Accept: "application/json",
    },
    timeout: 15000,
  });

  return response.data;
}

module.exports = {
  queryStock,
};
