const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { baseUrl, testSupermedida } = require("./config");
const { login } = require("./login");
const { loadStorageState, storageStateExists } = require("./session");
const { queryStock } = require("./stockClient");
const { normalizeProduct } = require("./normalizer/productNormalizer");

const INPUT_FILE = path.resolve(__dirname, "..", "input", "test-codes.json");
const OUTPUT_DIR = path.resolve(__dirname, "..", "output");
const FOUND_OUTPUT_FILE = path.resolve(OUTPUT_DIR, "products.by-code.test.json");
const NOT_FOUND_OUTPUT_FILE = path.resolve(OUTPUT_DIR, "codes-not-found.test.json");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readCodes() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`No existe el archivo de entrada: ${INPUT_FILE}`);
  }

  const parsed = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"));
  const codes = Array.isArray(parsed) ? parsed : parsed.codes;

  if (!Array.isArray(codes)) {
    throw new Error(
      "Formato invalido en input/test-codes.json. Usa un array JSON o { \"codes\": [...] }.",
    );
  }

  return codes
    .map((code) => String(code || "").trim())
    .filter(Boolean);
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function looksLikeRealImage(value) {
  const src = String(value || "").toLowerCase();
  if (!src) return false;
  if (src.includes("empty-image") || src.includes("placeholder")) return false;
  return (
    src.startsWith("data:image/") ||
    /\.(jpg|jpeg|png|webp|gif|bmp|avif)(\?|$)/.test(src) ||
    src.includes("/img/") ||
    src.includes("/image") ||
    src.includes("media")
  );
}

async function hasUsableSession() {
  if (!storageStateExists()) return false;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: { cookies: loadStorageState().cookies },
  });
  const page = await context.newPage();

  try {
    await page.goto(`${baseUrl}/articulos`, { waitUntil: "networkidle" });
    return (await page.locator('input[name="email"]').count()) === 0;
  } catch {
    return false;
  } finally {
    await browser.close();
  }
}

async function ensureAuthenticatedSession() {
  if (await hasUsableSession()) {
    console.log("Sesion autenticada vigente. Reutilizando storageState.json.");
    return;
  }

  console.log("No existe sesion vigente. Ejecutando login automatico...");
  await login();

  if (!(await hasUsableSession())) {
    throw new Error("No se pudo iniciar sesion automaticamente.");
  }
}

async function findSearchInput(page) {
  const selectors = [
    "input.MuiInputBase-input",
    'input[type="search"]',
    'input[placeholder*="Buscar"]',
    'input[placeholder*="buscar"]',
    'input[name*="search"]',
    'input[name*="Search"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      return locator;
    }
  }

  return null;
}

async function searchCode(page, code) {
  const searchInput = await findSearchInput(page);

  if (!searchInput) {
    return {
      searched: false,
      observation:
        "No se encontro selector de buscador. Ajustar findSearchInput en src/extractByCodesTest.js.",
    };
  }

  await searchInput.fill("");
  await searchInput.fill(code);
  await searchInput.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);

  return {
    searched: true,
    observation: "Busqueda ejecutada desde el buscador del portal.",
  };
}

