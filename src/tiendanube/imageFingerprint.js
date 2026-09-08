const crypto = require("crypto");
const axios = require("axios");
const sharp = require("sharp");
const { baseUrl } = require("../config");
const { loadStorageState, storageStateExists } = require("../session");

const PERCEPTUAL_HASH_WIDTH = 17;
const PERCEPTUAL_HASH_HEIGHT = 16;
const PERCEPTUAL_HASH_BITS = (PERCEPTUAL_HASH_WIDTH - 1) * PERCEPTUAL_HASH_HEIGHT;
const DEFAULT_PERCEPTUAL_THRESHOLD = 20;

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

function assertImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const error = new Error("Buffer de imagen invalido o vacio.");
    error.code = "INVALID_IMAGE_DATA";
    throw error;
  }
}

function calculateExactImageHash(buffer) {
  assertImageBuffer(buffer);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function calculatePerceptualImageHash(buffer) {
  assertImageBuffer(buffer);

  try {
    const decoded = await sharp(buffer, { failOn: "error" })
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = await sharp(decoded.data, {
      raw: {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: decoded.info.channels,
      },
    })
      .resize(PERCEPTUAL_HASH_WIDTH, PERCEPTUAL_HASH_HEIGHT, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
      })
      .greyscale()
      .raw()
      .toBuffer();

    const bytes = [];
    let currentByte = 0;
    let bitCount = 0;

    for (let y = 0; y < PERCEPTUAL_HASH_HEIGHT; y++) {
      const rowStart = y * PERCEPTUAL_HASH_WIDTH;
      for (let x = 0; x < PERCEPTUAL_HASH_WIDTH - 1; x++) {
        const bit = pixels[rowStart + x] > pixels[rowStart + x + 1] ? 1 : 0;
        currentByte = (currentByte << 1) | bit;
        bitCount++;

        if (bitCount === 8) {
          bytes.push(currentByte);
          currentByte = 0;
          bitCount = 0;
        }
      }
    }

    return Buffer.from(bytes).toString("hex");
  } catch (error) {
    if (error.code === "INVALID_IMAGE_DATA") throw error;
    const safeError = new Error("No se pudo decodificar la imagen para compararla.");
    safeError.code = "INVALID_IMAGE_DATA";
    throw safeError;
  }
}

function hammingDistance(firstHash, secondHash) {
  if (
    typeof firstHash !== "string" ||
    typeof secondHash !== "string" ||
    firstHash.length === 0 ||
    firstHash.length !== secondHash.length ||
    !/^[0-9a-f]+$/i.test(firstHash) ||
    !/^[0-9a-f]+$/i.test(secondHash)
  ) {
    const error = new Error("Hashes perceptuales invalidos o incompatibles.");
    error.code = "INVALID_PERCEPTUAL_HASH";
    throw error;
  }

  let distance = 0;
  for (let index = 0; index < firstHash.length; index++) {
    let xor = Number.parseInt(firstHash[index], 16) ^ Number.parseInt(secondHash[index], 16);
    while (xor > 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

async function compareImageBuffers(
  sourceBuffer,
  targetBuffer,
  { threshold = DEFAULT_PERCEPTUAL_THRESHOLD } = {},
) {
  const sourceExactHash = calculateExactImageHash(sourceBuffer);
  const targetExactHash = calculateExactImageHash(targetBuffer);
  const exactMatch = sourceExactHash === targetExactHash;

  if (exactMatch) {
    return {
      exactMatch: true,
      perceptualMatch: true,
      method: "EXACT",
      sourceExactHash,
      targetExactHash,
      sourcePerceptualHash: null,
      targetPerceptualHash: null,
      distance: 0,
      threshold,
      hashBits: PERCEPTUAL_HASH_BITS,
    };
  }

  const [sourcePerceptualHash, targetPerceptualHash] = await Promise.all([
    calculatePerceptualImageHash(sourceBuffer),
    calculatePerceptualImageHash(targetBuffer),
  ]);
  const distance = hammingDistance(sourcePerceptualHash, targetPerceptualHash);

  return {
    exactMatch: false,
    perceptualMatch: distance <= threshold,
    method: "PERCEPTUAL",
    sourceExactHash,
    targetExactHash,
    sourcePerceptualHash,
    targetPerceptualHash,
    distance,
    threshold,
    hashBits: PERCEPTUAL_HASH_BITS,
  };
}

async function compareImages(
  sourceImageUrl,
  targetImageUrl,
  {
    sourceOptions = {},
    targetOptions = {},
    threshold = DEFAULT_PERCEPTUAL_THRESHOLD,
  } = {},
) {
  const [sourceBuffer, targetBuffer] = await Promise.all([
    downloadImageBuffer(sourceImageUrl, sourceOptions),
    downloadImageBuffer(targetImageUrl, targetOptions),
  ]);
  return compareImageBuffers(sourceBuffer, targetBuffer, { threshold });
}

async function calculateImageHash(imageUrl, options = {}) {
  const buffer = await downloadImageBuffer(imageUrl, options);
  return calculateExactImageHash(buffer);
}

module.exports = {
  ARCORE_COOKIE_ALLOWED_HOSTS,
  DEFAULT_PERCEPTUAL_THRESHOLD,
  PERCEPTUAL_HASH_BITS,
  calculateExactImageHash,
  calculateImageHash,
  calculatePerceptualImageHash,
  compareImageBuffers,
  compareImages,
  downloadImageBuffer,
  hammingDistance,
};
