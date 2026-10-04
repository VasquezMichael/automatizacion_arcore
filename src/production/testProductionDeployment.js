const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DEFAULT_DATA_DIR,
  resolveDataDir,
  validateDataDirectory,
} = require("../config/dataDirectory");
const { createDashboardApp } = require("../dashboard/server");
const { activityFromProductionSync, loadActivity } = require("../dashboard/reportService");
const { persistProductionSyncReport } = require("../productionSync/productionSyncReport");
const { readExecutionGates } = require("../executor/executionGuards");
const { loadProductionConfig } = require("./productionConfig");
const { createProductionLogger } = require("./productionLogger");
const { ProductionScheduler } = require("./productionScheduler");
const { createReadinessCheck, startProductionServer } = require("./productionServer");

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function tempDir(prefix = "arcore-production-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function silentLogger(lines = []) {
  return createProductionLogger({ write: (line) => lines.push(line) });
}

function schedulerConfig(overrides = {}) {
  return {
    enabled: true,
    intervalMinutes: 60,
    mode: "PLAN",
    executionConfirmed: false,
    blocked: false,
    blockedReasons: [],
    ...overrides,
  };
}

function serverConfig(dataDir, overrides = {}) {
  return {
    service: "arcore-poc",
    version: "1.0.0",
    port: 0,
    dataDir,
    auth: { enabled: false, username: "", password: "" },
    scheduler: schedulerConfig({ enabled: false }),
    shutdownTimeoutMs: 1000,
    env: {},
    ...overrides,
  };
}

async function withApp(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function fakeService() {
  return {
    dashboard: () => ({}),
    products: () => [],
    product: () => null,
    activity: () => [],
    refresh: async () => ({}),
  };
}

test("1. DATA_DIR usa output por defecto", () => {
  assert.equal(resolveDataDir({}), DEFAULT_DATA_DIR);
});

test("2. DATA_DIR custom se resuelve", () => {
  const custom = path.join(tempDir(), "data");
  assert.equal(resolveDataDir({ DATA_DIR: custom }), path.resolve(custom));
});

test("3. reportes production-sync persisten en directorio custom", () => {
  const outputDir = path.join(tempDir(), "production-sync");
  const file = persistProductionSyncReport({ runId: "custom", mode: "PLAN" }, outputDir);
  assert.equal(file, path.join(outputDir, "custom.json"));
  assert.equal(fs.existsSync(file), true);
});

test("4. health responde 200 sin dependencias externas", async () => {
  await withApp(createDashboardApp({ service: fakeService() }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.version, "1.0.0");
  });
});

test("5. ready responde 200 cuando los checks locales pasan", async () => {
  const app = createDashboardApp({
    service: fakeService(),
    readinessCheck: async () => ({ ready: true, checks: { dataDir: "ok" } }),
  });
  await withApp(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
  });
});

test("6. ready responde 503 ante storage invalido", async () => {
  const root = tempDir();
  const file = path.join(root, "file");
  fs.writeFileSync(file, "x");
  const readinessCheck = createReadinessCheck({
    config: { dataDir: path.join(file, "data") },
    scheduler: { readiness: () => ({ ready: true }) },
  });
  await withApp(createDashboardApp({ service: fakeService(), readinessCheck }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).checks.dataDir, "failed");
  });
});

