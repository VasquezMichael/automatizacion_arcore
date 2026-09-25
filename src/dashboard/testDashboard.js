const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DashboardService, assertReadOnlyReport, deriveUiStatus } = require("./dashboardService");
const { createDashboardApp, errorPayload } = require("./server");
const { loadActivity, loadLatestClientScopeReport, readJsonSafe } = require("./reportService");

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function baseItem(overrides = {}) {
  return {
    inputSku: "415 0549 10",
    normalizedSku: "415054910",
    matchedCode: "4150549100",
    supplierResolution: { type: "SAFE_TRANSFORM" },
    classification: "SINGLE",
    availability: "AVAILABLE",
    tiendanube: { matchCount: 1 },
    status: "SUCCEEDED",
    requiresManualReview: false,
    result: { revalidationStatus: "PASSED", writeAttempted: false },
    plans: {
      status: {
        action: "STATUS_NO_CHANGE",
        publications: [{ productId: 10, variantId: 20, published: true }],
      },
      price: {
        action: "PRICE_NO_CHANGE",
        calculation: { supplierPrice: 100, calculatedPrice: 150 },
        publications: [{
          productId: 10,
          variantId: 20,
          name: "Producto de prueba",
          currentPrice: 150,
          published: true,
        }],
      },
      image: {
        action: "IMAGE_NO_CHANGE",
        sourceImageUrl: "https://www.arcore.com/catalogoWeb/imagenes/example.png",
        publications: [{ productId: 10, variantId: 20, tiendanubeImageCount: 1 }],
      },
      create: null,
    },
    warnings: [],
    errors: [],
    clientScope: { sourceSku: "415 0549 10", occurrenceCount: 1 },
    ...overrides,
  };
}

function baseReport(items = [baseItem()]) {
  return {
    metadata: {
      runId: "dashboard-test",
      startedAt: "2026-09-25T10:00:00.000Z",
      completedAt: "2026-09-25T10:01:00.000Z",
      mode: "READ_ONLY",
      writesAllowed: false,
      sourceMetrics: { contextsOpened: 1, reauthCount: 0, sessionRetryCount: 0 },
    },
    scopeSummary: { uniqueSkuCount: items.length },
    batchSummary: {
      processedCount: items.length,
      succeededCount: items.length,
      failedCount: 0,
      blockedCount: 0,
      manualReviewCount: 0,
      classifications: {},
    },
    availabilitySummary: { AVAILABLE: items.length },
    plannedActions: {},
    security: {
      globalWriteRequested: false,
      createWriteRequested: false,
      priceWriteRequested: false,
      statusWriteRequested: false,
      imageWriteRequested: false,
      writeAttempted: 0,
    },
    items,
  };
}

function tempOutput(report) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcore-dashboard-"));
  if (report) {
    const directory = path.join(outputDir, "client-scope");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report));
  }
  return outputDir;
}

async function withServer(service, run) {
  const server = createDashboardApp({ service }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("sirve la aplicacion HTML", async () => {
  const service = new DashboardService({ outputDir: tempOutput(), loadScope: () => ({ summary: { uniqueSkuCount: 85 } }) });
  await withServer(service, async (baseUrl) => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Sincronizaci.n de Cat.logo/);
  });
});

test("GET summary sin reportes usa el alcance maestro", async () => {
  const service = new DashboardService({ outputDir: tempOutput(), loadScope: () => ({ summary: { uniqueSkuCount: 85 } }) });
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dashboard`);
    const dashboard = await response.json();
    assert.equal(response.status, 200);
    assert.equal(dashboard.hasReport, false);
    assert.equal(dashboard.scopeSummary.clientSkus, 85);
  });
});

test("GET summary con reporte resume datos persistidos", async () => {
  const service = new DashboardService({ outputDir: tempOutput(baseReport()) });
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dashboard`);
    const dashboard = await response.json();
    assert.equal(response.status, 200);
    assert.equal(dashboard.hasReport, true);
    assert.equal(dashboard.scopeSummary.resolvedInArcore, 1);
    assert.equal(dashboard.scopeSummary.existingInTiendanube, 1);
  });
});

test("lista productos sin exponer detalle tecnico", () => {
  const service = new DashboardService({ outputDir: tempOutput(baseReport()) });
  const [product] = service.products();
  assert.equal(product.uiStatus, "OK");
  assert.equal(product.details, undefined);
  assert.equal(product.tiendanubePrice, 150);
});

test("detalle expone fuentes separadas", () => {
  const service = new DashboardService({ outputDir: tempOutput(baseReport()) });
  const product = service.product("415054910");
  assert.equal(product.details.arcore.matchedCode, "4150549100");
  assert.equal(product.details.tiendanube.publications[0].productId, 10);
  assert.equal(product.details.plan.price, "PRICE_NO_CHANGE");
});

test("estado OK no tiene cambios pendientes", () => {
  assert.equal(deriveUiStatus(baseItem()), "OK");
});

test("estado UPDATE_REQUIRED detecta precio pendiente", () => {
  const item = baseItem();
  item.plans.price.action = "PRICE_UPDATE";
  assert.equal(deriveUiStatus(item), "UPDATE_REQUIRED");
});

