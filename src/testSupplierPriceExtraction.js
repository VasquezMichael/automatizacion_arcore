const assert = require("assert");

const { extractSupplierPriceFromText } = require("./extractByCodesTest");
const { normalizeProduct } = require("./normalizer/productNormalizer");

const cases = [
  {
    name: "prioriza Su precio sobre Precio Mostrador",
    text: "Precio de lista $804.285,80 Su precio $450.400,05 Precio Mostrador $450.400,05",
    expectedPrice: 450400.05,
    expectedLabel: "SU_PRECIO",
  },
  {
    name: "usa Precio Mostrador si falta Su precio",
    text: "Precio de lista $804.285,80 Precio Mostrador $450.400,05",
    expectedPrice: 450400.05,
    expectedLabel: "PRECIO_MOSTRADOR",
  },
  {
    name: "no usa Precio de lista",
    text: "Precio de lista $804.285,80",
    expectedPrice: null,
    expectedLabel: null,
  },
  {
    name: "extrae Su precio simple",
    text: "Su precio $350.599,80",
    expectedPrice: 350599.8,
    expectedLabel: "SU_PRECIO",
  },
];

for (const testCase of cases) {
  const extracted = extractSupplierPriceFromText(testCase.text);
  const normalized = normalizeProduct({
    codigo: "TEST",
    precio: extracted.precio,
    priceSourceLabel: extracted.priceSourceLabel,
  });

  assert.strictEqual(
    normalized.precio,
    testCase.expectedPrice,
    `${testCase.name}: precio`,
  );
  assert.strictEqual(
    normalized.priceSourceLabel,
    testCase.expectedLabel,
    `${testCase.name}: priceSourceLabel`,
  );

  console.log(
    `OK ${testCase.name}: ${normalized.precio} / ${normalized.priceSourceLabel}`,
  );
}

console.log("Resultado: OK. Regla de precio proveedor verificada.");
