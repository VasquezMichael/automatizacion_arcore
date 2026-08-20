const fs = require("fs");
const path = require("path");
const { createTiendanubeClient, getTiendanubeConfig } = require("./client");
const { normalizeSku } = require("./sku");

const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "output");
const JSON_OUTPUT = path.resolve(OUTPUT_DIR, "tiendanube-ambiguous-skus.json");
const CSV_OUTPUT = path.resolve(OUTPUT_DIR, "tiendanube-ambiguous-skus.csv");
const PAGE_SIZE = 200;

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function pickLocalizedValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  return value.es || value.pt || value.en || Object.values(value).find(Boolean) || "";
}

function isPublished(product) {
  if (typeof product.published === "boolean") return product.published;
  return product.visibility === "visible";
}

function assertSuccess(response, label) {
  if (response.status >= 200 && response.status < 300) return;

  const error = new Error(`${label} fallo con status HTTP ${response.status}`);
  error.response = response;
  throw error;
}

async function fetchAllProducts(client) {
  const products = [];
  let page = 1;

  while (true) {
    console.log(`Leyendo pagina ${page} de productos...`);
    const response = await client.listProducts({
      page,
      perPage: PAGE_SIZE,
    });
    assertSuccess(response, `GET /products?page=${page}`);

    const pageProducts = Array.isArray(response.data) ? response.data : [];
    products.push(...pageProducts);

    if (pageProducts.length < PAGE_SIZE) break;
    page += 1;
  }

  return products;
}

function collectSkuMatches(products) {
  const grouped = new Map();
  let totalVariants = 0;
  let variantsWithoutSku = 0;

  for (const product of products) {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const productName = pickLocalizedValue(product.name);
    const published = isPublished(product);

    for (const variant of variants) {
      totalVariants += 1;

      const sku = String(variant.sku || "").trim();
      if (!sku) {
        variantsWithoutSku += 1;
        continue;
      }

      const normalizedSku = normalizeSku(sku);
      if (!normalizedSku) {
        variantsWithoutSku += 1;
        continue;
      }

      if (!grouped.has(normalizedSku)) {
        grouped.set(normalizedSku, []);
      }

      grouped.get(normalizedSku).push({
        sku,
        productId: product.id,
        variantId: variant.id,
        name: productName,
        published,
        visibility: product.visibility || "",
        price: variant.price || null,
        stock: variant.stock ?? null,
        stockManagement: variant.stock_management ?? null,
      });
    }
  }

  const ambiguousSkus = Array.from(grouped.entries())
    .filter(([, matches]) => matches.length > 1)
    .map(([normalizedSku, matches]) => ({
      normalizedSku,
      matchCount: matches.length,
      matches,
    }))
    .sort((a, b) => b.matchCount - a.matchCount || a.normalizedSku.localeCompare(b.normalizedSku));

  return {
    ambiguousSkus,
    grouped,
    totalVariants,
    variantsWithoutSku,
  };
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function buildCsv(ambiguousSkus) {
  const headers = [
    "normalizedSku",
    "matchCount",
    "sku",
    "productId",
    "variantId",
    "name",
    "published",
    "visibility",
    "price",
    "stock",
    "stockManagement",
  ];

  const rows = [headers.map(csvEscape).join(",")];

  for (const item of ambiguousSkus) {
    for (const match of item.matches) {
      rows.push(
        [
          item.normalizedSku,
          item.matchCount,
          match.sku,
          match.productId,
          match.variantId,
          match.name,
          match.published,
          match.visibility,
          match.price,
          match.stock,
          match.stockManagement,
        ]
          .map(csvEscape)
          .join(","),
      );
    }
  }

  return `${rows.join("\n")}\n`;
}

function writeReports(report) {
  ensureOutputDir();
  fs.writeFileSync(JSON_OUTPUT, `${JSON.stringify(report.ambiguousSkus, null, 2)}\n`, "utf-8");
  fs.writeFileSync(CSV_OUTPUT, buildCsv(report.ambiguousSkus), "utf-8");
}

function printApiError(error) {
  if (!error.response) {
    console.error(`- mensaje: ${error.message}`);
    return;
  }

  console.error(`- status HTTP: ${error.response.status}`);
  console.error("- respuesta Tiendanube:");
  console.error(JSON.stringify(error.response.data, null, 2));
}

async function main() {
  try {
    getTiendanubeConfig();
    const client = createTiendanubeClient();

    console.log("Auditando SKUs de Tiendanube...\n");
    const products = await fetchAllProducts(client);
    const report = collectSkuMatches(products);
    const variantsInAmbiguities = report.ambiguousSkus.reduce(
      (total, item) => total + item.matchCount,
      0,
    );

    writeReports(report);

    console.log("\n=== RESUMEN AUDITORIA SKU ===");
    console.log(`- total de productos revisados: ${products.length}`);
    console.log(`- total de variantes revisadas: ${report.totalVariants}`);
    console.log(`- total de SKU unicos: ${report.grouped.size}`);
    console.log(`- total de SKU ambiguos: ${report.ambiguousSkus.length}`);
    console.log(
      `- total de variantes involucradas en ambiguedades: ${variantsInAmbiguities}`,
    );
    console.log(`- variantes sin SKU: ${report.variantsWithoutSku}`);
    console.log("\nArchivos generados:");
    console.log(`- ${JSON_OUTPUT}`);
    console.log(`- ${CSV_OUTPUT}`);

    process.exitCode = 0;
  } catch (error) {
    console.error("\nError auditando SKUs de Tiendanube:");
    printApiError(error);
    console.error("\nNo se imprime el access token por seguridad.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  collectSkuMatches,
  main,
};
