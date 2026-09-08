const {
  moneyDifference,
  moneyEquals,
  parseMoney,
} = require("./priceCalculator");

function pickName(value) {
  if (!value) return "sin nombre";
  if (typeof value === "string") return value;
  return value.es || value.pt || value.en || JSON.stringify(value);
}

function decidePriceAction({ calculatedPrice, currentPrice }) {
  if (currentPrice === null) {
    return {
      action: "MANUAL_REVIEW",
      difference: null,
      reason: "Tiendanube no devolvio un precio utilizable para comparar.",
    };
  }

  const difference = moneyDifference(calculatedPrice, currentPrice);
  if (moneyEquals(calculatedPrice, currentPrice)) {
    return {
      action: "PRICE_NO_CHANGE",
      difference,
      reason: "El precio actual coincide normalizado a 2 decimales.",
    };
  }

  return {
    action: "PRICE_UPDATE",
    difference,
    reason: "El precio actual difiere del precio calculado.",
  };
}

function analyzePublicationPrice(match, calculatedPrice) {
  const currentPrice = parseMoney(match.price);
  const decision = decidePriceAction({ calculatedPrice, currentPrice });

  return {
    productId: match.productId,
    variantId: match.variantId,
    sku: match.sku,
    name: pickName(match.name),
    published: match.published,
    currentPrice,
    rawCurrentPrice: match.price,
    oldPrice: currentPrice,
    requestedPrice: calculatedPrice,
    verifiedPrice: null,
    difference: decision.difference,
    action: decision.action,
    reason: decision.reason,
    writeAttempted: false,
    writeSucceeded: false,
    verified: decision.action === "PRICE_NO_CHANGE",
    updated: false,
    errors: [],
  };
}

function aggregatePublicationAction(publications) {
  const actions = publications.map((publication) => publication.action);
  const updatedCount = publications.filter((publication) => publication.updated).length;
  const failedCount = publications.filter((publication) =>
    ["MANUAL_REVIEW", "PRICE_UPDATE_FAILED", "PRICE_UPDATE_VERIFICATION_FAILED"].includes(
      publication.action,
    ),
  ).length;

  if (actions.includes("PRICE_WRITE_BLOCKED")) return "PRICE_WRITE_BLOCKED";
  if (updatedCount > 0 && failedCount > 0) return "LEGACY_PRICE_PARTIAL_FAILURE";
  if (actions.includes("MANUAL_REVIEW")) return "MANUAL_REVIEW";
  if (actions.includes("PRICE_UPDATE")) return "PRICE_UPDATE";
  if (actions.includes("PRICE_UPDATE_FAILED")) return "PRICE_UPDATE_FAILED";
  if (actions.includes("PRICE_UPDATE_VERIFICATION_FAILED")) {
    return "PRICE_UPDATE_VERIFICATION_FAILED";
  }
  if (actions.includes("PRICE_UPDATED")) return "PRICE_UPDATED";
  if (actions.length > 0 && actions.every((action) => action === "PRICE_NO_CHANGE")) {
    return "PRICE_NO_CHANGE";
  }
  return "MANUAL_REVIEW";
}

function calculatePublicationCounters(publications) {
  return {
    totalPublications: publications.length,
    noChangeCount: publications.filter(
      (publication) => publication.action === "PRICE_NO_CHANGE",
    ).length,
    updatedCount: publications.filter((publication) => publication.updated).length,
    failedCount: publications.filter((publication) =>
      [
        "MANUAL_REVIEW",
        "PRICE_UPDATE_FAILED",
        "PRICE_UPDATE_VERIFICATION_FAILED",
      ].includes(publication.action),
    ).length,
  };
}

function applyAggregateTrace(result) {
  const attemptedPublications = result.publications.filter(
    (publication) => publication.writeAttempted,
  );
  const counters = calculatePublicationCounters(result.publications);

  result.writeAttempted = attemptedPublications.length > 0;
  result.anyWriteSucceeded = result.publications.some(
    (publication) => publication.writeSucceeded,
  );
  result.allWritesSucceeded =
    attemptedPublications.length > 0 &&
    attemptedPublications.every((publication) => publication.writeSucceeded);
  result.allVerified =
    result.publications.length > 0 &&
    result.publications.every((publication) => publication.verified);
  result.anyUpdated = result.publications.some((publication) => publication.updated);

  if (result.type === "LEGACY_GROUP") {
    result.writeSucceeded = result.allWritesSucceeded;
    result.verified = result.allVerified;
    result.updated = result.allVerified && result.anyUpdated && counters.failedCount === 0;
  } else {
    result.writeSucceeded = result.anyWriteSucceeded;
    result.verified = result.allVerified;
    result.updated = result.anyUpdated;
  }

  Object.assign(result, counters);
}

module.exports = {
  aggregatePublicationAction,
  analyzePublicationPrice,
  applyAggregateTrace,
  calculatePublicationCounters,
  decidePriceAction,
};
