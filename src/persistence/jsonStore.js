const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "results");

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function resolveOutputPath(filename) {
  return path.resolve(OUTPUT_DIR, filename);
}

function readJsonIfExists(filename, fallback = null) {
  const filePath = resolveOutputPath(filename);
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function writeJson(filename, data) {
  ensureOutputDir();
  const filePath = resolveOutputPath(filename);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return filePath;
}

module.exports = {
  OUTPUT_DIR,
  ensureOutputDir,
  readJsonIfExists,
  resolveOutputPath,
  writeJson,
};
