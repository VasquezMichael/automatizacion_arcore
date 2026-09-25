const fs = require("fs");
const path = require("path");
const { persistJsonAtomic } = require("./mutableBatchOutput");

const CHECKPOINT_VERSION = 1;
const MUTABLE_CHECKPOINT_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "output",
  "mutable-batch-checkpoints",
);

class MutableCheckpointError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "MutableCheckpointError";
    this.code = code;
    if (details) this.details = details;
  }
}

function checkpointPath(runId, outputDir = MUTABLE_CHECKPOINT_DIR) {
  return path.resolve(outputDir, `${runId}.checkpoint.json`);
}

function createCheckpoint(plan, filePath = checkpointPath(plan.metadata.runId)) {
  const items = [];
  for (const planItem of plan.items) {
    for (const domain of plan.metadata.domains) {
      const domainPlan = planItem.domains[domain];
      items.push({
        key: `${planItem.normalizedSku}:${domain}`,
        inputSku: planItem.inputSku,
        normalizedSku: planItem.normalizedSku,
        domain,
        state: "PLANNED",
        plannedAction: domainPlan.action,
        writesExpected: domainPlan.expectedWrites,
        writesConsumed: 0,
        prevalidation: null,
        writeResult: null,
        verification: null,
        returnedIds: {},
        substate: null,
        errors: [],
        warnings: [],
        approvedSnapshot: ["PRICE", "IMAGE"].includes(domain)
          ? JSON.parse(JSON.stringify(domainPlan.snapshot))
          : null,
      });
    }
  }
  const checkpoint = {
    version: CHECKPOINT_VERSION,
    runId: plan.metadata.runId,
    codeVersion: plan.metadata.codeVersion,
    allowlist: [...plan.metadata.allowlist],
    domains: [...plan.metadata.domains],
    maxWrites: plan.metadata.maxWrites,
    writesConsumed: 0,
    stopped: false,
    stopReason: null,
    items,
    auditLog: [],
    createdAt: plan.metadata.generatedAt,
    updatedAt: plan.metadata.generatedAt,
  };
  saveCheckpoint(checkpoint, filePath);
  return { checkpoint, checkpointFile: path.resolve(filePath) };
}

function saveCheckpoint(checkpoint, filePath) {
  checkpoint.updatedAt = new Date().toISOString();
  persistJsonAtomic(filePath, checkpoint);
  return filePath;
}

function loadCheckpoint(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new MutableCheckpointError(
      "MUTABLE_CHECKPOINT_NOT_FOUND",
      `No existe el checkpoint: ${resolved}`,
    );
  }
  let checkpoint;
  try {
    checkpoint = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new MutableCheckpointError(
      "MUTABLE_CHECKPOINT_INVALID_JSON",
      "El checkpoint no contiene JSON valido.",
      { cause: error.message },
    );
  }
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    throw new MutableCheckpointError(
      "MUTABLE_CHECKPOINT_VERSION_UNSUPPORTED",
      `Version no soportada: ${checkpoint.version}.`,
    );
  }
  return { checkpoint, checkpointFile: resolved };
}

function findCheckpointItem(checkpoint, normalizedSku, domain) {
  return checkpoint.items.find(
    (item) => item.normalizedSku === normalizedSku && item.domain === domain,
  );
}

function validateResume(checkpoint, expected) {
  if (JSON.stringify(checkpoint.domains) !== JSON.stringify(expected.domains)) {
    throw new MutableCheckpointError(
      "MUTABLE_DOMAIN_SET_MISMATCH",
      "Los dominios del resume deben coincidir exactamente con los dominios originales.",
      {
        actual: checkpoint.domains,
        expected: expected.domains,
      },
    );
  }

  const mismatches = [];
  const compare = (field, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      mismatches.push({ field, actual, expected: wanted });
    }
  };
  compare("codeVersion", checkpoint.codeVersion, expected.codeVersion);
  compare("allowlist", checkpoint.allowlist, expected.allowlist);
  compare("maxWrites", checkpoint.maxWrites, expected.maxWrites);
  if (mismatches.length > 0) {
    throw new MutableCheckpointError(
      "RESUME_INCONSISTENT",
      "El checkpoint no coincide con codigo, allowlist, dominios o budget actuales.",
      mismatches,
    );
  }

  const expectedKeys = expected.allowlist
    .flatMap((normalizedSku) =>
      expected.domains.map((domain) => `${normalizedSku}:${domain}`),
    )
    .sort();
  const actualKeys = (checkpoint.items || [])
    .map((item) => `${item.normalizedSku}:${item.domain}`)
    .sort();
  const consumedByItems = (checkpoint.items || []).reduce(
    (total, item) => total + Number(item.writesConsumed || 0),
    0,
  );
  const budgetIsConsistent =
    Number.isInteger(checkpoint.writesConsumed) &&
    checkpoint.writesConsumed >= 0 &&
    checkpoint.writesConsumed <= checkpoint.maxWrites &&
    consumedByItems === checkpoint.writesConsumed;

  if (
    JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
    new Set(actualKeys).size !== actualKeys.length ||
    !budgetIsConsistent
  ) {
    throw new MutableCheckpointError(
      "CHECKPOINT_INCONSISTENT",
      "El checkpoint no conserva items o presupuesto consistentes con el run autorizado.",
      {
        actualKeys,
        expectedKeys,
        writesConsumed: checkpoint.writesConsumed,
        consumedByItems,
        maxWrites: checkpoint.maxWrites,
      },
    );
  }
}

module.exports = {
  CHECKPOINT_VERSION,
  MUTABLE_CHECKPOINT_DIR,
  MutableCheckpointError,
  checkpointPath,
  createCheckpoint,
  findCheckpointItem,
  loadCheckpoint,
  saveCheckpoint,
  validateResume,
};
