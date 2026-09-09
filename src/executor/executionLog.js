const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { normalizeSku } = require("../tiendanube/sku");

const EXECUTIONS_DIR = path.resolve(__dirname, "..", "..", "output", "executions");
const SENSITIVE_KEY = /(authorization|cookie|password|secret|storageState|token)/i;

function safeTimestamp(timestamp) {
  return timestamp.replace(/[:.]/g, "-");
}

function safeSku(sourceSku) {
  return normalizeSku(sourceSku).replace(/[^a-z0-9_-]/gi, "") || "sin-sku";
}

function createExecutionIdentity(sourceSku, now = new Date()) {
  const timestamp = now.toISOString();
  const nonce = crypto.randomBytes(3).toString("hex");
  const executionId = `${safeTimestamp(timestamp)}_${safeSku(sourceSku)}_${nonce}`;
  return { executionId, timestamp };
}

function sanitizeForPersistence(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForPersistence(item, seen));
  }
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    sanitized[key] = sanitizeForPersistence(item, seen);
  }
  seen.delete(value);
  return sanitized;
}

function persistExecution(execution, outputDir = EXECUTIONS_DIR) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.resolve(outputDir, `${execution.executionId}.json`);
  const safeExecution = sanitizeForPersistence(execution);
  fs.writeFileSync(filePath, `${JSON.stringify(safeExecution, null, 2)}\n`, "utf-8");
  return filePath;
}

module.exports = {
  EXECUTIONS_DIR,
  createExecutionIdentity,
  persistExecution,
  sanitizeForPersistence,
};
