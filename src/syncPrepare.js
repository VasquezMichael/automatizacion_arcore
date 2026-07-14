const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { loadStorageState } = require("./session");
const {
  ensureAuthenticatedSession,
  extractCode,
  looksLikeRealImage,
  readCodes,
} = require("./extractByCodesTest");
const { normalizeProducts } = require("./normalizer/productNormalizer");
const { buildTiendanubeReadyProducts } = require("./transforms/tiendanubeProduct");
const { compareProducts } = require("./sync/diffProducts");

const OUTPUT_DIR = path.resolve(__dirname, "..", "output");

const FILES = Object.freeze({
  rawProducts: path.resolve(OUTPUT_DIR, "products.raw.json"),
  normalizedProducts: path.resolve(OUTPUT_DIR, "products.normalized.json"),
  tiendanubeReadyProducts: path.resolve(OUTPUT_DIR, "products.tiendanube-ready.json"),
  syncReport: path.resolve(OUTPUT_DIR, "sync-report.json"),
  codesNotFound: path.resolve(OUTPUT_DIR, "codes-not-found.json"),
  previousProducts: path.resolve(OUTPUT_DIR, "products.previous.json"),
  currentProducts: path.resolve(OUTPUT_DIR, "products.current.json"),
});

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath, data) {
  ensureOutputDir();
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function rawProductFromExtractedProduct(product) {
  return {
    ...product.raw,
    searchedCode: product.searchedCode,
    matchedCode: product.matchedCode,
    matchType: product.matchType,
    matchObservation: product.observacion,
  };
}

function buildSummary({ codes, normalizedProducts, notFoundProducts, diff }) {
  return {
    totalCodigosProcesados: codes.length,
    exactMatches: normalizedProducts.filter((product) => product.matchType === "exact")
      .length,
    closestCandidateMatches: normalizedProducts.filter(
      (product) => product.matchType === "closestCandidate",
    ).length,
    codigosNoEncontrados: notFoundProducts.length,
    productosConImagenValida: normalizedProducts.filter((product) =>
      looksLikeRealImage(product.imageUrl),
    ).length,
    productosDisponibles: normalizedProducts.filter(
      (product) => product.estadoDisponibilidad === "AVAILABLE",
    ).length,
    productosParcialmenteDisponibles: normalizedProducts.filter(
      (product) => product.estadoDisponibilidad === "PARTIAL",
    ).length,
    productosNoDisponibles: normalizedProducts.filter(
      (product) => product.estadoDisponibilidad === "UNAVAILABLE",
    ).length,
    productosNuevos: diff.newProducts.length,
    productosActualizados: diff.updatedProducts.length,
    productosSinCambios: diff.unchangedProducts.length,
  };
}

async function extractProductsByCodes(codes) {
  const foundProducts = [];
  const notFoundProducts = [];
  const errors = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: { cookies: loadStorageState().cookies },
  });
  const page = await context.newPage();

  try {
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      console.log(`\n=== Codigo ${i + 1}/${codes.length}: ${code} ===`);

      try {
        const result = await extractCode(page, code);
        if (result.found) {
          foundProducts.push(result.product);
          continue;
        }

        notFoundProducts.push({
          codigo: code,
          observacion: result.observation,
          totalCandidates: result.totalCandidates || 0,
          closestCandidate: result.closestCandidate || null,
        });
      } catch (error) {
        console.error(`[${code}] Error: ${error.message}`);
        errors.push({
          codigo: code,
          error: error.message,
        });
      }
    }
  } finally {
    await browser.close();
  }

  return {
    foundProducts,
    notFoundProducts,
    errors,
  };
}

async function main() {
  try {
    ensureOutputDir();

    const codes = readCodes();
    console.log("Iniciando preparacion local Arcore -> Tiendanube.\n");
    console.log(`Codigos a procesar: ${codes.length}`);

    await ensureAuthenticatedSession();

    console.log("\nPaso 1: Buscando productos por codigo...");
    const { foundProducts, notFoundProducts, errors } = await extractProductsByCodes(codes);

    console.log("\nPaso 2: Normalizando productos...");
    const rawProducts = foundProducts.map(rawProductFromExtractedProduct);
    const normalizedProducts = normalizeProducts(rawProducts);

    console.log("\nPaso 3: Generando payload intermedio para Tiendanube...");
    const tiendanubeReadyProducts = buildTiendanubeReadyProducts(normalizedProducts);

    console.log("\nPaso 4: Comparando contra version anterior local...");
    const previousProducts = readJsonIfExists(FILES.previousProducts, []);
    const diff = compareProducts(previousProducts, normalizedProducts, [...notFoundProducts]);

    const summary = buildSummary({
      codes,
      normalizedProducts,
      notFoundProducts,
      diff,
    });

    const report = {
      generatedAt: new Date().toISOString(),
      summary,
      diff,
      errors,
      files: FILES,
      notes: [
        "No se realizaron llamadas reales a Tiendanube.",
        "products.tiendanube-ready.json es un payload intermedio para publicar o actualizar en una etapa futura.",
      ],
    };

    console.log("\nPaso 5: Guardando archivos locales...");
    writeJson(FILES.rawProducts, rawProducts);
    writeJson(FILES.normalizedProducts, normalizedProducts);
    writeJson(FILES.tiendanubeReadyProducts, tiendanubeReadyProducts);
    writeJson(FILES.codesNotFound, notFoundProducts);
    writeJson(FILES.currentProducts, normalizedProducts);
    writeJson(FILES.syncReport, report);
    writeJson(FILES.previousProducts, normalizedProducts);

    console.log("\n=== RESUMEN SYNC PREPARE ===");
    console.log(`- total codigos procesados: ${summary.totalCodigosProcesados}`);
    console.log(`- exact matches: ${summary.exactMatches}`);
    console.log(`- closestCandidate matches: ${summary.closestCandidateMatches}`);
    console.log(`- codigos no encontrados: ${summary.codigosNoEncontrados}`);
    console.log(`- productos con imagen valida: ${summary.productosConImagenValida}`);
    console.log(`- productos disponibles: ${summary.productosDisponibles}`);
    console.log(
      `- productos parcialmente disponibles: ${summary.productosParcialmenteDisponibles}`,
    );
    console.log(`- productos no disponibles: ${summary.productosNoDisponibles}`);
    console.log(`- nuevos productos: ${summary.productosNuevos}`);
    console.log(`- productos actualizados: ${summary.productosActualizados}`);
    console.log(`- productos sin cambios: ${summary.productosSinCambios}`);

    if (errors.length > 0) {
      console.log(`- errores de extraccion: ${errors.length}`);
    }

    console.log("\nArchivos generados en output/:");
    console.log("- products.raw.json");
    console.log("- products.normalized.json");
    console.log("- products.tiendanube-ready.json");
    console.log("- sync-report.json");
    console.log("- codes-not-found.json");

    process.exitCode = errors.length > 0 ? 1 : 0;
  } catch (error) {
    console.error("Error preparando sincronizacion:", error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
