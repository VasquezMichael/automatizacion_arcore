const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sanitizeBatchOutput } = require("../batch/batchOutput");

const CLIENT_SCOPE_OUTPUT_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "output",
  "client-scope",
);

function safeTimestamp(timestamp) {
  return timestamp.replace(/[:.]/g, "-");
}

function createClientScopeIdentity(now = new Date()) {
  const timestamp = now.toISOString();
  return {
    runId: `${safeTimestamp(timestamp)}_client_scope_${crypto.randomBytes(3).toString("hex")}`,
    timestamp,
  };
}

function persistClientScopeReport(report, outputDir = CLIENT_SCOPE_OUTPUT_DIR) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const sanitized = sanitizeBatchOutput(report);
  const filePath = path.resolve(outputDir, `${sanitized.metadata.runId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  return filePath;
}

module.exports = {
  CLIENT_SCOPE_OUTPUT_DIR,
  createClientScopeIdentity,
  persistClientScopeReport,
};
