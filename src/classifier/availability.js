const AvailabilityStatus = Object.freeze({
  AVAILABLE: "AVAILABLE",
  PARTIAL: "PARTIAL",
  UNAVAILABLE: "UNAVAILABLE",
  UNKNOWN: "UNKNOWN",
});

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function classifyAvailability({ descripcion, descripcionAlternativa, color }) {
  const text = normalizeText(
    [descripcion, descripcionAlternativa, color].filter(Boolean).join(" "),
  );

  if (!text) return AvailabilityStatus.UNKNOWN;

  const unavailableTerms = [
    "sin stock",
    "no disponible",
    "agotado",
    "faltante",
    "sin disponibilidad",
  ];
  if (unavailableTerms.some((term) => text.includes(term))) {
    return AvailabilityStatus.UNAVAILABLE;
  }

  const partialTerms = [
    "parcial",
    "stock parcial",
    "pocas unidades",
    "limitado",
    "consultar",
  ];
  if (partialTerms.some((term) => text.includes(term))) {
    return AvailabilityStatus.PARTIAL;
  }

  const availableTerms = [
    "disponible",
    "con stock",
    "stock disponible",
    "ok",
    "verde",
  ];
  if (availableTerms.some((term) => text.includes(term))) {
    return AvailabilityStatus.AVAILABLE;
  }

  return AvailabilityStatus.UNKNOWN;
}

module.exports = {
  AvailabilityStatus,
  classifyAvailability,
};
