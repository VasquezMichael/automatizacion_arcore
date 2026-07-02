const {
  extractProductImages,
  probeAllImages,
  saveToJSON,
  saveToCSV,
  ensureResultsDir,
} = require("./imageProbe");

async function main() {
  try {
    console.log("Iniciando prueba técnica de imágenes de productos...\n");

    await ensureResultsDir();

    console.log("Paso 1: Extrayendo datos de productos y sus imágenes...");
    const products = await extractProductImages();

    if (products.length === 0) {
      console.warn("No se encontraron productos en el catálogo.");
      process.exitCode = 0;
      return;
    }

    console.log(`\nPaso 2: Probando accesibilidad de imágenes...`);
    const results = await probeAllImages(products);

    console.log("\nPaso 3: Guardando resultados...");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    saveToJSON(results, `image-probe-${timestamp}.json`);
    saveToCSV(results, `image-probe-${timestamp}.csv`);

    console.log("\n=== RESUMEN DE RESULTADOS ===");
    const productsWithImages = results.filter((r) => r.imageUrl).length;
    const productsWithoutImages = results.filter((r) => !r.imageUrl).length;
    const accessibleWithoutAuth = results.filter(
      (r) => r.probedWithoutAuth?.accessible,
    ).length;
    const accessibleWithAuth = results.filter(
      (r) => r.probedWithAuth?.accessible,
    ).length;
    const requiresAuth = results.filter((r) => r.requiresSessionAuth).length;

    console.log(`Total de productos: ${results.length}`);
    console.log(`- Con imagen detectada: ${productsWithImages}`);
    console.log(`- Sin imagen detectada: ${productsWithoutImages}`);
    console.log(`\nAccesibilidad de imágenes:`);
    console.log(
      `- Accesibles sin autenticación: ${accessibleWithoutAuth}/${productsWithImages}`,
    );
    console.log(
      `- Accesibles con sesión: ${accessibleWithAuth}/${productsWithImages}`,
    );
    console.log(
      `- Requieren autenticación: ${requiresAuth}/${productsWithImages}`,
    );

    console.log("\n✓ Pruebas completadas exitosamente");
    process.exitCode = 0;
  } catch (error) {
    console.error("Error durante la prueba de imágenes:", error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
