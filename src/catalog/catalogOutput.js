const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sanitizeBatchOutput } = require("../batch/batchOutput");
const { dataPath } = require("../config/dataDirectory");

const CATALOG_RUNS_DIR = dataPath("catalog-runs");

function createCatalogIdentity(now = new Date()) {
  const timestamp = now.toISOString();
  return {
    runId: `${timestamp.replace(/[:.]/g, "-")}_catalog_${crypto.randomBytes(3).toString("hex")}`,
    startedAt: timestamp,
  };
}

function persistCatalogRun(result, outputDir = CATALOG_RUNS_DIR) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const safeResult = sanitizeBatchOutput(result);
  const filePath = path.resolve(outputDir, `${safeResult.metadata.runId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(safeResult, null, 2)}\n`, "utf8");
  return filePath;
}

module.exports = {
  CATALOG_RUNS_DIR,
  createCatalogIdentity,
  persistCatalogRun,
};
