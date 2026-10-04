const path = require("path");
const crypto = require("crypto");
const express = require("express");
const packageJson = require("../../package.json");
const { DashboardError, DashboardService } = require("./dashboardService");

const PUBLIC_DIR = path.resolve(__dirname, "..", "..", "public", "dashboard");

function errorPayload(error) {
  if (error instanceof DashboardError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "ANALYSIS_FAILED",
        message: "No se pudo completar la operación solicitada.",
      },
    },
  };
}

function secureEqual(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createBasicAuthMiddleware(auth = {}) {
  if (!auth.enabled) return (_request, _response, next) => next();
  if (!auth.username || !auth.password) {
    throw new Error("DASHBOARD_AUTH_INCOMPLETE");
  }
  return (request, response, next) => {
    const header = String(request.headers.authorization || "");
    const encoded = header.startsWith("Basic ") ? header.slice(6) : "";
    let username = "";
    let password = "";
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        username = decoded.slice(0, separator);
        password = decoded.slice(separator + 1);
      }
    } catch (_error) {
      // La respuesta uniforme evita filtrar detalles de autenticacion.
    }
    if (secureEqual(username, auth.username) && secureEqual(password, auth.password)) {
      return next();
    }
    response.set("WWW-Authenticate", 'Basic realm="Arcore Dashboard", charset="UTF-8"');
    return response.status(401).json({
      error: { code: "AUTH_REQUIRED", message: "Autenticacion requerida." },
    });
  };
}

function createDashboardApp(options = {}) {
  const app = express();
  const service = options.service || new DashboardService(options);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      service: options.serviceName || packageJson.name,
      version: options.version || packageJson.version,
      uptime: process.uptime(),
    });
  });
  app.get("/ready", async (_request, response) => {
    try {
      const readiness = options.readinessCheck
        ? await options.readinessCheck()
        : { ready: true, checks: { localRuntime: "ok" } };
      return response.status(readiness.ready === false ? 503 : 200).json({
        status: readiness.ready === false ? "not_ready" : "ready",
        checks: readiness.checks || {},
      });
    } catch (_error) {
      return response.status(503).json({
        status: "not_ready",
        checks: { localRuntime: "failed" },
      });
    }
  });

  app.use(createBasicAuthMiddleware(options.auth));

  app.get("/api/dashboard", (_request, response) => {
    response.json(service.dashboard());
  });
  app.get("/api/products", (_request, response) => {
    response.json({ products: service.products() });
  });
  app.get("/api/products/:normalizedSku", (request, response) => {
    const product = service.product(request.params.normalizedSku);
    if (!product) {
      return response.status(404).json({
        error: { code: "PRODUCT_NOT_FOUND", message: "Producto no encontrado." },
      });
    }
    return response.json(product);
  });
  app.get("/api/activity", (_request, response) => {
    response.json({ activity: service.activity() });
  });
  app.post("/api/analysis/refresh", async (_request, response, next) => {
    try {
      const dashboard = await service.refresh();
      response.json({ status: "COMPLETED", dashboard });
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(PUBLIC_DIR, {
    extensions: ["html"],
    index: "index.html",
    maxAge: "5m",
  }));
  app.use((error, _request, response, _next) => {
    const payload = errorPayload(error);
    response.status(payload.status).json(payload.body);
  });
  return app;
}

function startDashboardServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? process.env.DASHBOARD_PORT ?? 3000);
  const app = createDashboardApp(options);
  const server = app.listen(port, () => {
    console.log(`Dashboard disponible en http://localhost:${port}`);
    console.log("Modo seguro: análisis READ_ONLY, sin endpoints de sincronización mutable.");
  });
  server.requestTimeout = 0;
  return server;
}

if (require.main === module) startDashboardServer();

module.exports = {
  PUBLIC_DIR,
  createBasicAuthMiddleware,
  createDashboardApp,
  errorPayload,
  secureEqual,
  startDashboardServer,
};
