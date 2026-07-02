const { queryStock } = require("./stockClient");
const { findProductImage } = require("./productImage");
const { testCodigo, testMarcaId, testSupermedida } = require("./config");

async function main() {
  try {
    if (!testCodigo || !testMarcaId) {
      console.error(
        "Faltan variables de prueba en .env: TEST_CODIGO y TEST_MARCA_ID son necesarias.",
      );
      process.exitCode = 1;
      return;
    }

    console.log("Consultando datos de stock...");
    console.log(`- codigo: ${testCodigo}`);
    console.log(`- marcaId: ${testMarcaId}`);
    console.log(`- supermedida: ${testSupermedida || ""}`);

    // Consultar stock
    const stockResult = await queryStock({
      codigo: testCodigo,
      marcaId: testMarcaId,
      supermedida: testSupermedida || "",
    });

    if (!stockResult || typeof stockResult !== "object") {
      console.warn("La respuesta del endpoint no es JSON válido.");
      console.log(stockResult);
      return;
    }

    const { descripcion, descripcionAlternativa, color } = stockResult;

    if (
      descripcion === undefined ||
      descripcionAlternativa === undefined ||
      color === undefined
    ) {
      console.warn(
        "La respuesta del endpoint no tiene el esquema esperado. Mostrando objeto completo:",
      );
      console.log(JSON.stringify(stockResult, null, 2));
      return;
    }

    // Buscar imagen del producto
    let imageData = {
      imageUrl: null,
      fuente: null,
      observaciones: "Imagen no extraída",
    };

    try {
      imageData = await findProductImage(testCodigo);
    } catch (imageError) {
      imageData = {
        imageUrl: null,
        fuente: null,
        observaciones: `Error al buscar imagen: ${imageError.message}`,
      };
    }

    // Mostrar resultados completos
    console.log("\n=== RESULTADO COMPLETO ===");
    console.log("\nDatos de Stock:");
    console.log(`- codigo: ${testCodigo}`);
    console.log(`- marcaId: ${testMarcaId}`);
    console.log(`- descripcion: ${descripcion}`);
    console.log(`- descripcionAlternativa: ${descripcionAlternativa}`);
    console.log(`- color: ${color}`);

    console.log("\nDatos de Imagen:");
    if (imageData.imageUrl) {
      console.log(`- imageUrl: ${imageData.imageUrl}`);
      console.log(`- fuente: ${imageData.fuente}`);
      console.log(`- width: ${imageData.imageWidth || "desconocido"}`);
      console.log(`- height: ${imageData.imageHeight || "desconocido"}`);
      console.log(`- observaciones: ${imageData.observaciones}`);
    } else {
      console.log(`- imageUrl: NO ENCONTRADA`);
      console.log(`- observaciones: ${imageData.observaciones}`);
    }

    process.exitCode = 0;
  } catch (error) {
    if (error.response) {
      console.error("Error HTTP en la consulta de stock:");
      console.error(`- status: ${error.response.status}`);
      console.error(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error("Error en la consulta de stock:", error.message);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
