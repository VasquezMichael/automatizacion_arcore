const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { classifyAvailability } = require("../classifier/availability");
const { normalizeProduct } = require("../normalizer/productNormalizer");
const {
  ArcoreCatalogSource,
  createDefaultTransport,
} = require("./arcoreCatalogSource");

function catalogResponse(status = 200, overrides = {}) {
  return {
    status,
    url:
      status === 302
        ? "https://clientes.arcore.com/auth/login"
        : "https://clientes.arcore.com/api/articulos",
    location: "",
    contentType: status === 200 ? "application/json" : "text/plain",
    payload:
      status === 200
        ? { data: [], total: 0, pages: 1, pageSize: 12 }
        : null,
    ...overrides,
  };
}

function stockResponse(status = 200, payload = {}) {
  return {
    status,
    url: "https://clientes.arcore.com/api/stocks",
    location: "",
    contentType: status === 200 ? "application/json" : "text/plain",
    payload,
  };
}

function notFoundError() {
  return Object.assign(new Error("No encontrado."), {
    code: "ARCORE_PRODUCT_NOT_FOUND",
  });
}

async function testHealthyBatchAndLiveStock() {
  const source = new ArcoreCatalogSource({
    requestPage: async () => catalogResponse(),
    requestStock: async () =>
      stockResponse(200, { descripcion: "Disponible", color: "verde" }),
    extractProduct: async (sku, dependencies) => {
      const stock = await dependencies.queryStockDetailed({
        codigo: sku,
        marcaId: "1",
        supermedida: false,
      });
      return { sku, stock: stock.data };
    },
    productHealthInterval: 25,
  });
  await source.healthCheck();
  for (let index = 0; index < 51; index += 1) {
    const result = await source.extractProduct(`SKU-${index}`);
    assert.equal(result.stock.descripcion, "Disponible");
  }
  assert.equal(source.metrics.healthChecks, 3);
  assert.equal(source.metrics.stockRequestCount, 51);
  assert.equal(source.metrics.reauthCount, 0);
  assert.equal(source.metrics.sessionRetryCount, 0);
  console.log("OK 1-2: sesion estable, health periodico y stock usa la sesion viva.");
}

async function testLiveContextDominatesPersistedState() {
  let ensured = 0;
  let liveStockRequests = 0;
  const source = new ArcoreCatalogSource({
    ensureSession: async () => {
      ensured += 1;
    },
    transportFactory: async () => ({
      page: {},
      requestPage: async () => catalogResponse(),
      requestStock: async () => {
        liveStockRequests += 1;
        return stockResponse(200, { descripcion: "Disponible" });
      },
      close: async () => {},
    }),
  });
  const result = await source.queryStock({ codigo: "1", marcaId: "2", supermedida: false });
  assert.equal(result.data.descripcion, "Disponible");
  assert.equal(ensured, 1);
  assert.equal(liveStockRequests, 1);
  await source.close();
  console.log("OK 3: el stock del batch no vuelve a leer cookies persistidas stale.");
}

async function testStockSessionRecovery() {
  for (const initial of [
    stockResponse(401),
    stockResponse(302, null),
  ]) {
    const sequence = [initial, stockResponse(200, { descripcion: "Disponible" })];
    let reauthCalls = 0;
    const source = new ArcoreCatalogSource({
      requestPage: async () => catalogResponse(),
      requestStock: async () => sequence.shift(),
      extractProduct: async () => ({}),
      reauthenticate: async () => {
        reauthCalls += 1;
      },
    });
    const result = await source.queryStock({ codigo: "1", marcaId: "2", supermedida: false });
    assert.equal(result.data.descripcion, "Disponible");
    assert.equal(reauthCalls, 1);
    assert.equal(source.metrics.sessionRetryCount, 1);
    assert.equal(source.metrics.stockRequestCount, 2);
  }
  console.log("OK 4-5: 401 y redirect a login reautentican y reintentan una vez.");
}

async function testReauthFailureAndSingleRetry() {
  const failed = new ArcoreCatalogSource({
    requestPage: async () => catalogResponse(),
    requestStock: async () => stockResponse(401),
    extractProduct: async () => ({}),
    reauthenticate: async () => {
      throw new Error("login failed");
    },
  });
  await assert.rejects(
    () => failed.queryStock({ codigo: "1", marcaId: "2", supermedida: false }),
    (error) => error.code === "ARCORE_REAUTH_FAILED",
  );

  let calls = 0;
  let reauthCalls = 0;
  const exhausted = new ArcoreCatalogSource({
    requestPage: async () => catalogResponse(),
    requestStock: async () => {
      calls += 1;
      return stockResponse(401);
    },
    extractProduct: async () => ({}),
    reauthenticate: async () => {
      reauthCalls += 1;
    },
  });
  await assert.rejects(
    () => exhausted.queryStock({ codigo: "1", marcaId: "2", supermedida: false }),
    (error) => error.code === "STOCK_SESSION_EXPIRED" && error.sessionRetryExhausted,
  );
  assert.equal(calls, 2);
  assert.equal(reauthCalls, 1);
  console.log("OK 6-8: fallo de reauth, retry unico y segundo 401 explicito.");
}