async function extractMatchingCard(page, requestedCode) {
  return page.evaluate(
    ({ requestedCode, normalizedRequestedCode }) => {
      function cleanText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function normalizeCode(value) {
        return String(value || "")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "");
      }

      function firstMatch(text, regex) {
        const match = text.match(regex);
        return match ? cleanText(match[1] || match[0]) : "";
      }

      function readSrcset(value) {
        if (!value) return "";
        const firstCandidate = value.split(",")[0] || "";
        return firstCandidate.trim().split(/\s+/)[0] || "";
      }

      function looksLikeRealImage(value) {
        const src = String(value || "").toLowerCase();
        if (!src) return false;
        if (src.includes("empty-image") || src.includes("placeholder")) return false;
        return (
          src.startsWith("data:image/") ||
          /\.(jpg|jpeg|png|webp|gif|bmp|avif)(\?|$)/.test(src) ||
          src.includes("/img/") ||
          src.includes("/image") ||
          src.includes("media")
        );
      }

      function extractCard(card, index) {
        const rawText = cleanText(card.textContent);
        const codigo = firstMatch(
          rawText,
          /C[oó]digo:\s*([A-Za-z0-9 ._-]+?)(?=Marca:|Precio|$)/i,
        );
        const marca = firstMatch(rawText, /Marca:\s*(.+?)(?=Precio|$)/i);
        const nombre = cleanText(rawText.split(/C[oó]digo:/i)[0]);
        const precio = firstMatch(rawText, /Su precio\s*\$\s*([0-9.,]+)/i);
        const disponibilidadTexto =
          firstMatch(
            rawText,
            /(No disponible|Disponible c\/espera|Disponible|Alternativas)/i,
          ) || "";

        const images = [];
        for (const img of Array.from(card.querySelectorAll("img"))) {
          const src =
            img.getAttribute("src") ||
            img.getAttribute("data-src") ||
            img.getAttribute("data-lazy-src") ||
            img.getAttribute("data-original") ||
            readSrcset(img.getAttribute("srcset")) ||
            "";
          if (!looksLikeRealImage(src)) continue;
          const width = img.naturalWidth || img.width || 0;
          const height = img.naturalHeight || img.height || 0;
          images.push({
            src,
            width,
            height,
            area: width * height,
            source: "card-img",
          });
        }

        for (const node of Array.from(card.querySelectorAll("div,span,a"))) {
          const bg = window.getComputedStyle(node).backgroundImage || "";
          const match = bg.match(/url\(['"]?([^'"()]+)['"]?\)/);
          if (!match || !looksLikeRealImage(match[1])) continue;
          const width = node.clientWidth || 0;
          const height = node.clientHeight || 0;
          images.push({
            src: match[1],
            width,
            height,
            area: width * height,
            source: "card-background",
          });
        }

        images.sort((a, b) => b.area - a.area);

        return {
          cardIndex: index,
          codigo,
          marcaId: marca,
          marca,
          nombre,
          precio,
          disponibilidadTexto,
          rawText,
          image: images[0] || null,
          exactMatch: normalizeCode(codigo) === normalizedRequestedCode,
          containsRequestedCode: normalizeCode(rawText).includes(normalizedRequestedCode),
        };
      }

      const cards = Array.from(
        document.querySelectorAll(
          "button.MuiCardActionArea-root, .MuiCardActionArea-root, .MuiCard-root, [data-product], [data-codigo], .product, .producto, article, tr",
        ),
      ).map(extractCard);

      const exact = cards.find((card) => card.exactMatch);
      if (exact) {
        return {
          found: true,
          exactMatch: true,
          card: exact,
          totalCandidates: cards.length,
        };
      }

      const partial = cards.find((card) => card.containsRequestedCode);
      if (partial) {
        return {
          found: true,
          exactMatch: false,
          card: partial,
          matchType: "closestCandidate",
          totalCandidates: cards.length,
          observation:
            "No se encontro coincidencia exacta. Se utilizo el candidato mas cercano.",
        };
      }

      return {
        found: false,
        exactMatch: false,
        matchType: null,
        totalCandidates: cards.length,
        observation: `No se encontro coincidencia exacta para ${requestedCode}.`,
      };
    },
    { requestedCode, normalizedRequestedCode: normalizeCode(requestedCode) },
  );
}

