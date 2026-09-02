const crypto = require("crypto");
const axios = require("axios");
const { baseUrl } = require("../config");
const { loadStorageState, storageStateExists } = require("../session");

const ARCORE_COOKIE_ALLOWED_HOSTS = Array.from(
  new Set([new URL(baseUrl).hostname, "www.arcore.com"]),
);

function parseImageUrl(imageUrl) {
  try {
    return new URL(imageUrl);
  } catch (error) {
    const safeError = new Error("URL de imagen invalida.");
    safeError.code = "INVALID_IMAGE_URL";
    safeError.url = imageUrl;
    throw safeError;
  }
}

function assertArcoreCookieHostAllowed(imageUrl) {
  const parsedUrl = parseImageUrl(imageUrl);

  if (!ARCORE_COOKIE_ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
    const error = new Error(
      `Host de imagen Arcore no permitido para enviar cookies: ${parsedUrl.hostname}`,
    );
    error.code = "ARCORE_IMAGE_HOST_NOT_ALLOWED";
    error.url = imageUrl;
    error.hostname = parsedUrl.hostname;
    throw error;
  }
}

function assertImageContentType(response, imageUrl) {
  const contentType = String(response.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (!contentType.startsWith("image/")) {
    const error = new Error(
      `Content-Type invalido para imagen: ${contentType || "sin content-type"}`,
    );
    error.code = "INVALID_IMAGE_CONTENT_TYPE";
    error.status = response.status;
    error.contentType = contentType || null;
    error.url = imageUrl;
    throw error;
  }
}

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
    assertArcoreCookieHostAllowed(imageUrl);
    const cookieHeader = buildCookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;
  }

  const response = await axios.get(imageUrl, {
    headers,
    responseType: "arraybuffer",
    timeout: 30000,
    maxRedirects: withArcoreAuth ? 0 : 5,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`No se pudo descargar imagen. Status HTTP ${response.status}`);
    error.status = response.status;
    error.url = imageUrl;
    throw error;
  }

  assertImageContentType(response, imageUrl);

  return Buffer.from(response.data);
}

async function calculateImageHash(imageUrl, options = {}) {
  const buffer = await downloadImageBuffer(imageUrl, options);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = {
  ARCORE_COOKIE_ALLOWED_HOSTS,
  calculateImageHash,
  downloadImageBuffer,
};
