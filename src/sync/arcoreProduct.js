const { chromium } = require("playwright");
const { ensureAuthenticatedSession, extractCode } = require("../extractByCodesTest");
const { normalizeProduct } = require("../normalizer/productNormalizer");
const { loadStorageState } = require("../session");

async function extractArcoreProduct(sourceSku) {
  await ensureAuthenticatedSession();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: { cookies: loadStorageState().cookies },
  });
  const page = await context.newPage();

  try {
    const extraction = await extractCode(page, sourceSku);
    if (!extraction.found) {
      const error = new Error(`No se encontro producto en Arcore para SKU ${sourceSku}.`);
      error.code =
        extraction.supplierResolution?.type === "AMBIGUOUS"
          ? "ARCORE_PRODUCT_AMBIGUOUS"
          : "ARCORE_PRODUCT_NOT_FOUND";
      error.supplierResolution = extraction.supplierResolution || {
        type: "NOT_FOUND",
        sourceCode: sourceSku,
        matchedCode: null,
        rule: null,
        candidates: [],
      };
      error.details = extraction;
      throw error;
    }

    return normalizeProduct(extraction.product.raw);
  } finally {
    await browser.close();
  }
}

module.exports = {
  extractArcoreProduct,
};
