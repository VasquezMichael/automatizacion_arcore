const { applyPriceRounding, calculateSalePrice } = require("./priceCalculator");

const cases = [
  { value: 0, category: 1, multiplier: 1.5, baseCalculatedPrice: 0, calculatedPrice: 0 },
  { value: 1, category: 1, multiplier: 1.5, baseCalculatedPrice: 1.5, calculatedPrice: 2 },
  { value: 74999, category: 1, multiplier: 1.5, baseCalculatedPrice: 112498.5, calculatedPrice: 112499 },
  { value: 75000, category: 1, multiplier: 1.5, baseCalculatedPrice: 112500, calculatedPrice: 112500 },
  { value: 75000.5, category: 2, multiplier: 1.3, baseCalculatedPrice: 97500.65, calculatedPrice: 97501 },
  { value: 75001, category: 2, multiplier: 1.3, baseCalculatedPrice: 97501.3, calculatedPrice: 97501 },
  { value: 249999, category: 2, multiplier: 1.3, baseCalculatedPrice: 324998.7, calculatedPrice: 324999 },
  { value: 249999.99, category: 2, multiplier: 1.3, baseCalculatedPrice: 324999.99, calculatedPrice: 325000 },
  { value: 250000, category: 3, multiplier: 1.25, baseCalculatedPrice: 312500, calculatedPrice: 312500 },
  { value: 250000.01, category: 3, multiplier: 1.25, baseCalculatedPrice: 312500.01, calculatedPrice: 312500 },
  { value: 711999, category: 3, multiplier: 1.25, baseCalculatedPrice: 889998.75, calculatedPrice: 889999 },
  { value: 712000, category: 3, multiplier: 1.25, baseCalculatedPrice: 890000, calculatedPrice: 890000 },
  { value: 712000.5, category: 4, multiplier: 1.2, baseCalculatedPrice: 854400.6, calculatedPrice: 854401 },
  { value: 712001, category: 4, multiplier: 1.2, baseCalculatedPrice: 854401.2, calculatedPrice: 854401 },
  { value: 1000000, category: 4, multiplier: 1.2, baseCalculatedPrice: 1200000, calculatedPrice: 1200000 },
];

const roundingCases = [
  { value: 563000.06, rounded: 563000 },
  { value: 438249.75, rounded: 438250 },
  { value: 97501.3, rounded: 97501 },
  { value: 854401.2, rounded: 854401 },
  { value: 100.49, rounded: 100 },
  { value: 100.5, rounded: 101 },
  { value: 100.51, rounded: 101 },
];

const invalidCases = [null, undefined, "", "abc", NaN, -1];

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: esperado ${expected}, obtenido ${actual}`);
  }
}

function main() {
  console.log("=== PRUEBAS DE LIMITES DEL MOTOR DE PRECIOS ===");

  for (const testCase of cases) {
    const result = calculateSalePrice(testCase.value);
    assertEqual(result.category, testCase.category, `${testCase.value} categoria`);
    assertEqual(result.multiplier, testCase.multiplier, `${testCase.value} coeficiente`);
    assertEqual(
      result.baseCalculatedPrice,
      testCase.baseCalculatedPrice,
      `${testCase.value} precio base calculado`,
    );
    assertEqual(
      result.calculatedPrice,
      testCase.calculatedPrice,
      `${testCase.value} precio final calculado`,
    );

    console.log(
      `- ${testCase.value} -> categoria ${result.category} | coeficiente ${result.multiplier} | base ${result.baseCalculatedPrice} | final ${result.calculatedPrice}`,
    );
  }

  for (const testCase of roundingCases) {
    const rounded = applyPriceRounding(testCase.value);
    assertEqual(rounded, testCase.rounded, `${testCase.value} redondeo`);
    console.log(`- redondeo ${testCase.value} -> ${rounded}`);
  }

  for (const value of invalidCases) {
    try {
      calculateSalePrice(value);
      throw new Error(`valor invalido aceptado: ${value}`);
    } catch (error) {
      assertEqual(error.code, "INVALID_SUPPLIER_PRICE", `${value} error code`);
      console.log(`- invalido ${String(value)} -> INVALID_SUPPLIER_PRICE`);
    }
  }

  console.log("Resultado: OK. No se detectaron huecos en los limites probados.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Resultado: ERROR - ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  cases,
  main,
};
