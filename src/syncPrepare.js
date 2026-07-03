const { login } = require("./login");
const { chromium } = require("playwright");
const { baseUrl } = require("./config");
const { loadStorageState } = require("./session");
const { storageStateExists } = require("./session");
const { extractProviderProducts } = require("./extractor/providerProducts");
const { normalizeProducts } = require("./normalizer/productNormalizer");
const { buildTiendanubeReadyProducts } = require("./transforms/tiendanubeProduct");
const { compareProducts } = require("./sync/diffProducts");
const {
  readJsonIfExists,
  writeJson,
  resolveOutputPath,
} = require("./persistence/jsonStore");

const FILES = Object.freeze({
  previousProducts: "previous-products.json",
  currentProducts: "current-products.json",
  rawProducts: "products.raw.json",
  normalizedProducts: "products.normalized.json",
  tiendanubeReadyProducts: "products.tiendanube-ready.json",
  syncReport: "sync-report.json",
});

async function ensureAuthenticatedSession() {
  if (storageStateExists() && (await hasUsableSession())) {
    console.log("Sesion autenticada vigente. Reutilizando storageState.json.");
    return;
  }

  console.log("No existe sesion vigente. Ejecutando login automatico...");
  await login();

  if (!storageStateExists() || !(await hasUsableSession())) {
    throw new Error("No se pudo crear storageState.json despues del login.");
  }
}

async function hasUsableSession() {
  if (!storageStateExists()) return false;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: { cookies: loadStorageState().cookies },
  });
  const page = await context.newPage();

  try {
    await page.goto(`${baseUrl}/articulos`, { waitUntil: "networkidle" });
    const loginInputs = await page.locator('input[name="email"]').count();
    return loginInputs === 0;
  } catch {
    return false;
  } finally {
    await browser.close();
  }
}

function buildSummary({ rawProducts, normalizedProducts, diff }) {
  return {
    totalProductosProcesados: normalizedProducts.length,
    nuevosProductos: diff.newProducts.length,
    productosActualizados: diff.updatedProducts.length,
    productosSinCambios: diff.unchangedProducts.length,
    productosNoDisponibles: normalizedProducts.filter(
      (product) => product.estadoDisponibilidad === "UNAVAILABLE",
    ).length,
    productosConImagenValida: normalizedProducts.filter(
      (product) => Boolean(product.imageUrl),
    ).length,
    productosConErrores: rawProducts.filter((product) => product.stockError).length,
  };
}

async function main() {
  try {
    console.log("Iniciando preparacion de sincronizacion Arcore -> Tiendanube.\n");

    await ensureAuthenticatedSession();

    console.log("\nPaso 1: Extrayendo productos del proveedor...");
    const rawProducts = await extractProviderProducts();

    console.log("\nPaso 2: Normalizando productos...");
    const normalizedProducts = normalizeProducts(rawProducts);

    console.log("\nPaso 3: Generando payload intermedio para Tiendanube...");
    const tiendanubeReadyProducts = buildTiendanubeReadyProducts(normalizedProducts);

    console.log("\nPaso 4: Comparando contra snapshot anterior...");
    const previousProducts = readJsonIfExists(FILES.previousProducts, []);
    const diff = compareProducts(previousProducts, normalizedProducts);

    const summary = buildSummary({ rawProducts, normalizedProducts, diff });
    const report = {
      generatedAt: new Date().toISOString(),
      summary,
      diff,
      files: {
        rawProducts: resolveOutputPath(FILES.rawProducts),
        normalizedProducts: resolveOutputPath(FILES.normalizedProducts),
        tiendanubeReadyProducts: resolveOutputPath(FILES.tiendanubeReadyProducts),
        currentProducts: resolveOutputPath(FILES.currentProducts),
        previousProducts: resolveOutputPath(FILES.previousProducts),
      },
      notes: [
        "No se realizaron llamadas a Tiendanube.",
        "products.tiendanube-ready.json es un payload intermedio para mapear y publicar en una etapa futura.",
      ],
    };

    console.log("\nPaso 5: Guardando archivos locales...");
    writeJson(FILES.rawProducts, rawProducts);
    writeJson(FILES.normalizedProducts, normalizedProducts);
    writeJson(FILES.tiendanubeReadyProducts, tiendanubeReadyProducts);
    writeJson(FILES.currentProducts, normalizedProducts);
    writeJson(FILES.syncReport, report);
    writeJson(FILES.previousProducts, normalizedProducts);

    console.log("\n=== RESUMEN SYNC PREPARE ===");
    console.log(`- total productos procesados: ${summary.totalProductosProcesados}`);
    console.log(`- nuevos productos: ${summary.nuevosProductos}`);
    console.log(`- productos actualizados: ${summary.productosActualizados}`);
    console.log(`- productos sin cambios: ${summary.productosSinCambios}`);
    console.log(`- productos no disponibles: ${summary.productosNoDisponibles}`);
    console.log(`- productos con imagen valida: ${summary.productosConImagenValida}`);
    console.log(`- productos con errores: ${summary.productosConErrores}`);
    console.log("\nArchivos generados en results/:");
    console.log(`- ${FILES.rawProducts}`);
    console.log(`- ${FILES.normalizedProducts}`);
    console.log(`- ${FILES.tiendanubeReadyProducts}`);
    console.log(`- ${FILES.syncReport}`);

    process.exitCode = 0;
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
