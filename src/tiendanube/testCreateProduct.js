const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const dotenv = require("dotenv");
const { loadStorageState } = require("../session");
const {
  ensureAuthenticatedSession,
  extractCode,
  looksLikeRealImage,
} = require("../extractByCodesTest");
const { normalizeProduct } = require("../normalizer/productNormalizer");
const { createTiendanubeClient, getTiendanubeConfig } = require("./client");
const {
  createProduct,
  findProductBySku,
  findSkuMatches,
  uploadProductImage,
} = require("./products");
const { mapArcoreProductToTiendanube } = require("./mapper");

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "output");
const NORMALIZED_PRODUCTS_FILE = path.resolve(OUTPUT_DIR, "products.normalized.json");
const RESULT_FILE = path.resolve(OUTPUT_DIR, "tiendanube-test-create.json");

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function writeResult(result) {
  ensureOutputDir();
  fs.writeFileSync(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function readLocalProducts() {
  if (!fs.existsSync(NORMALIZED_PRODUCTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(NORMALIZED_PRODUCTS_FILE, "utf-8"));
}

function findLocalProductBySku(sku) {
  const target = normalizeCode(sku);
  return readLocalProducts().find((product) => {
    return [product.codigo, product.matchedCode, product.searchedCode].some(
      (value) => normalizeCode(value) === target,
    );
  });
}

async function extractProductFromArcore(sku) {
  await ensureAuthenticatedSession();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: { cookies: loadStorageState().cookies },
  });
  const page = await context.newPage();

  try {
    const result = await extractCode(page, sku);
    if (!result.found) {
      throw new Error(`No se encontro producto Arcore para SKU ${sku}.`);
    }
    return normalizeProduct(result.product.raw);
  } finally {
    await browser.close();
  }
}

async function getArcoreProductForSku(sku) {
  const localProduct = findLocalProductBySku(sku);
  if (localProduct) {
    console.log("- Fuente producto Arcore: output/products.normalized.json");
    return localProduct;
  }

  console.log("- SKU no encontrado en output/products.normalized.json.");
  console.log("- Buscando producto puntual en Arcore...");
  return extractProductFromArcore(sku);
}

function extractCreatedVariant(createdProduct, sku) {
  if (!createdProduct || !Array.isArray(createdProduct.variants)) return null;
  return (
    createdProduct.variants.find((variant) => String(variant.sku || "") === String(sku)) ||
    createdProduct.variants[0] ||
    null
  );
}

function serializeApiError(error) {
  if (!error.response) {
    return {
      message: error.message,
    };
  }

  return {
    message: error.message,
    status: error.response.status,
    statusText: error.response.statusText,
    data: error.response.data,
  };
}

async function main() {
  const searchedSku = process.argv[2] || process.env.TIENDANUBE_TEST_SKU || "";
  const timestamp = new Date().toISOString();
  const result = {
    searchedSku,
    mappedSku: null,
    existedBefore: false,
    productId: null,
    variantId: null,
    created: false,
    published: false,
    imageUploaded: false,
    imageError: null,
    errors: [],
    timestamp,
  };

  try {
    ensureOutputDir();

    if (!searchedSku.trim()) {
      throw new Error(
        "Falta SKU. Ejecuta: npm run tiendanube:test-create -- 4150768090",
      );
    }

    getTiendanubeConfig();
    const client = createTiendanubeClient();

    console.log("Buscando SKU en Tiendanube...");
    console.log(`- SKU: ${searchedSku}`);

    const existing = await findProductBySku(searchedSku, client);

    if (existing.exists) {
      result.existedBefore = true;
      result.productId = existing.productId;
      result.variantId = existing.variantId;
      result.created = false;

      console.log("- Resultado: EXISTENTE");
      console.log(`- Product ID: ${existing.productId}`);
      console.log(`- Variant ID: ${existing.variantId}`);
      console.log("\nNo se realizaron modificaciones.");
      writeResult(result);
      process.exitCode = 0;
      return;
    }

    console.log("- Resultado: NO EXISTE");

    const arcoreProduct = await getArcoreProductForSku(searchedSku);
    const mapped = mapArcoreProductToTiendanube(arcoreProduct);
    result.mappedSku = mapped.sku;

    const normalizedMatches = await findSkuMatches(mapped.sku, client);
    if (normalizedMatches.matches.length > 0) {
      result.created = false;
      result.errors.push({
        code: "CREATE_ABORTED_EXISTING_SKU",
        message:
          "Se cancelo la creacion porque ya existe al menos una publicacion equivalente por SKU normalizado.",
        normalizedSku: normalizedMatches.normalizedSku,
        matches: normalizedMatches.matches,
      });
      console.log("\nCreacion cancelada.");
      console.log("- Resultado: CREATE_ABORTED_EXISTING_SKU");
      console.log(`- normalizedSku: ${normalizedMatches.normalizedSku}`);
      console.log(`- coincidencias existentes: ${normalizedMatches.matches.length}`);
      console.log("\nNo se realizaron modificaciones.");
      writeResult(result);
      process.exitCode = 1;
      return;
    }

    if (mapped.sku !== searchedSku) {
      console.log("\nBuscando SKU mapeado en Tiendanube antes de crear...");
      console.log(`- SKU mapeado: ${mapped.sku}`);
      const mappedExisting = await findProductBySku(mapped.sku, client);

      if (mappedExisting.exists) {
        result.existedBefore = true;
        result.productId = mappedExisting.productId;
        result.variantId = mappedExisting.variantId;
        result.created = false;

        console.log("- Resultado SKU mapeado: EXISTENTE");
        console.log(`- Product ID: ${mappedExisting.productId}`);
        console.log(`- Variant ID: ${mappedExisting.variantId}`);
        console.log("\nNo se realizaron modificaciones.");
        writeResult(result);
        process.exitCode = 0;
        return;
      }

      console.log("- Resultado SKU mapeado: NO EXISTE");
    }

    const preCreateMatches = await findSkuMatches(mapped.sku, client);
    if (preCreateMatches.matches.length > 0) {
      result.created = false;
      result.errors.push({
        code: "CREATE_ABORTED_EXISTING_SKU",
        message:
          "Se cancelo la creacion en la segunda validacion previa al POST.",
        normalizedSku: preCreateMatches.normalizedSku,
        matches: preCreateMatches.matches,
      });
      console.log("\nCreacion cancelada en segunda validacion.");
      console.log("- Resultado: CREATE_ABORTED_EXISTING_SKU");
      console.log(`- normalizedSku: ${preCreateMatches.normalizedSku}`);
      console.log(`- coincidencias existentes: ${preCreateMatches.matches.length}`);
      console.log("\nNo se realizaron modificaciones.");
      writeResult(result);
      process.exitCode = 1;
      return;
    }

    console.log("\nCreando producto de prueba...");
    console.log(`- SKU: ${mapped.sku}`);
    console.log(`- Nombre: ${mapped.payload.name}`);
    console.log(`- Published: ${mapped.payload.published}`);

    const createdProduct = await createProduct(mapped.payload, client);
    const createdVariant = extractCreatedVariant(createdProduct, mapped.sku);

    result.productId = createdProduct.id || null;
    result.variantId = createdVariant?.id || null;
    result.created = true;
    result.published = createdProduct.published === true;

    console.log("- Producto creado correctamente");
    console.log(`- Product ID: ${result.productId}`);
    console.log(`- Variant ID: ${result.variantId || "no detectado"}`);
    console.log(`- SKU: ${mapped.sku}`);
    console.log(`- Published: ${result.published}`);

    if (mapped.imageUrl && looksLikeRealImage(mapped.imageUrl)) {
      try {
        await uploadProductImage(result.productId, mapped.imageUrl, client);
        result.imageUploaded = true;
        console.log("- Imagen: cargada");
      } catch (imageError) {
        result.imageUploaded = false;
        result.imageError = serializeApiError(imageError);
        console.warn("- Imagen: fallo la carga, pero el producto fue creado");
        console.warn(`- Error imagen: ${imageError.message}`);
      }
    } else {
      console.log("- Imagen: no disponible");
    }

    writeResult(result);
    process.exitCode = 0;
  } catch (error) {
    const serialized = serializeApiError(error);
    result.errors.push(serialized);
    writeResult(result);

    console.error("\nError en tiendanube:test-create:");
    console.error(`- mensaje: ${error.message}`);
    if (serialized.status) {
      console.error(`- status HTTP: ${serialized.status}`);
      console.error("- respuesta Tiendanube:");
      console.error(JSON.stringify(serialized.data, null, 2));
    }
    console.error("\nNo se imprime el access token por seguridad.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
