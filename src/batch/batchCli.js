const { parseBatchCliArgs } = require("./batchInput");
const { persistBatchResult } = require("./batchOutput");
const { runBatchSync } = require("./batchSync");

function printSummary(batch, outputFile) {
  const { summary } = batch;
  console.log("\n=== BATCH READ-ONLY ===");
  console.log(`- batchId: ${batch.metadata.batchId}`);
  console.log(`- input: ${summary.inputCount}`);
  console.log(`- SKUs unicos: ${summary.uniqueSkuCount}`);
  console.log(`- duplicados de entrada: ${summary.duplicateInputCount}`);
  console.log(`- procesados: ${summary.processedCount}`);
  console.log(`- exitosos: ${summary.succeededCount}`);
  console.log(`- bloqueados: ${summary.blockedCount}`);
  console.log(`- fallidos: ${summary.failedCount}`);
  console.log(`- revision manual: ${summary.manualReviewCount}`);
  console.log(`- clasificaciones: ${JSON.stringify(summary.classifications)}`);
  console.log(`- resoluciones: ${JSON.stringify(summary.supplierResolutions)}`);
  console.log(`- status: ${JSON.stringify(summary.statusActions)}`);
  console.log(`- price: ${JSON.stringify(summary.priceActions)}`);
  console.log(`- image: ${JSON.stringify(summary.imageActions)}`);
  console.log(`- create: ${JSON.stringify(summary.createActions)}`);
  console.log(`- output: ${outputFile}`);
  console.log("CERO ESCRITURAS EXTERNAS. El batch fuerza simulacion read-only.");
}

async function main(argv = process.argv.slice(2)) {
  try {
    const input = parseBatchCliArgs(argv);
    console.log(`Preparando batch read-only con concurrencia ${input.concurrency}.`);
    const batch = await runBatchSync({
      skus: input.skus,
      mode: "READ_ONLY",
      options: { concurrency: input.concurrency },
    });
    const outputFile = persistBatchResult(batch);
    printSummary(batch, outputFile);
    process.exitCode = batch.summary.failedCount > 0 ? 1 : 0;
  } catch (error) {
    console.error(`Error fatal batch [${error.code || "ERROR"}]: ${error.message}`);
    console.error("CERO ESCRITURAS EXTERNAS.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  printSummary,
};
