const ARCORE_PUBLIC_IMAGE_BASE_URL =
  "https://www.arcore.com/catalogoWeb/imagenes/";
const ARCORE_PUBLIC_IMAGE_HOST = "www.arcore.com";
const ARCORE_PUBLIC_IMAGE_PATH = "/catalogoWeb/imagenes/";
const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i;

function buildArcorePublicImageUrl(imagePath) {
  const value = String(imagePath || "").trim();
  if (!value || value.includes("\0")) return null;

  try {
    const url = /^https?:\/\//i.test(value)
      ? new URL(value)
      : new URL(value.replace(/^\/+/, ""), ARCORE_PUBLIC_IMAGE_BASE_URL);

    if (
      url.protocol !== "https:" ||
      url.hostname !== ARCORE_PUBLIC_IMAGE_HOST ||
      url.port ||
      url.username ||
      url.password ||
      !url.pathname.startsWith(ARCORE_PUBLIC_IMAGE_PATH) ||
      !IMAGE_EXTENSION.test(url.pathname)
    ) {
      return null;
    }

    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function selectArcoreImageSource(articleDetail) {
  const cover = articleDetail?.cover;
  const fullImagePath =
    cover && typeof cover === "object" ? cover.foto : null;
  const thumbnailPath =
    cover && typeof cover === "object" ? cover.thumbnail : cover;
  const fullImageUrl = buildArcorePublicImageUrl(fullImagePath);

  if (fullImageUrl) {
    return {
      imageUrl: fullImageUrl,
      imageSource: "structured:cover.foto",
      imageSourceType: "COVER_FULL",
    };
  }

  const thumbnailUrl = buildArcorePublicImageUrl(thumbnailPath);
  if (thumbnailUrl) {
    return {
      imageUrl: thumbnailUrl,
      imageSource: "structured:cover.thumbnail",
      imageSourceType: "COVER_THUMBNAIL_FALLBACK",
    };
  }

  return null;
}

module.exports = {
  ARCORE_PUBLIC_IMAGE_BASE_URL,
  buildArcorePublicImageUrl,
  selectArcoreImageSource,
};