async function tryOpenDetailAndExtractImage(page, code) {
  const exactCode = normalizeCode(code);
  const opened = await page.evaluate((exactCode) => {
    function normalizeCode(value) {
      return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "");
    }

    const cards = Array.from(
      document.querySelectorAll("button.MuiCardActionArea-root, .MuiCardActionArea-root"),
    );
    const card = cards.find((element) => normalizeCode(element.textContent).includes(exactCode));
    if (!card) return false;
    card.scrollIntoView({ block: "center" });
    card.click();
    return true;
  }, exactCode);

  if (!opened) return null;

  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);

  return page.evaluate(() => {
    const selectors = [
      "img.iiz__zoom-img",
      "img.iiz__img",
      ".iiz img",
      ".product-detail img",
      ".producto-detalle img",
      ".detalle-articulo img",
      "main img",
    ];

    const images = [];
    for (const selector of selectors) {
      for (const img of Array.from(document.querySelectorAll(selector))) {
        const src =
          img.getAttribute("src") ||
          img.getAttribute("data-src") ||
          img.getAttribute("data-original") ||
          "";
        const lowerSrc = src.toLowerCase();
        if (!src || lowerSrc.includes("empty-image") || lowerSrc.includes("placeholder")) {
          continue;
        }
        const width = img.naturalWidth || img.width || 0;
        const height = img.naturalHeight || img.height || 0;
        images.push({
          src,
          width,
          height,
          area: width * height,
          source: selector,
        });
      }
    }

    images.sort((a, b) => b.area - a.area);
    return images[0] || null;
  });
}

async function queryStockIfPossible(rawProduct) {
  if (!rawProduct.codigo || !rawProduct.marcaId) {
    return {
      stock: null,
      stockError: "No se consulto stock: falta codigo o marcaId/marca.",
    };
  }

  try {
    return {
      stock: await queryStock({
        codigo: rawProduct.codigo,
        marcaId: rawProduct.marcaId,
        supermedida: testSupermedida || "",
      }),
      stockError: null,
    };
  } catch (error) {
    return {
      stock: null,
      stockError: error.message,
    };
  }
}

function buildRawProductFromCard(card, image, observation) {
  return {
    cardIndex: card.cardIndex,
    codigo: card.codigo,
    marcaId: card.marcaId,
    marca: card.marca,
    nombre: card.nombre,
    precio: card.precio,
    disponibilidadTexto: card.disponibilidadTexto,
    imageUrl: image?.src || null,
    imageWidth: image?.width || null,
    imageHeight: image?.height || null,
    imageFuente: image?.source || null,
    observaciones: observation,
    rawText: card.rawText,
  };
}

