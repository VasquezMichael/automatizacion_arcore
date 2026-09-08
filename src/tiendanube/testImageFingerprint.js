const assert = require("assert/strict");
const sharp = require("sharp");
const {
  DEFAULT_PERCEPTUAL_THRESHOLD,
  calculatePerceptualImageHash,
  compareImageBuffers,
} = require("./imageFingerprint");

function createPattern(width, height, variant = "source") {
  const pixels = Buffer.alloc(width * height * 3, 255);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const inMainShape =
        variant === "source"
          ? x > width * 0.18 && x < width * 0.72 && y > height * 0.2 && y < height * 0.78
          : x > width * 0.4 && x < width * 0.88 && y > height * 0.08 && y < height * 0.55;
      const inAccent =
        variant === "source"
          ? x > width * 0.55 && y > height * 0.52
          : x < width * 0.32 && y > height * 0.62;

      if (inMainShape) {
        pixels[offset] = variant === "source" ? 35 : 210;
        pixels[offset + 1] = variant === "source" ? 95 : 45;
        pixels[offset + 2] = variant === "source" ? 180 : 55;
      } else if (inAccent) {
        pixels[offset] = variant === "source" ? 220 : 25;
        pixels[offset + 1] = variant === "source" ? 55 : 175;
        pixels[offset + 2] = variant === "source" ? 45 : 70;
      }
    }
  }

  return pixels;
}

async function encodePattern(variant = "source") {
  const width = 320;
  const height = 240;
  return sharp(createPattern(width, height, variant), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
}

async function assertRejectsWithCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, expectedCode);
    return true;
  });
}

async function main() {
  const source = await encodePattern("source");

  const exact = await compareImageBuffers(source, Buffer.from(source));
  assert.equal(exact.exactMatch, true);
  assert.equal(exact.perceptualMatch, true);
  assert.equal(exact.method, "EXACT");
  assert.equal(exact.sourcePerceptualHash, null);
  console.log("OK archivo identico: coincidencia exacta sin etapa perceptual.");

  const recompressed = await sharp(source)
    .resize(173, 131)
    .webp({ quality: 52 })
    .toBuffer();
  const transformed = await compareImageBuffers(source, recompressed);
  assert.equal(transformed.exactMatch, false);
  assert.equal(transformed.perceptualMatch, true);
  assert.ok(transformed.distance <= DEFAULT_PERCEPTUAL_THRESHOLD);
  console.log(
    `OK misma imagen recomprimida/resize: distancia ${transformed.distance}/${transformed.threshold}.`,
  );

  const different = await encodePattern("different");
  const distinct = await compareImageBuffers(source, different);
  assert.equal(distinct.exactMatch, false);
  assert.equal(distinct.perceptualMatch, false);
  assert.ok(distinct.distance > DEFAULT_PERCEPTUAL_THRESHOLD);
  console.log(
    `OK imagen diferente: distancia ${distinct.distance}/${distinct.threshold}.`,
  );

  await assertRejectsWithCode(
    calculatePerceptualImageHash(Buffer.from("contenido-no-imagen")),
    "INVALID_IMAGE_DATA",
  );
  console.log("OK imagen invalida: error controlado INVALID_IMAGE_DATA.");

  console.log("Resultado: OK. Comparacion exacta y perceptual verificada.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test de fingerprint: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
