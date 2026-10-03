require("dotenv").config();

const { runProductionSync } = require("./productionSyncRunner");

function parseArgs(argv) {
  const options = {
    mode: "PLAN",
    confirmRealWrites: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") options.mode = argv[++index];
    else if (argument === "--scope-file") options.scopeFile = argv[++index];
    else if (argument === "--confirm-real-writes") options.confirmRealWrites = true;
    else throw new Error(`Argumento no reconocido: ${argument}`);
  }
  return options;
}

function printSummary(report) {
  console.log("\n=== PRODUCTION SYNC ===");
  console.log(`- runId: ${report.runId}`);
  console.log(`- mode: ${report.mode}`);
  console.log(`- scope: ${report.scopeCount}`);
  console.log(`- resolved: ${report.resolved}`);
  console.log(`- already synced: ${report.alreadySynced}`);
  console.log(`- auto executable: ${report.autoExecutable}`);
  console.log(`- manual review: ${report.manualReview}`);
  console.log(`- not found: ${report.notFound}`);
  console.log(`- unknown: ${report.unknown}`);
  console.log(`- technical blocked: ${report.technicalBlocked}`);
  console.log(`- sub-batches: ${report.subBatches.length}`);
  console.log(`- planned writes: ${report.plannedWrites}`);
  console.log(`- executed writes: ${report.executedWrites}`);
  console.log(`- write attempted: ${report.writeAttempted}`);
  console.log(`- stopped: ${report.stopped}`);
  if (report.stopReason) {
    console.log(`- stop: ${report.stopReason.code} | ${report.stopReason.message}`);
  }
  console.log(`- report: ${report.outputFile}`);
  console.log(`- checkpoint: ${report.checkpointFile}`);
  if (report.mode !== "EXECUTE") console.log("CERO ESCRITURAS REALES.");
}

async function main() {
  try {
    const report = await runProductionSync(parseArgs(process.argv.slice(2)));
    printSummary(report);
    process.exitCode = report.stopped ? 1 : 0;
  } catch (error) {
    console.error(`Production sync [${error.code || "ERROR"}]: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { main, parseArgs, printSummary };
