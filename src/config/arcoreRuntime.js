const path = require("path");
const { dataPathFrom, resolveDataDir } = require("./dataDirectory");

const LOCAL_STORAGE_STATE_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "storageState.json",
);

function resolveArcoreBrowserHeadless(env = process.env) {
  const configured = env.ARCORE_BROWSER_HEADLESS;
  if (configured !== undefined && String(configured).trim() !== "") {
    const normalized = String(configured).trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;

    const error = new Error("ARCORE_BROWSER_HEADLESS debe ser true o false.");
    error.code = "ARCORE_BROWSER_HEADLESS_INVALID";
    throw error;
  }

  return String(env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function resolveArcoreStorageStateFile(env = process.env) {
  const isProduction =
    String(env.NODE_ENV || "").trim().toLowerCase() === "production";
  if (!isProduction) return LOCAL_STORAGE_STATE_FILE;

  return dataPathFrom(resolveDataDir(env), "arcore", "storageState.json");
}

module.exports = {
  LOCAL_STORAGE_STATE_FILE,
  resolveArcoreBrowserHeadless,
  resolveArcoreStorageStateFile,
};
