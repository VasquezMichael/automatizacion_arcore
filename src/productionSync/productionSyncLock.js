const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_LOCK_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "output",
  "production-sync",
  "production-sync.lock",
);
const DEFAULT_STALE_MINUTES = 120;

class ProductionSyncLockError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ProductionSyncLockError";
    this.code = code;
    if (details) this.details = details;
  }
}

function staleMinutes(value) {
  const parsed = Number(value ?? DEFAULT_STALE_MINUTES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ProductionSyncLockError(
      "PRODUCTION_SYNC_STALE_LOCK_INVALID",
      "PRODUCTION_SYNC_STALE_LOCK_MINUTES debe ser mayor que cero.",
    );
  }
  return parsed;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function lockIsStale(lock, now, minutes, hostname = os.hostname()) {
  const acquiredAt = Date.parse(lock?.acquiredAt || "");
  if (!Number.isFinite(acquiredAt)) return true;
  const oldEnough = now.getTime() - acquiredAt > minutes * 60 * 1000;
  if (!oldEnough) return false;
  if (lock.hostname === hostname) return !isProcessAlive(lock.pid);
  return true;
}

function invalidLockIsStale(filePath, now, minutes) {
  try {
    const stats = fs.statSync(filePath);
    return now.getTime() - stats.mtimeMs > minutes * 60 * 1000;
  } catch (_error) {
    return false;
  }
}

function writeExclusive(filePath, lock) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, "wx");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function acquireProductionSyncLock(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_LOCK_FILE);
  const now = options.now || new Date();
  const minutes = staleMinutes(
    options.staleMinutes ?? process.env.PRODUCTION_SYNC_STALE_LOCK_MINUTES,
  );
  const lock = {
    version: 1,
    runId: options.runId,
    token: options.token || `${process.pid}-${now.getTime()}-${Math.random()}`,
    pid: options.pid ?? process.pid,
    hostname: options.hostname || os.hostname(),
    acquiredAt: now.toISOString(),
  };

  try {
    writeExclusive(filePath, lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const current = readLock(filePath);
    const stale = current
      ? lockIsStale(current, now, minutes, lock.hostname)
      : invalidLockIsStale(filePath, now, minutes);
    if (!stale) {
      throw new ProductionSyncLockError(
        "SYNC_ALREADY_RUNNING",
        "Ya existe una sincronizacion productiva activa.",
        {
          runId: current?.runId || null,
          acquiredAt: current?.acquiredAt || null,
        },
      );
    }
    try {
      fs.unlinkSync(filePath);
      writeExclusive(filePath, lock);
    } catch (replaceError) {
      throw new ProductionSyncLockError(
        "SYNC_ALREADY_RUNNING",
        "El lock stale cambio mientras se intentaba recuperarlo.",
        { cause: replaceError.code || replaceError.message },
      );
    }
  }

  return {
    filePath,
    lock,
    release() {
      const current = readLock(filePath);
      if (!current || current.token !== lock.token) return false;
      fs.unlinkSync(filePath);
      return true;
    },
  };
}

module.exports = {
  DEFAULT_LOCK_FILE,
  DEFAULT_STALE_MINUTES,
  ProductionSyncLockError,
  acquireProductionSyncLock,
  invalidLockIsStale,
  isProcessAlive,
  lockIsStale,
  readLock,
};
