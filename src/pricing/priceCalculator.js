const priceRules = require("../../config/price-rules.json");

function parseMoney(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;

  if (typeof value === "string") {
    const cleaned = value
      .trim()
      .replace(/\$/g, "")
      .replace(/\s+/g, "");
    const normalized = cleaned.includes(",")
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned.replace(/,/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toMoneyNumber(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toMoneyCents(value) {
  const parsed = parseMoney(value);
  if (parsed === null) return null;
  return Math.round((parsed + Number.EPSILON) * 100);
}

function assertValidSupplierPrice(value) {
  const supplierPrice = parseMoney(value);
  if (supplierPrice === null || supplierPrice < 0) {
    const error = new Error("Precio proveedor invalido.");
    error.code = "INVALID_SUPPLIER_PRICE";
    error.value = value;
    throw error;
  }
  return supplierPrice;
}

function matchesRule(price, rule) {
  if (rule.min !== undefined && price < rule.min) return false;
  if (rule.minExclusive !== undefined && price <= rule.minExclusive) return false;
  if (rule.max !== undefined && price > rule.max) return false;
  if (rule.maxExclusive !== undefined && price >= rule.maxExclusive) return false;
  return true;
}

function findPriceRule(supplierPrice) {
  return priceRules.find((rule) => matchesRule(supplierPrice, rule)) || null;
}

function calculateBaseSalePrice(supplierPrice, multiplier) {
  return toMoneyNumber(supplierPrice * multiplier);
}

function applyPriceRounding(calculatedPrice) {
  return Math.round(calculatedPrice);
}

function calculateSalePrice(value) {
  const supplierPrice = assertValidSupplierPrice(value);
  const rule = findPriceRule(supplierPrice);

  if (!rule) {
    const error = new Error("No existe regla de precio aplicable.");
    error.code = "PRICE_RULE_NOT_FOUND";
    error.supplierPrice = supplierPrice;
    throw error;
  }

  const baseCalculatedPrice = calculateBaseSalePrice(supplierPrice, rule.multiplier);
  const calculatedPrice = applyPriceRounding(baseCalculatedPrice);

  return {
    supplierPrice,
    category: rule.category,
    multiplier: rule.multiplier,
    baseCalculatedPrice,
    calculatedPrice,
  };
}

function moneyEquals(a, b) {
  const centsA = toMoneyCents(a);
  const centsB = toMoneyCents(b);
  return centsA !== null && centsB !== null && centsA === centsB;
}

function moneyDifference(a, b) {
  const centsA = toMoneyCents(a);
  const centsB = toMoneyCents(b);
  if (centsA === null || centsB === null) return null;
  return toMoneyNumber((centsA - centsB) / 100);
}

module.exports = {
  applyPriceRounding,
  calculateBaseSalePrice,
  calculateSalePrice,
  moneyDifference,
  moneyEquals,
  parseMoney,
  priceRules,
  toMoneyCents,
  toMoneyNumber,
};
