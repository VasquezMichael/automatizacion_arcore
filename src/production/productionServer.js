require("dotenv").config();

const fs = require("fs");
const http = require("http");
const { validateDataDirectory } = require("../config/dataDirectory");
const { DashboardService } = require("../dashboard/dashboardService");
const { createDashboardApp } = require("../dashboard/server");
const { loadProductionConfig } = require("./productionConfig");
const { createProductionLogger } = require("./productionLogger");
const { ProductionScheduler } = require("./productionScheduler");

function createReadinessCheck({ config, scheduler }) {
  return async () => {
    const checks = {
      dataDir: "ok",
      configuration: "ok",
      runtime: fs.existsSync(require.resolve("../productionSync/productionSyncRunner"))
        ? "ok"
        : "failed",
      scheduler: "ok",
    };
    try {
      validateDataDirectory(config.dataDir);
    } catch (_error) {
      checks.dataDir = "failed";
    }
    const schedulerReadiness = scheduler.readiness();
    if (!schedulerReadiness.ready) checks.scheduler = "failed";
    return {
      ready: Object.values(checks).every((value) => value === "ok"),
      checks,
    };
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    return server.close(() => resolve());
  });
}

async function startProductionServer(options = {}) {
  const config = options.config || loadProductionConfig(options);
  const logger = options.logger || createProductionLogger({ component: "production-server" });
  const scheduler = options.scheduler || new ProductionScheduler({
    config: config.scheduler,
    dataDir: config.dataDir,
    env: config.env,
    logger,
    runSync: options.runSync,
  });
  const service = options.service || new DashboardService({
    outputDir: config.dataDir,
    runtimeStatusProvider: () => scheduler.status(),
  });
  const readinessCheck = options.readinessCheck || createReadinessCheck({ config, scheduler });
  const app = createDashboardApp({
    service,
    auth: config.auth,
    serviceName: config.service,
    version: config.version,
    readinessCheck,
  });
  const server = options.server || http.createServer(app);
  server.requestTimeout = 0;
  await listen(server, config.port);

  logger.info("server.started", "Servidor productivo iniciado.", {
    port: server.address().port,
    version: config.version,
    dataDir: config.dataDir,
  });
  logger.warn(
    "storage.persistence_required",
    "DATA_DIR debe estar montado sobre almacenamiento persistente en produccion.",
    { dataDir: config.dataDir },
  );
  scheduler.start();

  let shutdownPromise = null;
  async function shutdown(signal = "manual") {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info("server.shutdown_started", "Inicio de cierre ordenado.", { signal });
      const closingServer = closeServer(server);
      const schedulerResult = await scheduler.stop(config.shutdownTimeoutMs);
      const serverResult = await Promise.race([
        closingServer.then(() => ({ completed: true, timedOut: false })),
        new Promise((resolve) => {
          const timeout = setTimeout(
            () => resolve({ completed: false, timedOut: true }),
            config.shutdownTimeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
      const result = {
        completed: schedulerResult.completed && serverResult.completed,
        timedOut: schedulerResult.timedOut || serverResult.timedOut,
        scheduler: schedulerResult,
        server: serverResult,
      };
      logger.info("server.shutdown_finished", "Cierre ordenado finalizado.", result);
      return result;
    })();
    return shutdownPromise;
  }

  return { app, config, logger, scheduler, server, shutdown };
}

async function main() {
  try {
    const runtime = await startProductionServer();
    let handlingSignal = false;
    const handleSignal = async (signal) => {
      if (handlingSignal) return;
      handlingSignal = true;
      const result = await runtime.shutdown(signal);
      process.exitCode = result.completed ? 0 : 1;
    };
    process.once("SIGTERM", () => handleSignal("SIGTERM"));
    process.once("SIGINT", () => handleSignal("SIGINT"));
  } catch (error) {
    const logger = createProductionLogger({ component: "production-server" });
    logger.error("server.start_failed", "No se pudo iniciar el servidor productivo.", {
      code: error.code || "STARTUP_FAILED",
    });
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  closeServer,
  createReadinessCheck,
  listen,
  main,
  startProductionServer,
};