async function testNotFoundProtection() {
  let validAttempts = 0;
  const valid = new ArcoreCatalogSource({
    requestPage: async () => catalogResponse(),
    extractProduct: async () => {
      validAttempts += 1;
      throw notFoundError();
    },
  });
  await assert.rejects(
    () => valid.extractProduct("MISSING"),
    (error) => error.code === "ARCORE_PRODUCT_NOT_FOUND",
  );
  assert.equal(validAttempts, 1);
  assert.equal(valid.metrics.healthChecks, 1);

  const healthSequence = [catalogResponse(401), catalogResponse(200)];
  let recoveredAttempts = 0;
  let reauthCalls = 0;
  const recovered = new ArcoreCatalogSource({
    requestPage: async () => healthSequence.shift(),
    extractProduct: async () => {
      recoveredAttempts += 1;
      if (recoveredAttempts === 1) throw notFoundError();
      return { codigo: "RECOVERED" };
    },
    reauthenticate: async () => {
      reauthCalls += 1;
    },
  });
  const result = await recovered.extractProduct("RECOVERED");
  assert.equal(result.codigo, "RECOVERED");
  assert.equal(recoveredAttempts, 2);
  assert.equal(reauthCalls, 1);
  console.log("OK 9-10: NOT_FOUND valido se conserva e invalido reautentica antes de consolidar.");
}

async function testStructuredRetry() {
  let attempts = 0;
  let reauthCalls = 0;
  const source = new ArcoreCatalogSource({
    requestPage: async () => catalogResponse(),
    extractProduct: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("expired"), { code: "ARCORE_SESSION_EXPIRED" });
      }
      return { codigo: "OK" };
    },
    reauthenticate: async () => {
      reauthCalls += 1;
    },
  });
  assert.equal((await source.extractProduct("OK")).codigo, "OK");
  assert.equal(attempts, 2);
  assert.equal(reauthCalls, 1);
  assert.equal(source.metrics.sessionRetryCount, 1);
  console.log("OK 11: la resolucion estructurada se repite tras reauth.");
}

function testAvailabilityOutcomes() {
  assert.equal(classifyAvailability({ descripcion: "Disponible" }), "AVAILABLE");
  assert.equal(classifyAvailability({ descripcion: "Disponible con espera" }), "PARTIAL");
  assert.equal(classifyAvailability({ descripcion: "Sin stock" }), "UNAVAILABLE");
  const unknown = normalizeProduct({
    codigo: "1",
    stock: { descripcion: "Estado nuevo sin semantica" },
    stockDiagnostics: { responseType: "JSON" },
  });
  assert.equal(unknown.estadoDisponibilidad, "UNKNOWN");
  assert.equal(unknown.availabilitySource.errorCode, "STOCK_UNKNOWN_STATUS");
  console.log("OK 12-15: AVAILABLE, PARTIAL, UNAVAILABLE y UNKNOWN real permanecen diferenciados.");
}

async function testExplicitStockFailures() {
  const scenarios = [
    {
      response: stockResponse(200, null),
      overrides: { contentType: "text/html", payload: null },
      code: "STOCK_INVALID_RESPONSE",
    },
    { response: stockResponse(500), overrides: {}, code: "STOCK_HTTP_ERROR" },
  ];
  for (const scenario of scenarios) {
    const source = new ArcoreCatalogSource({
      requestPage: async () => catalogResponse(),
      requestStock: async () => ({ ...scenario.response, ...scenario.overrides }),
      extractProduct: async () => ({}),
    });
    await assert.rejects(
      () => source.queryStock({ codigo: "1", marcaId: "2", supermedida: false }),
      (error) => error.code === scenario.code,
    );
  }

  const timeout = new ArcoreCatalogSource({
    requestPage: async () => catalogResponse(),
    requestStock: async () => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    },
    extractProduct: async () => ({}),
  });
  await assert.rejects(
    () => timeout.queryStock({ codigo: "1", marcaId: "2", supermedida: false }),
    (error) => error.code === "STOCK_NETWORK_ERROR",
  );
  console.log("OK 16-18: HTML, 5xx y timeout producen diagnosticos explicitos.");
}

async function testNoReauthLoopAndNoWrites() {
  let attempts = 0;
  let reauthCalls = 0;
  const source = new ArcoreCatalogSource({
    requestPage: async () => catalogResponse(),
    extractProduct: async () => {
      attempts += 1;
      throw Object.assign(new Error("expired"), { code: "ARCORE_SESSION_EXPIRED" });
    },
    reauthenticate: async () => {
      reauthCalls += 1;
    },
  });
  await assert.rejects(
    () => source.extractProduct("X"),
    (error) => error.code === "ARCORE_SESSION_EXPIRED",
  );
  assert.equal(attempts, 2);
  assert.equal(reauthCalls, 1);

  const sourceCode = fs.readFileSync(
    path.resolve(__dirname, "arcoreCatalogSource.js"),
    "utf8",
  );
  assert.equal(/\.post\s*\(|\.put\s*\(|\.patch\s*\(|\.delete\s*\(/i.test(sourceCode), false);
  assert.equal(typeof createDefaultTransport, "function");
  console.log("OK 19-20: no hay loops de reauth ni metodos mutables en la fuente batch.");
}

async function main() {
  await testHealthyBatchAndLiveStock();
  await testLiveContextDominatesPersistedState();
  await testStockSessionRecovery();
  await testReauthFailureAndSingleRetry();
  await testNotFoundProtection();
  await testStructuredRetry();
  testAvailabilityOutcomes();
  await testExplicitStockFailures();
  await testNoReauthLoopAndNoWrites();
  console.log("Resultado: OK. Coherencia de sesion batch cubre 20 escenarios controlados.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test sesion batch: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
