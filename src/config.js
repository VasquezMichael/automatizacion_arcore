const path = require("path");
const dotenv = require("dotenv");

const envPath = path.resolve(__dirname, "..", ".env");
dotenv.config({ path: envPath });

function getEnv(name, required = true) {
  const value = process.env[name];
  if (required && (!value || value.trim() === "")) {
    throw new Error(`Variable de entorno requerida faltante: ${name}`);
  }
  return value ? value.trim() : undefined;
}

module.exports = {
  baseUrl: getEnv("ARCORE_BASE_URL"),
  user: getEnv("ARCORE_USER"),
  password: getEnv("ARCORE_PASSWORD"),
  testCodigo: getEnv("TEST_CODIGO", false),
  testMarcaId: getEnv("TEST_MARCA_ID", false),
  testSupermedida: getEnv("TEST_SUPERMEDIDA", false),
};
