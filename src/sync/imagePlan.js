const { looksLikeRealImage } = require("../extractByCodesTest");
const {
  calculateExactImageHash,
  compareImageBuffers,
  downloadImageBuffer,
} = require("../tiendanube/imageFingerprint");

function pickName(value) {
  if (!value) return "sin nombre";
  if (typeof value === "string") return value;
  return value.es || value.pt || value.en || JSON.stringify(value);
}

function serializeImageError(error, code = error.code || "IMAGE_DOWNLOAD_FAILED") {
  return {
    code,
    message: error.message,
    status: error.response?.status || error.status || null,
    contentType: error.contentType || null,
    url: error.url || null,
    hostname: error.hostname || null,
  };
}

function getPrimaryImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  return [...images].sort((a, b) => {
    const positionA = Number(a.position) || Number.MAX_SAFE_INTEGER;
    const positionB = Number(b.position) || Number.MAX_SAFE_INTEGER;
    return positionA - positionB;
  })[0];
}

async function listProductImages(productId, client) {
  const response = await client.listProductImages(productId, { page: 1, perPage: 50 });
  if (response.status !== 200) {
    const error = new Error(
      `GET /products/${productId}/images fallo con status HTTP ${response.status}`,
    );
    error.response = response;
    throw error;
  }
  return Array.isArray(response.data) ? response.data : [];
}

async function planPublicationImage({ match, sourceBuffer, sourceHash, client }) {
  const publication = {
    productId: match.productId,
    variantId: match.variantId,
    name: pickName(match.name),
    published: match.published,
    tiendanubeImageCount: 0,
    imageId: null,
    tiendanubeImageUrl: null,
    sourceHash,
    tiendanubeHash: null,
    comparison: null,
    action: "",
    warnings: [],
    errors: [],
  };

  try {
    const images = await listProductImages(match.productId, client);
    publication.tiendanubeImageCount = images.length;
    if (images.length > 1) {
      publication.warnings.push({
        code: "MULTIPLE_TN_IMAGES",
        message: "El producto tiene multiples imagenes. Solo se compara la principal.",
      });
    }

    const primaryImage = getPrimaryImage(images);
    if (!primaryImage) {
      publication.action = "IMAGE_CREATE";
      return publication;
    }

    publication.imageId = primaryImage.id || null;
    publication.tiendanubeImageUrl = primaryImage.src || null;

    try {
      const targetBuffer = await downloadImageBuffer(primaryImage.src);
      publication.comparison = await compareImageBuffers(sourceBuffer, targetBuffer);
      publication.tiendanubeHash = publication.comparison.targetExactHash;
    } catch (error) {
      publication.action = "IMAGE_DOWNLOAD_FAILED";
      publication.errors.push(serializeImageError(error));
      return publication;
    }

    publication.action =
      publication.comparison.exactMatch || publication.comparison.perceptualMatch
        ? "IMAGE_NO_CHANGE"
        : "IMAGE_REPLACE";
    return publication;
  } catch (error) {
    publication.action = "ERROR";
    publication.errors.push(serializeImageError(error, "ERROR"));
    return publication;
  }
}

function aggregateImageAction(publications) {
  const actions = publications.map((publication) => publication.action);
  if (actions.includes("ERROR")) return "ERROR";
  if (actions.includes("IMAGE_DOWNLOAD_FAILED")) return "IMAGE_DOWNLOAD_FAILED";
  if (actions.includes("IMAGE_REPLACE")) return "IMAGE_REPLACE";
  if (actions.includes("IMAGE_CREATE")) return "IMAGE_CREATE";
  if (actions.length > 0 && actions.every((action) => action === "IMAGE_NO_CHANGE")) {
    return "IMAGE_NO_CHANGE";
  }
  return "ERROR";
}

async function buildImagePlan({ classification, matches, sourceImageUrl, client }) {
  if (!looksLikeRealImage(sourceImageUrl)) {
    return {
      action: "NO_SOURCE_IMAGE",
      sourceImageUrl: sourceImageUrl || null,
      sourceHash: null,
      publications: [],
      warnings: [
        {
          code: "NO_SOURCE_IMAGE",
          message: "Arcore no devolvio una imagen valida. No se planifica eliminacion.",
        },
      ],
      errors: [],
    };
  }

  if (classification === "MANUAL_REVIEW") {
    return {
      action: "MANUAL_REVIEW",
      sourceImageUrl,
      sourceHash: null,
      publications: [],
      warnings: [],
      errors: [],
    };
  }

  let sourceBuffer;
  let sourceHash;
  try {
    sourceBuffer = await downloadImageBuffer(sourceImageUrl, { withArcoreAuth: true });
    sourceHash = calculateExactImageHash(sourceBuffer);
  } catch (error) {
    return {
      action: "IMAGE_DOWNLOAD_FAILED",
      sourceImageUrl,
      sourceHash: null,
      publications: [],
      warnings: [],
      errors: [serializeImageError(error)],
    };
  }

  if (classification === "CREATE_SINGLE") {
    return {
      action: "IMAGE_FOR_CREATION",
      sourceImageUrl,
      sourceHash,
      publications: [],
      warnings: [],
      errors: [],
    };
  }

  const publications = [];
  for (const match of matches) {
    publications.push(
      await planPublicationImage({ match, sourceBuffer, sourceHash, client }),
    );
  }

  return {
    action: aggregateImageAction(publications),
    sourceImageUrl,
    sourceHash,
    publications,
    warnings: publications.flatMap((publication) => publication.warnings),
    errors: publications.flatMap((publication) => publication.errors),
  };
}

module.exports = {
  buildImagePlan,
  getPrimaryImage,
  planPublicationImage,
};