async function extractCode(page, code) {
  console.log(`\n[${code}] Abriendo listado de articulos...`);
  await page.goto(`${baseUrl}/articulos`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  console.log(`[${code}] Buscando codigo en el portal...`);
  const searchResult = await searchCode(page, code);
  if (!searchResult.searched) {
    return {
      found: false,
      code,
      observation: searchResult.observation,
    };
  }

  let match = await extractMatchingCard(page, code);
  if (!match.found && /\s/.test(code)) {
    const compactCode = code.replace(/\s+/g, "");
    console.log(
      `[${code}] Sin coincidencia exacta. Reintentando busqueda como ${compactCode}...`,
    );
    await searchCode(page, compactCode);
    match = await extractMatchingCard(page, code);
  }

  if (!match.found) {
    console.log(`[${code}] No encontrado: ${match.observation}`);
    return {
      found: false,
      code,
      observation: match.observation,
      totalCandidates: match.totalCandidates,
      closestCandidate: match.closestCandidate || null,
    };
  }

  const matchType = match.exactMatch ? "exact" : "closestCandidate";
  const matchedCode = match.card.codigo || "";
  const matchObservation = match.exactMatch
    ? "Coincidencia exacta encontrada."
    : "No se encontro coincidencia exacta. Se utilizo el candidato mas cercano.";

  if (match.exactMatch) {
    console.log(`[${code}] Coincidencia exacta encontrada: ${matchedCode}.`);
  } else {
    console.log(
      `[${code}] Sin coincidencia exacta. Usando candidato mas cercano: ${matchedCode}.`,
    );
  }

  let image = match.card.image;
  let imageObservation = image
    ? `Imagen encontrada en la card del producto (${matchType}).`
    : "No se encontro imagen valida en card; se intentara detalle.";

  if (!image) {
    const detailImage = await tryOpenDetailAndExtractImage(page, matchedCode || code);
    if (detailImage) {
      image = detailImage;
      imageObservation = "Imagen encontrada en la vista detalle del producto.";
    } else {
      imageObservation = "No se encontro imagen valida en card ni detalle.";
    }
  }

  const rawProduct = buildRawProductFromCard(match.card, image, imageObservation);
  rawProduct.searchedCode = code;
  rawProduct.matchedCode = matchedCode;
  rawProduct.matchType = matchType;
  rawProduct.matchObservation = matchObservation;
  const { stock, stockError } = await queryStockIfPossible(rawProduct);
  rawProduct.stock = stock;
  if (stockError) rawProduct.stockError = stockError;

  const normalized = normalizeProduct(rawProduct);

  return {
    found: true,
    product: {
      searchedCode: code,
      matchedCode,
      matchType,
      observacion: matchObservation,
      codigo: normalized.codigo,
      marcaId: normalized.marcaId,
      marca: normalized.marca,
      nombre: normalized.nombre,
      descripcion: normalized.descripcionStock || normalized.nombre,
      descripcionAlternativa: normalized.descripcionAlternativa,
      color: normalized.color,
      estadoDisponibilidad: normalized.estadoDisponibilidad,
      imageUrl: normalized.imageUrl,
      imageSource: normalized.imageSource,
      imageWidth: normalized.imageWidth,
      imageHeight: normalized.imageHeight,
      observacionesImagen: normalized.observacionesImagen,
      raw: normalized.raw,
    },
  };
}

async function main() {
  const foundProducts = [];
  const notFoundCodes = [];
  const errors = [];

  try {
    const codes = readCodes();
    ensureDir(OUTPUT_DIR);

    console.log(`Codigos a procesar: ${codes.length}`);
    await ensureAuthenticatedSession();

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: { cookies: loadStorageState().cookies },
    });
    const page = await context.newPage();

    try {
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        console.log(`\n=== Codigo ${i + 1}/${codes.length}: ${code} ===`);

        try {
          const result = await extractCode(page, code);
          if (result.found) {
            foundProducts.push(result.product);
          } else {
            notFoundCodes.push({
              codigo: code,
              observacion: result.observation,
              totalCandidates: result.totalCandidates || 0,
              closestCandidate: result.closestCandidate || null,
            });
          }
        } catch (error) {
          console.error(`[${code}] Error: ${error.message}`);
          errors.push({
            codigo: code,
            error: error.message,
          });
        }
      }
    } finally {
      await browser.close();
    }

    fs.writeFileSync(
      FOUND_OUTPUT_FILE,
      `${JSON.stringify(foundProducts, null, 2)}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      NOT_FOUND_OUTPUT_FILE,
      `${JSON.stringify(notFoundCodes, null, 2)}\n`,
      "utf-8",
    );

    const withValidImage = foundProducts.filter((product) =>
      looksLikeRealImage(product.imageUrl),
    ).length;
    const productsWithPartialErrors = foundProducts.filter(
      (product) => product.raw?.stockError || product.raw?.imageError,
    ).length;
    const totalErrors = errors.length + productsWithPartialErrors;

    console.log("\n=== RESUMEN TEST POR CODIGOS ===");
    console.log(`- total de codigos procesados: ${codes.length}`);
    console.log(`- encontrados: ${foundProducts.length}`);
    console.log(`- no encontrados: ${notFoundCodes.length}`);
    console.log(`- con imagen valida: ${withValidImage}`);
    console.log(`- con errores: ${totalErrors}`);
    console.log("\nArchivos generados:");
    console.log(`- ${FOUND_OUTPUT_FILE}`);
    console.log(`- ${NOT_FOUND_OUTPUT_FILE}`);

    if (errors.length > 0) {
      console.log("\nErrores por codigo:");
      for (const error of errors) {
        console.log(`- ${error.codigo}: ${error.error}`);
      }
    }

    process.exitCode = errors.length > 0 ? 1 : 0;
  } catch (error) {
    console.error("Error ejecutando prueba por codigos:", error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractCode,
  main,
};
