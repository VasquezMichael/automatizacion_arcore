const fs = require("fs");
const path = require("path");
const { runMutableBatch, SAFE_ENV } = require("./mutableBatchRunner");

function readSkuFile(filePath) {
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const values = Array.isArray(parsed) ? parsed : parsed.skus || parsed.allowlist;
  if (!Array.isArray(values)) {
    throw new Error("--sku-file debe contener un array o una propiedad skus/allowlist.");
  }
  return values.map((value) =>
    typeof value === "string" ? value : value.sourceSku || value.sku,
  );
}

function parseArgs(argv) {
  const options = {
    mode: "PLAN",
    skus: [],
    confirmRealWrites: false,
    enablePRICE: false,
    enableSTATUS: false,
    enableIMAGE: false,
    enableCREATE: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--all", "--full"].includes(arg)) {
      throw new Error(`${arg} no esta permitido para el runner mutable.`);
    }
    if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--sku") options.skus.push(argv[++index]);
    else if (arg === "--sku-file") options.skus.push(...readSkuFile(argv[++index]));
    else if (arg === "--max-writes") options.maxWrites = Number(argv[++index]);
    else if (arg === "--resume") options.resume = argv[++index];
    else if (arg === "--plan-file") options.planFile = argv[++index];
    else if (arg === "--confirm-real-writes") options.confirmRealWrites = true;
    else if (arg === "--enable-price") options.enablePRICE = true;
    else if (arg === "--enable-status") options.enableSTATUS = true;
    else if (arg === "--enable-image") options.enableIMAGE = true;
    else if (arg === "--enable-create") options.enableCREATE = true;
    else throw new Error(`Argumento no reconocido: ${arg}`);
  }
  return options;
}

function printSummary(report) {
  console.log("\n=== MUTABLE CLIENT SCOPE RUNNER ===");
  console.log(`- runId: ${report.metadata.runId}`);
  console.log(`- mode: ${report.metadata.mode}`);
  console.log(`- SKU allowlist: ${report.plan.metadata.allowlist.length}`);
  console.log(`- domains: ${report.plan.metadata.domains.join(", ")}`);
  console.log(`- expected writes: ${report.plan.expectedWrites}`);
  console.log(`- writes consumed: ${report.budget.writesConsumed}`);
  console.log(`- writes remaining: ${report.budget.writesRemaining}`);
  console.log(`- stopped: ${report.stopped}`);
  if (report.stopReason) {
    console.log(`- stop reason: ${report.stopReason.code} | ${report.stopReason.message}`);
  }
  console.log(`- plan: ${report.planFile}`);
  console.log(`- checkpoint: ${report.checkpointFile}`);
  console.log(`- output: ${report.outputFile}`);
  console.log(`- final gates: ${JSON.stringify(SAFE_ENV)}`);
  if (report.metadata.mode === "PLAN") {
    console.log("CERO ESCRITURAS: PLAN_ONLY.");
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await runMutableBatch(options);
    printSummary(report);
    process.exitCode = report.stopped ? 1 : 0;
  } catch (error) {
    console.error(`Mutable batch [${error.code || "ERROR"}]: ${error.message}`);
    console.error(`Gates finales seguros: ${JSON.stringify(SAFE_ENV)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, parseArgs, printSummary, readSkuFile };
