const assert = require("assert/strict");
const {
  buildStructuredArticleCard,
  extractSupplierPriceFromText,
  selectResolvedProductSource,
} = require("../extractByCodesTest");
const { normalizeProduct } = require("../normalizer/productNormalizer");
const { buildPricePlan } = require("../sync/pricePlan");
const { buildStatusPlan } = require("../sync/statusPlan");
const { syncProduct } = require("../sync/syncProduct");
const {
  buildBatchItemResult,
  assertReadOnlyExecution,
} = require("../batch/batchSync");
const {
  SupplierResolutionType,
  resolveArcoreCode,
} = require("./arcoreCodeResolver");
const { selectArcoreImageSource } = require("./arcoreImageSource");
const { normalizeSku } = require("../tiendanube/sku");

const FULL_IMAGE_PATH = "16/AA/AA123_20260919090000.png";
const FULL_IMAGE_URL =
  "https://www.arcore.com/catalogoWeb/imagenes/16/AA/AA123_20260919090000.png";

let scenarioCount = 0;

async function scenario(name, test) {
  await test();
  scenarioCount += 1;
  console.log(`OK ${scenarioCount}. ${name}`);
}

function resolution(type, matchedCode = "ABC123") {
  return {
    type,
    sourceCode: "abc123",
    matchedCode:
      type === SupplierResolutionType.EXACT ||
      type === SupplierResolutionType.SAFE_TRANSFORM
        ? matchedCode
        : null,
    rule:
      type === SupplierResolutionType.EXACT
        ? "EXACT_CODE"
        : type === SupplierResolutionType.SAFE_TRANSFORM
          ? "APPEND_TRAILING_ZERO"
          : null,
    candidates: [],
  };
}

function structuredLookup(type = SupplierResolutionType.EXACT, overrides = {}) {
  return {
    article: {
      id: "article-1",
      codComercial: type === SupplierResolutionType.SAFE_TRANSFORM ? "ABC1230" : "ABC123",
      codigo: "INTERNAL-123",
      marcaId: "brand-9",
      marca: "Marca Segura",
      supermedida: "05",
      descripcion: "Articulo estructurado",
    },
    articleDetail: {
      id: "article-1",
      cover: { foto: FULL_IMAGE_PATH },
    },
    resolution: resolution(
      type,
      type === SupplierResolutionType.SAFE_TRANSFORM ? "ABC1230" : "ABC123",
    ),
    diagnostics: {
      httpStatus: 200,
      detail: { httpStatus: 200, error: null },
    },
    ...overrides,
  };
}

function missingDomMatch(type = SupplierResolutionType.NOT_FOUND) {
  return {
    found: false,
    card: null,
    resolution: resolution(type),
  };
}

function domMatch(type = SupplierResolutionType.EXACT) {
  return {
    found: true,
    resolution: resolution(type),
    card: {
      cardIndex: 2,
      codigo: "ABC123",
      marcaId: "dom-brand",
      marca: "Marca DOM",
      nombre: "Articulo DOM",
      precio: null,
      priceSourceLabel: null,
      disponibilidadTexto: "Disponible",
      rawText: "Articulo DOM Su precio $10.000,00",
      image: null,
    },
  };
}

function rawStructuredProduct(overrides = {}) {
  return {
    searchedCode: "ABC 123",
    matchedCode: "ABC123",
    matchType: "EXACT",
    supplierResolution: resolution(SupplierResolutionType.EXACT),
    extractionSource: "STRUCTURED_ARTICLE",
    domCardStatus: "DOM_CARD_NOT_AVAILABLE",
    warnings: [
      {
        code: "ARCORE_DOM_CARD_UNAVAILABLE",
        message: "Tarjeta DOM no disponible.",
      },
    ],
    articleId: "article-1",
    codComercial: "ABC123",
    codigo: "INTERNAL-123",
    marcaId: "brand-9",
    marca: "Marca Segura",
    supermedida: "05",
    nombre: "Articulo estructurado",
    precio: null,
    priceSourceLabel: null,
    disponibilidadTexto: "",
    imageUrl: null,
    stock: null,
    stockDiagnostics: {},
    ...overrides,
  };
}

