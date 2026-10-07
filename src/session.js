const fs = require("fs");
const { resolveArcoreStorageStateFile } = require("./config/arcoreRuntime");

function getStorageStateFile(options = {}) {
  return options.storageStateFile || resolveArcoreStorageStateFile(options.env);
}

function storageStateExists(options = {}) {
  return fs.existsSync(getStorageStateFile(options));
}

function loadStorageState(options = {}) {
  const storageStateFile = getStorageStateFile(options);
  if (!storageStateExists(options)) {
    throw new Error(
      "No existe storageState.json. Ejecuta npm run login primero.",
    );
  }

  const raw = fs.readFileSync(storageStateFile, "utf-8");
  return JSON.parse(raw);
}

module.exports = {
  getStorageStateFile,
  loadStorageState,
  storageStateExists,
};

Object.defineProperty(module.exports, "STORAGE_STATE_FILE", {
  enumerable: true,
  get: () => getStorageStateFile(),
});