test("7. auth deshabilitada permite dashboard", async () => {
  await withApp(createDashboardApp({ service: fakeService() }), async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/dashboard`)).status, 200);
  });
});

test("8. auth habilitada acepta credenciales correctas", async () => {
  const app = createDashboardApp({
    service: fakeService(),
    auth: { enabled: true, username: "user", password: "pass" },
  });
  await withApp(app, async (baseUrl) => {
    const authorization = `Basic ${Buffer.from("user:pass").toString("base64")}`;
    assert.equal((await fetch(`${baseUrl}/api/dashboard`, { headers: { authorization } })).status, 200);
  });
});

test("9. auth incorrecta responde 401", async () => {
  const app = createDashboardApp({
    service: fakeService(),
    auth: { enabled: true, username: "user", password: "pass" },
  });
  await withApp(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { authorization: `Basic ${Buffer.from("user:bad").toString("base64")}` },
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate"), /Basic/);
  });
});

test("10. auth incompleta rechaza startup", () => {
  assert.throws(
    () => loadProductionConfig({
      env: { DASHBOARD_AUTH_ENABLED: "true", DASHBOARD_USERNAME: "user" },
      validateStorage: false,
    }),
    (error) => error.code === "DASHBOARD_AUTH_INCOMPLETE",
  );
});

test("11. scheduler deshabilitado no ejecuta runs", async () => {
  let calls = 0;
  const scheduler = new ProductionScheduler({
    config: schedulerConfig({ enabled: false }),
    dataDir: tempDir(),
    logger: silentLogger(),
    runSync: async () => { calls += 1; },
  });
  scheduler.start();
  assert.equal((await scheduler.runNow()).status, "SKIPPED_DISABLED");
  assert.equal(calls, 0);
});

test("12. scheduler PLAN ejecuta el runtime en modo seguro", async () => {
  let received;
  const scheduler = new ProductionScheduler({
    config: schedulerConfig(),
    dataDir: tempDir(),
    logger: silentLogger(),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    runSync: async (options) => {
      received = options;
      return { runId: "plan", stopped: false, durationMs: 1, executedWrites: 0 };
    },
  });
  scheduler.start();
  const result = await scheduler.runNow();
  assert.equal(result.status, "COMPLETED");
  assert.equal(received.mode, "PLAN");
  assert.equal(received.confirmRealWrites, false);
});

test("13. scheduler evita overlapping runs", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const scheduler = new ProductionScheduler({
    config: schedulerConfig(), dataDir: tempDir(), logger: silentLogger(),
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
    runSync: () => pending,
  });
  scheduler.start();
  const first = scheduler.runNow();
  assert.equal((await scheduler.runNow()).status, "SKIPPED_OVERLAP");
  release({ runId: "one", stopped: false, durationMs: 1, executedWrites: 0 });
  await first;
});

test("14. error del scheduler no tumba el proceso", async () => {
  const scheduler = new ProductionScheduler({
    config: schedulerConfig(), dataDir: tempDir(), logger: silentLogger(),
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
    runSync: async () => { throw new Error("token=secret"); },
  });
  scheduler.start();
  const result = await scheduler.runNow();
  assert.equal(result.status, "ERROR");
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("15. metadata del scheduler sobrevive reinicio", async () => {
  const dataDir = tempDir();
  const options = {
    config: schedulerConfig(), dataDir, logger: silentLogger(),
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
    runSync: async () => ({ runId: "persisted", stopped: false, durationMs: 8, executedWrites: 0 }),
  };
  const first = new ProductionScheduler(options);
  first.start();
  await first.runNow();
  const second = new ProductionScheduler(options);
  assert.equal(second.metadata.lastRunId, "persisted");
  assert.equal(second.metadata.lastResult, "COMPLETED");
});

test("16. EXECUTE sin confirmacion productiva queda bloqueado", () => {
  const config = loadProductionConfig({
    validateStorage: false,
    env: {
      PRODUCTION_SYNC_SCHEDULE_ENABLED: "true",
      PRODUCTION_SYNC_MODE: "EXECUTE",
      TIENDANUBE_DRY_RUN: "false",
      TIENDANUBE_EXECUTION_ENABLED: "true",
      TIENDANUBE_PRICE_EXECUTION_ENABLED: "true",
      TIENDANUBE_STATUS_EXECUTION_ENABLED: "true",
      TIENDANUBE_IMAGE_EXECUTION_ENABLED: "true",
      TIENDANUBE_CREATE_EXECUTION_ENABLED: "true",
    },
  });
  assert.equal(config.scheduler.blocked, true);
  assert(config.scheduler.blockedReasons.some((item) => item.code === "PRODUCTION_EXECUTION_NOT_CONFIRMED"));
});

test("17. EXECUTE sin gates queda bloqueado", () => {
  const config = loadProductionConfig({
    validateStorage: false,
    env: {
      PRODUCTION_SYNC_SCHEDULE_ENABLED: "true",
      PRODUCTION_SYNC_MODE: "EXECUTE",
      PRODUCTION_SYNC_EXECUTION_CONFIRMED: "true",
    },
  });
  assert.equal(config.scheduler.blocked, true);
  assert(config.scheduler.blockedReasons.some((item) => item.code === "GLOBAL_EXECUTION_DISABLED"));
});

test("18. graceful shutdown sin run activo", async () => {
  const dataDir = tempDir();
  const runtime = await startProductionServer({
    config: serverConfig(dataDir),
    logger: silentLogger(),
    service: fakeService(),
  });
  const result = await runtime.shutdown("test");
  assert.equal(result.completed, true);
  assert.equal(runtime.server.listening, false);
});

test("19. graceful shutdown espera run activo", async () => {
  const dataDir = tempDir();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const scheduler = new ProductionScheduler({
    config: schedulerConfig(), dataDir, logger: silentLogger(),
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
    runSync: () => pending,
  });
  scheduler.start();
  const active = scheduler.runNow();
  const runtime = await startProductionServer({
    config: serverConfig(dataDir, { scheduler: scheduler.config }),
    logger: silentLogger(),
    scheduler,
    service: fakeService(),
  });
  setTimeout(() => release({ runId: "active", stopped: false, durationMs: 1, executedWrites: 0 }), 20);
  const result = await runtime.shutdown("test-active");
  await active;
  assert.equal(result.completed, true);
});

test("20. logs estructurados no exponen secretos", () => {
  const lines = [];
  const logger = silentLogger(lines);
  logger.error("test", "Bearer abc123", { password: "hidden", cookie: "session=x" });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /abc123|hidden|session=x/);
  assert.match(lines[0], /\[REDACTED\]/);
});

test("21. activity incluye production-sync", () => {
  const outputDir = tempDir();
  const directory = path.join(outputDir, "production-sync");
  const report = {
    runId: "activity", mode: "PLAN", startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z", scopeCount: 85,
    autoExecutable: 50, executedWrites: 0, stopped: false, security: {},
  };
  persistProductionSyncReport(report, directory);
  assert.equal(activityFromProductionSync(report).type, "Runtime productivo PLAN");
  assert(loadActivity(outputDir).some((item) => item.id === "activity"));
});

test("22. PORT tiene prioridad sobre DASHBOARD_PORT", () => {
  const config = loadProductionConfig({
    validateStorage: false,
    env: { PORT: "4321", DASHBOARD_PORT: "9876" },
  });
  assert.equal(config.port, 4321);
});

test("23. validacion central rechaza configuracion invalida", () => {
  assert.throws(
    () => loadProductionConfig({ validateStorage: false, env: { PORT: "invalid" } }),
    (error) => error.code === "PORT_INVALID",
  );
  assert.throws(
    () => loadProductionConfig({ validateStorage: false, env: { PRODUCTION_SYNC_MODE: "WRITE" } }),
    (error) => error.code === "PRODUCTION_SYNC_MODE_INVALID",
  );
  assert.throws(
    () => loadProductionConfig({ validateStorage: false, env: { PRODUCTION_SYNC_INTERVAL_MINUTES: "0" } }),
    (error) => error.code === "PRODUCTION_SYNC_INTERVAL_INVALID",
  );
  const root = tempDir();
  const file = path.join(root, "not-a-directory");
  fs.writeFileSync(file, "x");
  assert.throws(
    () => loadProductionConfig({ env: { DATA_DIR: path.join(file, "data") } }),
    (error) => error.code === "DATA_DIR_NOT_WRITABLE",
  );
});

test("24. startup defaults son seguros", () => {
  const dataDir = tempDir();
  const config = loadProductionConfig({ env: { DATA_DIR: dataDir } });
  const gates = readExecutionGates(config.env);
  assert.equal(config.scheduler.enabled, false);
  assert.equal(config.scheduler.mode, "PLAN");
  assert.equal(config.auth.enabled, false);
  assert.equal(gates.writeOperationsAvailable, false);
  assert.equal(validateDataDirectory(dataDir), dataDir);
});

(async () => {
  let passed = 0;
  for (const current of tests) {
    try {
      await current.run();
      passed += 1;
      console.log(`OK ${current.name}`);
    } catch (error) {
      console.error(`FAIL ${current.name}`);
      throw error;
    }
  }
  console.log(`\nProduction deployment tests: ${passed}/${tests.length} OK`);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
