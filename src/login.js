const path = require("path");
const { chromium } = require("playwright");
const { baseUrl, user, password } = require("./config");

const STORAGE_STATE_FILE = path.resolve(__dirname, "..", "storageState.json");

async function login() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`Abriendo navegador en: ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: "networkidle" });

    const emailSelector = 'input[name="email"]';
    const passwordSelector = 'input[name="password"]';
    const submitButton = page.getByRole("button", { name: /ingresar/i });
    const postLoginReadySelector = "body";

    console.log("Esperando el formulario de login...");
    await page.waitForSelector(emailSelector, { timeout: 15000 });
    await page.fill(emailSelector, user);
    await page.fill(passwordSelector, password);

    console.log("Enviando formulario de login...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      submitButton.click(),
    ]);

    console.log("Verificando que el post-login haya terminado...");
    await page.waitForLoadState("networkidle");
    await page.waitForSelector(postLoginReadySelector, { timeout: 20000 });

    await context.storageState({ path: STORAGE_STATE_FILE });
    console.log(`Sesión guardada correctamente en: ${STORAGE_STATE_FILE}`);
  } catch (error) {
    console.error("Error durante el login:", error.message);
    console.error(
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

module.exports = { login };
