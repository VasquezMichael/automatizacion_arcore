const path = require("path");
const express = require("express");
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

function createDashboardApp(options = {}) {
  const app = express();
  const service = options.service || new DashboardService(options);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

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
  const port = Number(options.port || process.env.DASHBOARD_PORT || 3000);
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
  createDashboardApp,
  errorPayload,
  startDashboardServer,
};
