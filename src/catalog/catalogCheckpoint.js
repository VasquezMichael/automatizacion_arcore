const fs = require("fs");
const path = require("path");
const { sanitizeBatchOutput } = require("../batch/batchOutput");

const CHECKPOINT_VERSION = 1;
const CATALOG_CHECKPOINT_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "output",
  "catalog-checkpoints",
);

class CatalogCheckpointError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CatalogCheckpointError";
    this.code = code;
    if (details) this.details = details;
  }
}

function checkpointPaths(runId, outputDir = CATALOG_CHECKPOINT_DIR) {
  return {
    checkpointFile: path.resolve(outputDir, `${runId}.checkpoint.json`),
    stateFile: path.resolve(outputDir, `${runId}.pages.ndjson`),
  };
}

function initializeCheckpointState(runId, outputDir = CATALOG_CHECKPOINT_DIR) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const paths = checkpointPaths(runId, outputDir);
  if (!fs.existsSync(paths.stateFile)) fs.writeFileSync(paths.stateFile, "", "utf8");
  return paths;
}

function appendCompletedPage(stateFile, page, articles, metadata = {}) {
  const record = sanitizeBatchOutput({
    page,
    pageSize: metadata.pageSize ?? null,
    itemCount: articles.length,
    total: metadata.total ?? null,
    totalPages: metadata.totalPages ?? null,
    timestamp: metadata.timestamp || new Date().toISOString(),
    result: "COMPLETED",
    retries: metadata.retries || 0,
    articles: articles.map((article) => ({
      id: article.id || null,
      codComercial: article.codComercial || null,
    })),
  });
  fs.appendFileSync(stateFile, `${JSON.stringify(record)}\n`, "utf8");
}

function saveCheckpoint(checkpoint, checkpointFile) {
  const safeCheckpoint = sanitizeBatchOutput({
    ...checkpoint,
    version: CHECKPOINT_VERSION,
    updatedAt: new Date().toISOString(),
  });
  fs.writeFileSync(checkpointFile, `${JSON.stringify(safeCheckpoint, null, 2)}\n`, "utf8");
  return checkpointFile;
}

function loadCheckpoint(checkpointFile) {
  const resolved = path.resolve(checkpointFile);
  if (!fs.existsSync(resolved)) {
    throw new CatalogCheckpointError(
      "CATALOG_CHECKPOINT_NOT_FOUND",
      `No existe el checkpoint: ${resolved}`,
    );
  }
  let checkpoint;
  try {
    checkpoint = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new CatalogCheckpointError(
      "CATALOG_CHECKPOINT_INVALID_JSON",
      "El checkpoint no contiene JSON valido.",
      { cause: error.message },
    );
  }
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    throw new CatalogCheckpointError(
      "CATALOG_CHECKPOINT_VERSION_UNSUPPORTED",
      `Version de checkpoint no soportada: ${checkpoint.version}.`,
    );
  }
  return { checkpoint, checkpointFile: resolved };
}

function loadCompletedPages(stateFile, lastCompletedPage) {
  if (lastCompletedPage === null || lastCompletedPage === undefined) return [];
  if (!fs.existsSync(stateFile)) {
    throw new CatalogCheckpointError(
      "CATALOG_CHECKPOINT_STATE_NOT_FOUND",
      `No existe el estado incremental: ${stateFile}`,
    );
  }
  const lines = fs
    .readFileSync(stateFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const records = [];
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record.page <= lastCompletedPage) records.push(record);
  }
  return records;
}

function resolveCheckpointStateFile(checkpoint, checkpointFile) {
  const directory = path.dirname(checkpointFile);
  return path.resolve(directory, checkpoint.stateFile);
}

module.exports = {
  CATALOG_CHECKPOINT_DIR,
  CHECKPOINT_VERSION,
  CatalogCheckpointError,
  appendCompletedPage,
  checkpointPaths,
  initializeCheckpointState,
  loadCheckpoint,
  loadCompletedPages,
  resolveCheckpointStateFile,
  saveCheckpoint,
};
