const path = require("path");
const { CATALOG_MODE, runCatalog } = require("./catalogRunner");

function positiveInteger(value, name, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    const error = new Error(`${name} debe ser un entero ${allowZero ? "no negativo" : "positivo"}.`);
    error.code = "CATALOG_CLI_INVALID_OPTION";
    throw error;
  }
  return parsed;
}

function parseCatalogArgs(argv) {
  const options = {};
  let mode = CATALOG_MODE.SCAN_ONLY;
  let maxPagesSpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") {
      mode = argv[++index];
    } else if (argument === "--max-pages") {
      options.maxPages = positiveInteger(argv[++index], "--max-pages");
      maxPagesSpecified = true;
    } else if (argument === "--max-items") {
      options.maxItems = positiveInteger(argv[++index], "--max-items");
    } else if (argument === "--start-page") {
      options.startPage = positiveInteger(argv[++index], "--start-page", { allowZero: true });
    } else if (argument === "--resume") {
      const checkpoint = argv[++index];
      if (!checkpoint) throw Object.assign(new Error("Falta el valor de --resume."), { code: "CATALOG_CLI_INVALID_OPTION" });
      options.resume = path.resolve(checkpoint);
    } else if (argument === "--full") {
      options.full = true;
    } else {
      throw Object.assign(new Error(`Opcion desconocida: ${argument}`), {
        code: "CATALOG_CLI_UNKNOWN_OPTION",
      });
    }
  }

  if (options.full && maxPagesSpecified) {
    throw Object.assign(new Error("--full no puede combinarse con --max-pages."), {
      code: "CATALOG_CLI_CONFLICTING_LIMITS",
    });
  }
  if (options.full) options.maxPages = null;
  if (options.resume && options.startPage !== undefined) {
    throw Object.assign(new Error("--resume no puede combinarse con --start-page."), {
      code: "CATALOG_CLI_CONFLICTING_RESUME",
    });
  }
  return { mode, options };
}

function printCatalogResult(result) {
  console.log("\n=== CATALOGO READ-ONLY ===");
  console.log(`- runId: ${result.metadata.runId}`);
  console.log(`- modo: ${result.metadata.mode}`);
  console.log(`- estado: ${result.metadata.status}`);
  console.log(`- paginas completadas: ${result.pagination.pagesCompleted}`);
  console.log(`- paginas en esta ejecucion: ${result.pagination.pagesProcessedThisInvocation}`);
  console.log(`- articulos observados: ${result.summary.catalogItemCount}`);
  console.log(`- SKUs validos: ${result.summary.validSkuCount}`);
  console.log(`- SKUs unicos: ${result.summary.uniqueSkuCount}`);
  console.log(`- duplicados: ${result.summary.duplicateSkuCount}`);
  console.log(`- items invalidos: ${result.summary.invalidItemCount}`);
  console.log(`- warnings: ${result.summary.warningCount}`);
  console.log(`- errors: ${result.summary.errorCount}`);
  console.log(`- checkpoint: ${result.checkpoint.file}`);
  console.log(`- output: ${result.outputFile}`);
  if (result.batch) console.log(`- batch output: ${result.batch.outputFile}`);
  console.log("CERO ESCRITURAS EXTERNAS. Catalogo y batch operan en modo read-only.");
}

async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseCatalogArgs(argv);
    const result = await runCatalog(parsed);
    printCatalogResult(result);
    process.exitCode = result.metadata.status === "PAUSED" ? 1 : 0;
  } catch (error) {
    console.error(`Error catalogo [${error.code || "ERROR"}]: ${error.message}`);
    console.error("CERO ESCRITURAS EXTERNAS.");
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  main,
  parseCatalogArgs,
  printCatalogResult,
};
