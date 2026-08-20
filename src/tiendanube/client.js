const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

const API_VERSION = "2025-03";
const API_BASE_URL = `https://api.tiendanube.com/${API_VERSION}`;

function readEnv(name, required = true) {
  const value = process.env[name];
  if (required && (!value || value.trim() === "")) {
    throw new Error(`Variable de entorno requerida faltante: ${name}`);
  }
  return value ? value.trim() : "";
}

function getTiendanubeConfig() {
  return {
    accessToken: readEnv("TIENDANUBE_ACCESS_TOKEN"),
    storeId: readEnv("TIENDANUBE_STORE_ID", false),
    userAgent: readEnv("TIENDANUBE_USER_AGENT"),
    apiVersion: API_VERSION,
    apiBaseUrl: API_BASE_URL,
  };
}

function maskToken(token) {
  if (!token) return "";
  if (token.length <= 8) return "********";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function buildHeaders(config) {
  return {
    Authorization: `Bearer ${config.accessToken}`,
    "User-Agent": config.userAgent,
    Accept: "application/json",
  };
}

function buildStoreBaseUrl(config) {
  if (!config.storeId) {
    throw new Error(
      "TIENDANUBE_STORE_ID no esta configurado. La API requiere store_id en la URL.",
    );
  }
  return `${config.apiBaseUrl}/${config.storeId}`;
}

function createTiendanubeClient(config = getTiendanubeConfig()) {
  const http = axios.create({
    baseURL: buildStoreBaseUrl(config),
    headers: buildHeaders(config),
    timeout: 20000,
    validateStatus: () => true,
  });

  async function getStore() {
    const response = await http.get("/store");
    return response;
  }

  async function listProducts({ page = 1, perPage = 10 } = {}) {
    const response = await http.get("/products", {
      params: {
        page,
        per_page: perPage,
      },
    });
    return response;
  }

  return {
    config,
    getStore,
    listProducts,
  };
}

module.exports = {
  API_BASE_URL,
  API_VERSION,
  createTiendanubeClient,
  getTiendanubeConfig,
  maskToken,
};