function ensureTiendanubeTestEnv() {
  const original = {
    accessToken: process.env.TIENDANUBE_ACCESS_TOKEN,
    userAgent: process.env.TIENDANUBE_USER_AGENT,
  };
  process.env.TIENDANUBE_ACCESS_TOKEN ||= "unit-test-token";
  process.env.TIENDANUBE_USER_AGENT ||= "unit-test-agent";
  return () => {
    if (original.accessToken === undefined) delete process.env.TIENDANUBE_ACCESS_TOKEN;
    else process.env.TIENDANUBE_ACCESS_TOKEN = original.accessToken;
    if (original.userAgent === undefined) delete process.env.TIENDANUBE_USER_AGENT;
    else process.env.TIENDANUBE_USER_AGENT = original.userAgent;
  };
}

async function run() {
  await scenario("EXACT estructurado conserva la tarjeta DOM cuando existe", () => {
    const selected = selectResolvedProductSource({
      articleLookup: structuredLookup(),
      match: domMatch(),
    });
    assert.equal(selected.source, "DOM_CARD");
    assert.equal(selected.card.nombre, "Articulo DOM");
    assert.deepEqual(selected.warnings, []);
  });

  await scenario("EXACT estructurado continua sin tarjeta DOM", () => {
    const selected = selectResolvedProductSource({
      articleLookup: structuredLookup(),
      match: missingDomMatch(),
    });
    assert.equal(selected.found, true);
    assert.equal(selected.source, "STRUCTURED_ARTICLE");
  });

  await scenario("SAFE_TRANSFORM conserva la tarjeta DOM cuando existe", () => {
    const selected = selectResolvedProductSource({
      articleLookup: structuredLookup(SupplierResolutionType.SAFE_TRANSFORM),
      match: domMatch(SupplierResolutionType.SAFE_TRANSFORM),
    });
    assert.equal(selected.source, "DOM_CARD");
  });

  await scenario("SAFE_TRANSFORM continua sin tarjeta DOM", () => {
    const selected = selectResolvedProductSource({
      articleLookup: structuredLookup(SupplierResolutionType.SAFE_TRANSFORM),
      match: missingDomMatch(),
    });
    assert.equal(selected.found, true);
    assert.equal(selected.card.codigo, "INTERNAL-123");
  });

  await scenario("detalle estructurado valido conserva cover y metadatos", () => {
    const lookup = structuredLookup();
    const selected = selectResolvedProductSource({
      articleLookup: lookup,
      match: missingDomMatch(),
    });
    assert.equal(selected.card.marcaId, "brand-9");
    assert.equal(selectArcoreImageSource(lookup.articleDetail).imageUrl, FULL_IMAGE_URL);
  });

  await scenario("fallo de detalle conserva identidad de listado con warning", () => {
    const selected = selectResolvedProductSource({
      articleLookup: structuredLookup(SupplierResolutionType.EXACT, {
        articleDetail: null,
        diagnostics: {
          httpStatus: 200,
          detail: { httpStatus: 503, error: "detalle no disponible" },
        },
      }),
      match: missingDomMatch(),
    });
    assert.equal(selected.found, true);
    assert.ok(
      selected.warnings.some(
        (warning) => warning.code === "ARCORE_ARTICLE_DETAIL_UNAVAILABLE",
      ),
    );
  });

  await scenario("NOT_FOUND real no activa fallback estructurado", () => {
    const selected = selectResolvedProductSource({
      articleLookup: {
        article: null,
        resolution: resolution(SupplierResolutionType.NOT_FOUND),
        diagnostics: {},
      },
      match: missingDomMatch(),
    });
    assert.equal(selected.found, false);
  });

  await scenario("AMBIGUOUS no activa fallback ni elige candidato", () => {
    const selected = selectResolvedProductSource({
      articleLookup: {
        article: { id: "unsafe" },
        resolution: resolution(SupplierResolutionType.AMBIGUOUS),
        diagnostics: {},
      },
      match: missingDomMatch(SupplierResolutionType.AMBIGUOUS),
    });
    assert.equal(selected.found, false);
    assert.equal(selected.card, null);
  });

  await scenario("identidad estructurada preserva codigo interno y marca", () => {
    const card = buildStructuredArticleCard(structuredLookup().article, {});
    assert.deepEqual(
      {
        codigo: card.codigo,
        marcaId: card.marcaId,
        marca: card.marca,
        nombre: card.nombre,
      },
      {
        codigo: "INTERNAL-123",
        marcaId: "brand-9",
        marca: "Marca Segura",
        nombre: "Articulo estructurado",
      },
    );
  });

  await scenario("ausencia de DOM queda diferenciada de found false", () => {
    const selected = selectResolvedProductSource({
      articleLookup: structuredLookup(),
      match: missingDomMatch(),
    });
    assert.equal(selected.found, true);
    assert.equal(selected.domCardStatus, "DOM_CARD_NOT_AVAILABLE");
  });

  await scenario("ausencia de DOM genera warning especifico", () => {
    const selected = selectResolvedProductSource({
      articleLookup: structuredLookup(),
      match: missingDomMatch(),
    });
    assert.deepEqual(
      selected.warnings.map((warning) => warning.code),
      ["ARCORE_DOM_CARD_UNAVAILABLE"],
    );
  });

  await scenario("fallback estructurado no inventa precio proveedor", () => {
    const card = buildStructuredArticleCard(structuredLookup().article, {});
    assert.deepEqual(extractSupplierPriceFromText(card.rawText), {
      precio: null,
      priceSourceLabel: null,
    });
    assert.equal(buildPricePlan({ classification: "CREATE_SINGLE", matches: [], supplierPrice: null }).action, "INVALID_SUPPLIER_PRICE");
  });

  await scenario("fallback estructurado sin stock conserva UNKNOWN", () => {
    const product = normalizeProduct(rawStructuredProduct());
    assert.equal(product.estadoDisponibilidad, "UNKNOWN");
    assert.equal(buildStatusPlan({ classification: "CREATE_SINGLE", matches: [], availability: product.estadoDisponibilidad }).action, "STATUS_UNKNOWN");
  });

  await scenario("cover.foto estructurado sigue disponible", () => {
    const image = selectArcoreImageSource(structuredLookup().articleDetail);
    assert.equal(image.imageUrl, FULL_IMAGE_URL);
    assert.equal(image.imageSourceType, "COVER_FULL");
  });

  await scenario("sin cover no se inventa source image", () => {
    assert.equal(selectArcoreImageSource({ cover: {} }), null);
  });

  await scenario("PRICE_ZERO sigue detectando cero desde Su precio", () => {
    const price = extractSupplierPriceFromText("Precio de lista $99.999,00 Su precio $0,00");
    assert.deepEqual(price, { precio: "0,00", priceSourceLabel: "SU_PRECIO" });
    assert.equal(normalizeProduct(rawStructuredProduct({ precio: price.precio })).precio, 0);
  });

  await scenario("Precio de lista nunca se usa como fallback", () => {
    assert.deepEqual(extractSupplierPriceFromText("Precio de lista $99.999,00"), {
      precio: null,
      priceSourceLabel: null,
    });
  });

  await scenario("resolver rechaza sufijos no aprobados", () => {
    assert.equal(resolveArcoreCode("ABC123", ["ABC1231"]).type, "NOT_FOUND");
  });

  await scenario("resolver conserva APPEND_TRAILING_ZERO", () => {
    const actual = resolveArcoreCode("ABC123", ["ABC1230"]);
    assert.equal(actual.type, "SAFE_TRANSFORM");
    assert.equal(actual.rule, "APPEND_TRAILING_ZERO");
  });

  await scenario("normalizeSku no agrega cero", () => {
    assert.equal(normalizeSku("ABC 123"), "abc123");
  });

  await scenario("normalizador transporta trazabilidad estructurada", () => {
    const product = normalizeProduct(rawStructuredProduct());
    assert.equal(product.articleId, "article-1");
    assert.equal(product.codComercial, "ABC123");
    assert.equal(product.supermedida, "05");
    assert.equal(product.extractionSource, "STRUCTURED_ARTICLE");
    assert.equal(product.domCardStatus, "DOM_CARD_NOT_AVAILABLE");
    assert.equal(product.warnings[0].code, "ARCORE_DOM_CARD_UNAVAILABLE");
  });

  await scenario("syncProduct recibe matchedCode y warning correctos", async () => {
    const restoreEnv = ensureTiendanubeTestEnv();
    try {
      const product = normalizeProduct(rawStructuredProduct());
      const result = await syncProduct("ABC 123", {
        extractArcoreProduct: async () => product,
        client: {
          listProducts: async () => ({ status: 200, data: [] }),
        },
      });
      assert.equal(result.matchedCode, "ABC123");
      assert.equal(result.supplier.articleId, "article-1");
      assert.equal(result.supplier.codigo, "INTERNAL-123");
      assert.equal(result.supplier.marcaId, "brand-9");
      assert.equal(result.supplier.supermedida, "05");
      assert.equal(result.classification, "CREATE_SINGLE");
      assert.ok(result.warnings.some((warning) => warning.code === "ARCORE_DOM_CARD_UNAVAILABLE"));
      assert.ok(!result.errors.some((error) => error.code === "ARCORE_PRODUCT_NOT_FOUND"));
      assert.equal(result.writeOperationsAvailable, false);
    } finally {
      restoreEnv();
    }
  });

  await scenario("NOT_FOUND conserva ARCORE_PRODUCT_NOT_FOUND en syncProduct", async () => {
    const error = new Error("Producto inexistente.");
    error.code = "ARCORE_PRODUCT_NOT_FOUND";
    error.supplierResolution = resolution(SupplierResolutionType.NOT_FOUND);
    const result = await syncProduct("NO EXISTE", {
      extractArcoreProduct: async () => {
        throw error;
      },
      client: new Proxy({}, { get: () => assert.fail("No debe consultar Tiendanube") }),
    });
    assert.equal(result.classification, "MANUAL_REVIEW");
    assert.equal(result.errors[0].code, "ARCORE_PRODUCT_NOT_FOUND");
  });

  await scenario("batch no registra fallback estructurado como product not found", () => {
    const execution = {
      normalizedSku: "abc123",
      matchedCode: "ABC123",
      supplierResolution: resolution(SupplierResolutionType.EXACT),
      classification: "CREATE_SINGLE",
      originalPlan: {
        supplier: { availability: "UNKNOWN" },
        tiendanube: { matchCount: 0, legacyGroup: null },
        plans: {
          status: { action: "STATUS_UNKNOWN", publications: [] },
          price: { action: "INVALID_SUPPLIER_PRICE", publications: [] },
          image: { action: "NO_SOURCE_IMAGE", publications: [] },
        },
      },
      executionPlan: { actions: [] },
      revalidation: { status: "PASSED" },
      result: {
        executionStatus: "BLOCKED",
        wouldWrite: 0,
        blockedActions: 2,
        failedActions: 0,
        writeAttempted: false,
      },
      warnings: [{ code: "ARCORE_DOM_CARD_UNAVAILABLE", message: "DOM ausente" }],
      errors: [],
    };
    const item = buildBatchItemResult(
      { inputSku: "ABC 123", normalizedSku: "abc123" },
      execution,
    );
    assert.equal(item.matchedCode, "ABC123");
    assert.ok(!item.errors.some((error) => error.code === "ARCORE_PRODUCT_NOT_FOUND"));
  });

  await scenario("invariante read-only acepta cero operaciones mutables", () => {
    assert.doesNotThrow(() =>
      assertReadOnlyExecution({
        globalWriteRequested: false,
        priceWriteRequested: false,
        statusWriteRequested: false,
        imageWriteRequested: false,
        createWriteRequested: false,
        writeOperationsAvailable: false,
        result: { writeAttempted: false },
      }),
    );
  });

  assert.ok(scenarioCount >= 20);
  console.log(`Resultado: OK. ${scenarioCount} escenarios estructurados verificados.`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Fallo test de resolucion estructurada Arcore: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
