const assert = require("assert/strict");
const { AvailabilityStatus, classifyAvailability } = require("./availability");

const cases = [
  {
    name: "AVAILABLE",
    input: { descripcion: "Disponible", color: "#007400" },
    expected: AvailabilityStatus.AVAILABLE,
  },
  {
    name: "PARTIAL con alternativa disponible con espera",
    input: {
      descripcion: "No disponible",
      descripcionAlternativa: "Hay alternativa disponible con espera.",
      color: "#E6BF00",
    },
    expected: AvailabilityStatus.PARTIAL,
  },
  {
    name: "UNAVAILABLE",
    input: { descripcion: "No disponible", color: "#D32F2F" },
    expected: AvailabilityStatus.UNAVAILABLE,
  },
  {
    name: "UNKNOWN",
    input: { descripcion: "Estado pendiente", color: "#123456" },
    expected: AvailabilityStatus.UNKNOWN,
  },
];

function main() {
  for (const testCase of cases) {
    const actual = classifyAvailability(testCase.input);
    assert.equal(actual, testCase.expected, testCase.name);
    console.log(`OK ${testCase.name}: ${actual}`);
  }

  console.log("Resultado: OK. UNKNOWN se mantiene como fail-safe.");
}

if (require.main === module) {
  main();
}

module.exports = { main };
