const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sanitizeBatchOutput } = require("../batch/batchOutput");

const ROOT_OUTPUT_DIR = path.resolve(__dirname, "..", "..", "output");
const MUTABLE_PLAN_DIR = path.join(ROOT_OUTPUT_DIR, "mutable-batch-plans");
const MUTABLE_RUN_DIR = path.join(ROOT_OUTPUT_DIR, "mutable-batch");

function safeTimestamp(timestamp) {
  return timestamp.replace(/[:.]/g, "-");
}

function createMutableRunIdentity(now = new Date()) {
  const timestamp = now.toISOString();
  const nonce = crypto.randomBytes(3).toString("hex");
  return {
    runId: `${safeTimestamp(timestamp)}_mutable_${nonce}`,
    timestamp,
  };
}

function ensureDirectory(directory) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}

function persistJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  ensureDirectory(path.dirname(resolved));
  const safeValue = sanitizeBatchOutput(value);
  const temporary = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(safeValue, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, resolved);
  return resolved;
}

function persistMutablePlan(plan, outputDir = MUTABLE_PLAN_DIR) {
  return persistJsonAtomic(path.join(outputDir, `${plan.metadata.runId}.json`), plan);
}

function persistMutableRun(report, outputDir = MUTABLE_RUN_DIR) {
  return persistJsonAtomic(path.join(outputDir, `${report.metadata.runId}.json`), report);
}

module.exports = {
  MUTABLE_PLAN_DIR,
  MUTABLE_RUN_DIR,
  createMutableRunIdentity,
  persistJsonAtomic,
  persistMutablePlan,
  persistMutableRun,
};
