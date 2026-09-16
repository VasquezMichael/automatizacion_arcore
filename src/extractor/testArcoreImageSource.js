const assert = require("assert");

const {
  buildArcorePublicImageUrl,
  selectArcoreImageSource,
} = require("./arcoreImageSource");

const FULL_PATH = "16/LK/LK415040910_20220527094108.png";
const THUMBNAIL_PATH =
  "thumbnails/16/LK/LK415040910_20220527094108_min.png";
const FULL_URL =
  "https://www.arcore.com/catalogoWeb/imagenes/16/LK/LK415040910_20220527094108.png";
const THUMBNAIL_URL =
  "https://www.arcore.com/catalogoWeb/imagenes/thumbnails/16/LK/LK415040910_20220527094108_min.png";

function run() {
  assert.deepStrictEqual(
    selectArcoreImageSource({ cover: { foto: FULL_PATH } }),
    {
      imageUrl: FULL_URL,
      imageSource: "structured:cover.foto",
      imageSourceType: "COVER_FULL",
    },
    "cover.foto debe seleccionar la imagen full-size",
  );

  assert.strictEqual(
    selectArcoreImageSource({
      cover: { foto: FULL_PATH, thumbnail: THUMBNAIL_PATH },
    }).imageUrl,
    FULL_URL,
    "cover.foto debe tener prioridad sobre cover.thumbnail",
  );

  assert.deepStrictEqual(
    selectArcoreImageSource({ cover: { thumbnail: THUMBNAIL_PATH } }),
    {
      imageUrl: THUMBNAIL_URL,
      imageSource: "structured:cover.thumbnail",
      imageSourceType: "COVER_THUMBNAIL_FALLBACK",
    },
    "cover.thumbnail debe usarse cuando falta cover.foto",
  );

  assert.strictEqual(
    selectArcoreImageSource({
      cover: { foto: "", thumbnail: THUMBNAIL_PATH },
    }).imageUrl,
    THUMBNAIL_URL,
    "cover.thumbnail debe usarse cuando cover.foto esta vacio",
  );

  assert.strictEqual(
    selectArcoreImageSource({ cover: {} }),
    null,
    "sin foto ni thumbnail no debe inventarse una imagen",
  );

  assert.strictEqual(
    buildArcorePublicImageUrl(FULL_PATH),
    FULL_URL,
    "la URL full-size debe construirse sobre el host publico de Arcore",
  );

  assert.strictEqual(
    selectArcoreImageSource({
      cover: { thumbnail: THUMBNAIL_PATH },
      photos: [{ foto: "16/LK/secondary.png" }],
    }).imageUrl,
    THUMBNAIL_URL,
    "una segunda foto no debe reemplazar automaticamente a la portada",
  );

  assert.strictEqual(
    selectArcoreImageSource({
      cover: {
        foto: "https://example.com/unsafe.png",
        thumbnail: THUMBNAIL_PATH,
      },
    }).imageUrl,
    THUMBNAIL_URL,
    "una foto insegura debe activar el fallback a thumbnail",
  );

  console.log("Resultado: OK. Seleccion de imagen Arcore verificada.");
}

if (require.main === module) run();

module.exports = { run };
