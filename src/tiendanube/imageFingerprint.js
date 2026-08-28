const crypto = require("crypto");
const axios = require("axios");
const { loadStorageState, storageStateExists } = require("../session");

function buildCookieHeader() {
  if (!storageStateExists()) return "";
  const storageState = loadStorageState();
  const cookies = Array.isArray(storageState.cookies) ? storageState.cookies : [];
  return cookies
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function downloadImageBuffer(imageUrl, { withArcoreAuth = false } = {}) {
  const headers = {};
  if (withArcoreAuth) {
    const cookieHeader = buildCookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;
  }

  const response = await axios.get(imageUrl, {
    headers,
    responseType: "arraybuffer",
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`No se pudo descargar imagen. Status HTTP ${response.status}`);
    error.status = response.status;
    error.url = imageUrl;
    throw error;
  }

  return Buffer.from(response.data);
}

async function calculateImageHash(imageUrl, options = {}) {
  const buffer = await downloadImageBuffer(imageUrl, options);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = {
  calculateImageHash,
  downloadImageBuffer,
};
