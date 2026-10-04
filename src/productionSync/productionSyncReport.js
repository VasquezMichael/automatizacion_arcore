const fs = require("fs");
const path = require("path");
const { sanitizeBatchOutput } = require("../batch/batchOutput");
const { persistJsonAtomic } = require("../mutableBatch/mutableBatchOutput");
const { dataPath } = require("../config/dataDirectory");

const PRODUCTION_SYNC_OUTPUT_DIR = dataPath("production-sync");

function safeTimestamp(value) {
  return value.replace(/[:.]/g, "-");
}

function createProductionSyncIdentity(now = new Date()) {
  const timestamp = now.toISOString();
  return {
    runId: `${safeTimestamp(timestamp)}_production_sync`,
    timestamp,
  };
}

function reportPath(runId, outputDir = PRODUCTION_SYNC_OUTPUT_DIR) {
  return path.resolve(outputDir, `${runId}.json`);
}

function checkpointPath(runId, outputDir = PRODUCTION_SYNC_OUTPUT_DIR) {
  return path.resolve(outputDir, `${runId}.checkpoint.json`);
}

function persistProductionSyncReport(report, outputDir) {
  const filePath = reportPath(report.runId, outputDir);
  persistJsonAtomic(filePath, sanitizeBatchOutput(report));
  return filePath;
}

function persistProductionSyncCheckpoint(report, outputDir) {
  const filePath = checkpointPath(report.runId, outputDir);
  persistJsonAtomic(filePath, sanitizeBatchOutput(report));
  return filePath;
}

function containsSensitiveKeys(value) {
  if (!value || typeof value !== "object") return false;
  const sensitive = /^(authorization|cookie|password|secret|token|accessToken|storageState)$/i;
  return Object.entries(value).some(([key, item]) =>
    sensitive.test(key) || containsSensitiveKeys(item),
  );
}

function removeCheckpoint(filePath) {
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = {
  PRODUCTION_SYNC_OUTPUT_DIR,
  checkpointPath,
  containsSensitiveKeys,
  createProductionSyncIdentity,
  persistProductionSyncCheckpoint,
  persistProductionSyncReport,
  removeCheckpoint,
  reportPath,
};
