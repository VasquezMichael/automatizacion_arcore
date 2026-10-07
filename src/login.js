const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  resolveArcoreBrowserHeadless,
  resolveArcoreStorageStateFile,
} = require("./config/arcoreRuntime");

function loadLoginConfig(options) {
  if (options.baseUrl && options.user && options.password) return options;
  return { ...require("./config"), ...options };
}

async function login(options = {}) {
  const env = options.env || process.env;
  const config = loadLoginConfig(options);
  const logger = options.logger || console;
  const browserType = options.browserType || chromium;
  const headless = options.headless ?? resolveArcoreBrowserHeadless(env);
  const storageStateFile =
    options.storageStateFile || resolveArcoreStorageStateFile(env);
  const browser = await browserType.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    logger.log(`Abriendo navegador en: ${config.baseUrl}`);
    await page.goto(config.baseUrl, { waitUntil: "networkidle" });

    const emailSelector = 'input[name="email"]';
    const passwordSelector = 'input[name="password"]';
    const submitButton = page.getByRole("button", { name: /ingresar/i });
    const postLoginReadySelector = "body";

    logger.log("Esperando el formulario de login...");
    await page.waitForSelector(emailSelector, { timeout: 15000 });
    await page.fill(emailSelector, config.user);
    await page.fill(passwordSelector, config.password);

    logger.log("Enviando formulario de login...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      submitButton.click(),
    ]);

    logger.log("Verificando que el post-login haya terminado...");
    await page.waitForLoadState("networkidle");
    await page.waitForSelector(postLoginReadySelector, { timeout: 20000 });

    fs.mkdirSync(path.dirname(storageStateFile), { recursive: true });
    await context.storageState({ path: storageStateFile });
    logger.log(`Sesion guardada correctamente en: ${storageStateFile}`);
    return { headless, storageStateFile };
  } catch (error) {
    logger.error("Error durante el login:", error.message);
    logger.error(
      "Si los selectores del formulario no son correctos, actualiza src/login.js.",
    );
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  login();
}

module.exports = { loadLoginConfig, login };
