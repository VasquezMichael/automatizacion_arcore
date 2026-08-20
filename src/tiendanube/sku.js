function normalizeSku(sku) {
  return String(sku || "")
    .trim()
    .replace(/[\s-]+/g, "")
    .toLowerCase();
}

module.exports = {
  normalizeSku,
};
