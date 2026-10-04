const fs = require("fs");
const path = require("path");

const DEFAULT_DATA_DIR = path.resolve(__dirname, "..", "..", "output");

class DataDirectoryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "DataDirectoryError";
    this.code = code;
    if (details) this.details = details;
  }
}

function resolveDataDir(env = process.env, explicitValue) {
  const configured = explicitValue ?? env.DATA_DIR;
  if (configured === undefined || String(configured).trim() === "") {
    return DEFAULT_DATA_DIR;
  }
  return path.resolve(String(configured).trim());
}

function dataPath(...segments) {
  return path.join(resolveDataDir(), ...segments);
}

function dataPathFrom(dataDir, ...segments) {
  return path.join(path.resolve(dataDir), ...segments);
}

function validateDataDirectory(directory, options = {}) {
  const resolved = path.resolve(directory);
  const fileSystem = options.fs || fs;
  const probe = path.join(resolved, `.write-test-${process.pid}-${Date.now()}`);
  try {
    fileSystem.mkdirSync(resolved, { recursive: true });
    const stats = fileSystem.statSync(resolved);
    if (!stats.isDirectory()) throw new Error("La ruta no es un directorio.");
    fileSystem.writeFileSync(probe, "ok", { encoding: "utf8", flag: "wx" });
    fileSystem.unlinkSync(probe);
  } catch (error) {
    try {
      if (fileSystem.existsSync(probe)) fileSystem.unlinkSync(probe);
    } catch (_cleanupError) {
      // El error original describe el problema operativo relevante.
    }
    throw new DataDirectoryError(
      "DATA_DIR_NOT_WRITABLE",
      `DATA_DIR no es accesible o escribible: ${resolved}`,
      { path: resolved, cause: error.code || error.message },
    );
  }
  return resolved;
}

module.exports = {
  DEFAULT_DATA_DIR,
  DataDirectoryError,
  dataPath,
  dataPathFrom,
  resolveDataDir,
  validateDataDirectory,
};
