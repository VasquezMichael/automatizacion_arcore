const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sanitizeForPersistence } = require("../executor/executionLog");

const BATCH_OUTPUT_DIR = path.resolve(__dirname, "..", "..", "output", "batches");

function safeTimestamp(timestamp) {
  return timestamp.replace(/[:.]/g, "-");
}

function createBatchIdentity(now = new Date()) {
  const timestamp = now.toISOString();
  const nonce = crypto.randomBytes(3).toString("hex");
  return {
    batchId: `${safeTimestamp(timestamp)}_batch_${nonce}`,
    timestamp,
  };
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:authorization|cookie|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/([?&](?:access_token|token|key|secret)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function redactStrings(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item)]));
}

function sanitizeBatchOutput(batchResult) {
  return redactStrings(sanitizeForPersistence(batchResult));
}

function persistBatchResult(batchResult, outputDir = BATCH_OUTPUT_DIR) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const safeResult = sanitizeBatchOutput(batchResult);
  const filePath = path.resolve(outputDir, `${safeResult.metadata.batchId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(safeResult, null, 2)}\n`, "utf8");
  return filePath;
}

module.exports = {
  BATCH_OUTPUT_DIR,
  createBatchIdentity,
  persistBatchResult,
  redactSensitiveText,
  sanitizeBatchOutput,
};
