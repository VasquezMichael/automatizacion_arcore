const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  LOCAL_STORAGE_STATE_FILE,
  resolveArcoreBrowserHeadless,
  resolveArcoreStorageStateFile,
} = require("../config/arcoreRuntime");
const { login } = require("../login");
const { getStorageStateFile, loadStorageState, storageStateExists } = require("../session");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "arcore-login-"));
}

function fakeBrowser(capture) {
  const page = {
    fill: async () => {},
    getByRole: () => ({ click: async () => {} }),
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForNavigation: async () => {},
    waitForSelector: async () => {},
  };
  const context = {
    newPage: async () => page,
    storageState: async ({ path: filePath }) => {
      capture.storageStateFile = filePath;
      fs.writeFileSync(filePath, JSON.stringify({ cookies: [{ name: "session" }] }));
    },
  };
  return {
    launch: async (options) => {
      capture.launchOptions = options;
      return {
        close: async () => { capture.closed = true; },
        newContext: async () => context,
      };
    },
  };
}

async function main() {
  assert.equal(resolveArcoreBrowserHeadless({ NODE_ENV: "production" }), true);
  console.log("OK 1. production default usa headless.");

  assert.equal(resolveArcoreBrowserHeadless({
    ARCORE_BROWSER_HEADLESS: "true",
    NODE_ENV: "production",
  }), true);
  console.log("OK 2. configuracion explicita true usa headless.");

  assert.equal(resolveArcoreBrowserHeadless({
    ARCORE_BROWSER_HEADLESS: "false",
    NODE_ENV: "production",
  }), false);
  console.log("OK 3. configuracion explicita false permite browser visible.");

  assert.equal(resolveArcoreBrowserHeadless({ NODE_ENV: "development" }), false);
  assert.equal(resolveArcoreBrowserHeadless({}), false);
  console.log("OK 4. entorno local usa browser visible por defecto.");

  const dataDir = tempDir();
  const productionEnv = { NODE_ENV: "production", DATA_DIR: dataDir };
  const expectedStateFile = path.join(dataDir, "arcore", "storageState.json");
  assert.equal(resolveArcoreStorageStateFile(productionEnv), expectedStateFile);
  assert.equal(resolveArcoreStorageStateFile({ NODE_ENV: "development" }), LOCAL_STORAGE_STATE_FILE);
  console.log("OK 5. storageState productivo vive dentro de DATA_DIR y local conserva compatibilidad.");

  const capture = {};
  const lines = [];
  const logger = {
    error: (...values) => lines.push(values.join(" ")),
    log: (...values) => lines.push(values.join(" ")),
  };
  const result = await login({
    baseUrl: "https://example.invalid",
    browserType: fakeBrowser(capture),
    env: productionEnv,
    logger,
    password: "credential-password-value",
    user: "credential-user-value",
  });

  assert.equal(capture.launchOptions.headless, true);
  assert.equal(result.headless, true);
  assert.equal(capture.closed, true);
  assert.equal(capture.storageStateFile, expectedStateFile);
  assert.equal(getStorageStateFile({ env: productionEnv }), expectedStateFile);
  assert.equal(storageStateExists({ env: productionEnv }), true);
  assert.deepEqual(loadStorageState({ env: productionEnv }).cookies, [{ name: "session" }]);
  console.log("OK 6. login recibe headless resuelto y storageState sigue siendo reutilizable.");

  const output = lines.join("\n");
  assert.doesNotMatch(output, /credential-password-value|credential-user-value/);
  console.log("OK 7. logs de login no exponen credenciales.");

  console.log("Resultado: OK. Login Arcore productivo validado sin browser real ni credenciales reales.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
