const fs = require("fs");
const path = require("path");

const STORAGE_STATE_FILE = path.resolve(__dirname, "..", "storageState.json");

function storageStateExists() {
  return fs.existsSync(STORAGE_STATE_FILE);
}

function loadStorageState() {
  if (!storageStateExists()) {
    throw new Error(
      "No existe storageState.json. Ejecuta npm run login primero.",
    );
  }

  const raw = fs.readFileSync(STORAGE_STATE_FILE, "utf-8");
  return JSON.parse(raw);
}

module.exports = {
  STORAGE_STATE_FILE,
  storageStateExists,
  loadStorageState,
};