test("estado CREATE_REQUIRED detecta creacion simulable", () => {
  const item = baseItem({ classification: "CREATE_SINGLE", tiendanube: { matchCount: 0 } });
  item.plans.create = { plannedAction: "CREATE_SINGLE", simulationResult: "WOULD_CREATE" };
  assert.equal(deriveUiStatus(item), "CREATE_REQUIRED");
});

test("estado MANUAL_REVIEW prevalece sobre acciones", () => {
  const item = baseItem({ classification: "MANUAL_REVIEW", requiresManualReview: true });
  item.plans.price.action = "PRICE_UPDATE";
  assert.equal(deriveUiStatus(item), "MANUAL_REVIEW");
});

test("estado NOT_FOUND distingue ausencia Arcore", () => {
  const item = baseItem({ supplierResolution: { type: "NOT_FOUND" }, requiresManualReview: true });
  assert.equal(deriveUiStatus(item), "NOT_FOUND");
});

test("refresh ejecuta runClientScope directamente en READ_ONLY", async () => {
  const report = baseReport();
  const outputDir = tempOutput(report);
  let calls = 0;
  const service = new DashboardService({
    outputDir,
    runClientScope: async () => { calls += 1; return report; },
  });
  const dashboard = await service.refresh();
  assert.equal(calls, 1);
  assert.equal(dashboard.analysisRunning, false);
});

test("refresh concurrente devuelve 409", async () => {
  const report = baseReport();
  let release;
  const pending = new Promise((resolve) => { release = () => resolve(report); });
  const service = new DashboardService({ outputDir: tempOutput(report), runClientScope: () => pending });
  await withServer(service, async (baseUrl) => {
    const first = fetch(`${baseUrl}/api/analysis/refresh`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await fetch(`${baseUrl}/api/analysis/refresh`, { method: "POST" });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, "ANALYSIS_ALREADY_RUNNING");
    release();
    assert.equal((await first).status, 200);
  });
});

test("refresh rechaza un reporte que no confirma READ_ONLY", async () => {
  const report = baseReport();
  report.metadata.writesAllowed = true;
  assert.throws(() => assertReadOnlyReport(report), /modo seguro/);
});

test("errores internos quedan sanitizados", async () => {
  const service = new DashboardService({
    outputDir: tempOutput(),
    runClientScope: async () => { throw new Error("token=SECRETO stack interno"); },
  });
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/analysis/refresh`, { method: "POST" });
    const body = JSON.stringify(await response.json());
    assert.equal(response.status, 500);
    assert.doesNotMatch(body, /SECRETO|stack interno/);
  });
});

test("modelo publico no propaga campos sensibles del reporte", () => {
  const item = baseItem({ accessToken: "SECRETO", cookie: "SESSION=SECRETO", raw: { password: "SECRETO" } });
  const service = new DashboardService({ outputDir: tempOutput(baseReport([item])) });
  assert.doesNotMatch(JSON.stringify(service.products()), /SECRETO|accessToken|cookie|password/);
});

test("actividad ignora JSON invalido y ordena por fecha", () => {
  const outputDir = tempOutput(baseReport());
  fs.writeFileSync(path.join(outputDir, "client-scope", "invalid.json"), "{invalid");
  const activity = loadActivity(outputDir);
  assert.equal(activity.length, 1);
  assert.equal(activity[0].writes, 0);
});

test("lector JSON tolera archivo corrupto", () => {
  const file = path.join(tempOutput(), "bad.json");
  fs.writeFileSync(file, "no-json");
  assert.equal(readJsonSafe(file), null);
});

test("selecciona el ultimo reporte READ_ONLY valido", () => {
  const outputDir = tempOutput();
  const directory = path.join(outputDir, "client-scope");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "invalid.json"), JSON.stringify({ metadata: { mode: "MUTABLE" }, items: [] }));
  fs.writeFileSync(path.join(directory, "valid.json"), JSON.stringify(baseReport()));
  assert.equal(loadLatestClientScopeReport(outputDir).metadata.mode, "READ_ONLY");
});

test("no existen endpoints mutables de productos", async () => {
  const service = new DashboardService({ outputDir: tempOutput(baseReport()) });
  await withServer(service, async (baseUrl) => {
    for (const request of [
      ["POST", "/api/products"],
      ["PUT", "/api/products/10"],
      ["DELETE", "/api/products/10"],
      ["POST", "/api/execute"],
    ]) {
      const response = await fetch(`${baseUrl}${request[1]}`, { method: request[0] });
      assert.equal(response.status, 404);
    }
  });
});

test("detalle inexistente devuelve 404 sanitizado", async () => {
  const service = new DashboardService({ outputDir: tempOutput(baseReport()) });
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/products/no-existe`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "PRODUCT_NOT_FOUND");
  });
});

test("errorPayload no expone errores inesperados", () => {
  const payload = errorPayload(new Error("Bearer SECRETO"));
  assert.equal(payload.status, 500);
  assert.doesNotMatch(JSON.stringify(payload.body), /SECRETO/);
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
  console.log(`\nDashboard tests: ${passed}/${tests.length} OK`);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
