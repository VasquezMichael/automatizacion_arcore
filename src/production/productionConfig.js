const path = require("path");
const packageJson = require("../../package.json");
const { readExecutionGates } = require("../executor/executionGuards");
const {
  resolveDataDir,
  validateDataDirectory,
} = require("../config/dataDirectory");

const VALID_SYNC_MODES = new Set(["PLAN", "DRY_RUN", "EXECUTE"]);
const EXECUTION_DOMAINS = ["PRICE", "STATUS", "IMAGE", "CREATE"];

class ProductionConfigError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ProductionConfigError";
    this.code = code;
    if (details) this.details = details;
  }
}

function enabled(value) {
  return String(value || "false").trim().toLowerCase() === "true";
}

function positiveInteger(value, fallback, code, label, maximum = Number.MAX_SAFE_INTEGER) {
  const candidate = value === undefined || String(value).trim() === "" ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new ProductionConfigError(code, `${label} debe ser un entero entre 1 y ${maximum}.`);
  }
  return candidate;
}

function executionBlockReasons(env, mode, confirmed) {
  if (mode !== "EXECUTE") return [];
  const gates = readExecutionGates(env);
  const reasons = [];
  if (!confirmed) {
    reasons.push({
      code: "PRODUCTION_EXECUTION_NOT_CONFIRMED",
      message: "Falta PRODUCTION_SYNC_EXECUTION_CONFIRMED=true.",
    });
  }
  if (gates.dryRun) {
    reasons.push({ code: "DRY_RUN_ENABLED", message: "TIENDANUBE_DRY_RUN debe ser false." });
  }
  if (!gates.executionEnabled) {
    reasons.push({
      code: "GLOBAL_EXECUTION_DISABLED",
      message: "TIENDANUBE_EXECUTION_ENABLED debe ser true.",
    });
  }
  for (const domain of EXECUTION_DOMAINS) {
    if (!gates[`${domain.toLowerCase()}ExecutionEnabled`]) {
      reasons.push({
        code: `${domain}_EXECUTION_DISABLED`,
        message: `TIENDANUBE_${domain}_EXECUTION_ENABLED debe ser true.`,
      });
    }
  }
  return reasons;
}

function loadProductionConfig(options = {}) {
  const env = options.env || process.env;
  const dataDir = resolveDataDir(env, options.dataDir);
  const portValue = env.PORT ?? env.DASHBOARD_PORT;
  const port = positiveInteger(portValue, 3000, "PORT_INVALID", "PORT", 65535);
  const authEnabled = enabled(env.DASHBOARD_AUTH_ENABLED);
  const username = String(env.DASHBOARD_USERNAME || "");
  const password = String(env.DASHBOARD_PASSWORD || "");
  if (authEnabled && (!username || !password)) {
    throw new ProductionConfigError(
      "DASHBOARD_AUTH_INCOMPLETE",
      "DASHBOARD_USERNAME y DASHBOARD_PASSWORD son obligatorios cuando la autenticacion esta habilitada.",
    );
  }

  const scheduleEnabled = enabled(env.PRODUCTION_SYNC_SCHEDULE_ENABLED);
  const intervalMinutes = positiveInteger(
    env.PRODUCTION_SYNC_INTERVAL_MINUTES,
    60,
    "PRODUCTION_SYNC_INTERVAL_INVALID",
    "PRODUCTION_SYNC_INTERVAL_MINUTES",
  );
  const mode = String(env.PRODUCTION_SYNC_MODE || "PLAN").trim().toUpperCase();
  if (!VALID_SYNC_MODES.has(mode)) {
    throw new ProductionConfigError(
      "PRODUCTION_SYNC_MODE_INVALID",
      "PRODUCTION_SYNC_MODE debe ser PLAN, DRY_RUN o EXECUTE.",
    );
  }
  const executionConfirmed = enabled(env.PRODUCTION_SYNC_EXECUTION_CONFIRMED);
  const shutdownTimeoutMs = positiveInteger(
    env.PRODUCTION_SHUTDOWN_TIMEOUT_MS,
    30000,
    "PRODUCTION_SHUTDOWN_TIMEOUT_INVALID",
    "PRODUCTION_SHUTDOWN_TIMEOUT_MS",
  );

  const resolvedDataDir = options.validateStorage === false
    ? path.resolve(dataDir)
    : validateDataDirectory(dataDir, options.storageOptions);
  const blockedReasons = executionBlockReasons(env, mode, executionConfirmed);

  return {
    service: packageJson.name,
    version: packageJson.version,
    port,
    dataDir: resolvedDataDir,
    auth: { enabled: authEnabled, username, password },
    scheduler: {
      enabled: scheduleEnabled,
      intervalMinutes,
      mode,
      executionConfirmed,
      blocked: scheduleEnabled && blockedReasons.length > 0,
      blockedReasons,
    },
    shutdownTimeoutMs,
    env,
  };
}

module.exports = {
  EXECUTION_DOMAINS,
  ProductionConfigError,
  VALID_SYNC_MODES,
  enabled,
  executionBlockReasons,
  loadProductionConfig,
  positiveInteger,
};
