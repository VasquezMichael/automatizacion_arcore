const { runClientScope } = require("./clientScopeRunner");

function printSummary(report) {
  console.log("\n=== CLIENT SCOPE READ-ONLY ===");
  console.log(`- publicaciones totales: ${report.scopeSummary.totalPublicationRows}`);
  console.log(`- filas con SKU: ${report.scopeSummary.rowsWithSku}`);
  console.log(`- filas sin SKU: ${report.scopeSummary.rowsWithoutSku}`);
  console.log(`- SKU unicos: ${report.scopeSummary.uniqueSkuCount}`);
  console.log(`- procesados: ${report.batchSummary.processedCount}`);
  console.log(`- exitosos: ${report.batchSummary.succeededCount}`);
  console.log(`- bloqueados: ${report.batchSummary.blockedCount}`);
  console.log(`- fallidos: ${report.batchSummary.failedCount}`);
  console.log(`- revision manual: ${report.batchSummary.manualReviewCount}`);
  console.log(`- clasificaciones: ${JSON.stringify(report.batchSummary.classifications)}`);
  console.log(`- resoluciones: ${JSON.stringify(report.batchSummary.supplierResolutions)}`);
  console.log(`- output: ${report.outputFile}`);
  console.log("CERO ESCRITURAS EXTERNAS. El scope fuerza READ_ONLY con concurrencia 1.");
}

async function main() {
  try {
    const report = await runClientScope();
    printSummary(report);
    process.exitCode = report.batchSummary.failedCount > 0 ? 1 : 0;
  } catch (error) {
    console.error(`Error client scope [${error.code || "ERROR"}]: ${error.message}`);
    console.error("CERO ESCRITURAS EXTERNAS.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, printSummary };
