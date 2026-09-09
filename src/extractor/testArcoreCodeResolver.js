const assert = require("assert/strict");
const {
  SupplierResolutionType,
  resolveArcoreCode,
} = require("./arcoreCodeResolver");
const { normalizeSku } = require("../tiendanube/sku");
const { syncProduct } = require("../sync/syncProduct");

function assertResolution(name, requestedCode, candidates, expected) {
  const actual = resolveArcoreCode(requestedCode, candidates);
  assert.equal(actual.type, expected.type, name);
  assert.equal(actual.matchedCode, expected.matchedCode ?? null, name);
  assert.equal(actual.rule, expected.rule ?? null, name);
  console.log(`OK ${name}: ${actual.type}`);
  return actual;
}

async function assertBlockedOrchestrator(type) {
  const supplierResolution = {
    type,
    sourceCode: "415054910",
    matchedCode: null,
    rule: null,
    candidates: type === "AMBIGUOUS" ? [{ code: "4150549100" }] : [],
  };
  const error = new Error(`Resolucion Arcore bloqueada: ${type}.`);
  error.code =
    type === "AMBIGUOUS"
      ? "ARCORE_PRODUCT_AMBIGUOUS"
      : "ARCORE_PRODUCT_NOT_FOUND";
  error.supplierResolution = supplierResolution;

  const result = await syncProduct("415 0549 10", {
    extractArcoreProduct: async () => {
      throw error;
    },
    client: new Proxy(
      {},
      {
        get() {
          throw new Error("El cliente Tiendanube no debe usarse.");
        },
      },
    ),
  });

  assert.equal(result.classification, "MANUAL_REVIEW");
  assert.deepEqual(result.plans, { status: null, price: null, image: null });
  assert.equal(result.summary.requiresManualReview, true);
  assert.equal(result.summary.requiresCreation, false);
  console.log(`OK orquestador bloquea ${type} sin consultar Tiendanube.`);
}

async function main() {
  assertResolution("coincidencia exacta", "415054910", ["415054910"], {
    type: SupplierResolutionType.EXACT,
    matchedCode: "415054910",
    rule: "EXACT_CODE",
  });

  assertResolution("cero final seguro", "415054910", ["4150549100"], {
    type: SupplierResolutionType.SAFE_TRANSFORM,
    matchedCode: "4150549100",
    rule: "APPEND_TRAILING_ZERO",
  });

  assertResolution("ultimo digito diferente rechazado", "415054910", ["4150549101"], {
    type: SupplierResolutionType.NOT_FOUND,
  });

  assertResolution("dos ceros finales rechazados", "415054910", ["41505491000"], {
    type: SupplierResolutionType.NOT_FOUND,
  });

  assertResolution("prefijo agregado rechazado", "415054910", ["X415054910"], {
    type: SupplierResolutionType.NOT_FOUND,
  });

  assertResolution("sufijo alfanumerico rechazado", "415054910", ["415054910ABC"], {
    type: SupplierResolutionType.NOT_FOUND,
  });

  const ambiguous = assertResolution(
    "multiples candidatos potenciales",
    "415054910",
    [
      { id: "exact", codComercial: "415054910" },
      { id: "safe", codComercial: "4150549100" },
    ],
    { type: SupplierResolutionType.AMBIGUOUS },
  );
  assert.equal(ambiguous.candidates.length, 2);

  assertResolution("sin candidatos", "415054910", [], {
    type: SupplierResolutionType.NOT_FOUND,
  });

  assert.equal(normalizeSku("415 0549 10"), "415054910");
  assert.notEqual(normalizeSku("415 0549 10"), "4150549100");
  console.log("OK normalizeSku conserva solo normalizacion de formato.");

  await assertBlockedOrchestrator(SupplierResolutionType.AMBIGUOUS);
  await assertBlockedOrchestrator(SupplierResolutionType.NOT_FOUND);
  console.log("Resultado: OK. Resolucion Arcore segura verificada.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fallo test de resolucion Arcore: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
