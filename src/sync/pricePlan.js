const { calculateSalePrice } = require("../pricing/priceCalculator");
const {
  aggregatePublicationAction,
  analyzePublicationPrice,
} = require("../pricing/priceComparison");

function serializePricingError(error, supplierPrice) {
  return {
    code: error.code || "PRICE_CALCULATION_FAILED",
    message: error.message,
    supplierPrice,
  };
}

function buildPricePlan({ classification, matches, supplierPrice }) {
  let calculation;

  try {
    calculation = calculateSalePrice(supplierPrice);
  } catch (error) {
    return {
      action: error.code || "PRICE_CALCULATION_FAILED",
      calculation: null,
      publications: [],
      errors: [serializePricingError(error, supplierPrice)],
    };
  }

  if (classification === "MANUAL_REVIEW") {
    return {
      action: "PRICE_WRITE_BLOCKED",
      calculation,
      publications: [],
      errors: [],
    };
  }

  if (classification === "CREATE_SINGLE") {
    return {
      action: "PRICE_FOR_CREATION",
      calculation,
      publications: [],
      errors: [],
    };
  }

  const publications = matches.map((match) =>
    analyzePublicationPrice(match, calculation.calculatedPrice),
  );

  return {
    action: aggregatePublicationAction(publications),
    calculation,
    publications,
    errors: publications.flatMap((publication) => publication.errors),
  };
}

module.exports = {
  buildPricePlan,
};
