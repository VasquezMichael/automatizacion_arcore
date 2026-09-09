const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { baseUrl, testSupermedida } = require("./config");
const { login } = require("./login");
const { loadStorageState, storageStateExists } = require("./session");
const { queryStockDetailed } = require("./stockClient");
const { normalizeProduct } = require("./normalizer/productNormalizer");
const {
  SupplierResolutionType,
  isAutomaticSupplierResolution,
  resolveArcoreCode,
} = require("./extractor/arcoreCodeResolver");

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

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractSupplierPriceFromText(rawText) {
  const text = cleanText(rawText);
  const suPrecio = text.match(/Su precio\s*\$\s*([0-9.,]+)/i);
  if (suPrecio) {
    return {
      precio: cleanText(suPrecio[1]),
      priceSourceLabel: "SU_PRECIO",
    };
  }

  const precioMostrador = text.match(/Precio Mostrador\s*\$\s*([0-9.,]+)/i);
  if (precioMostrador) {
    return {
      precio: cleanText(precioMostrador[1]),
      priceSourceLabel: "PRECIO_MOSTRADOR",
    };
  }

  return {
    precio: null,
    priceSourceLabel: null,
  };
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

async function fetchArticleMetadata(page, searchedCode) {
  const endpoint = `${baseUrl}/api/articulos`;
  async function fetchPage(pageNumber) {
    const response = await page.request.get(endpoint, {
      params: {
        query: searchedCode,
        page: pageNumber,
      },
    });
    return {
      ok: response.ok(),
      status: response.status(),
      url: response.url(),
      payload: response.ok() ? await response.json() : null,
    };
  }

  const firstPage = await fetchPage(0);
  if (!firstPage.ok) {
    return {
      article: null,
      resolution: null,
      diagnostics: {
        url: firstPage.url,
        httpStatus: firstPage.status,
        error: `GET /api/articulos fallo con status HTTP ${firstPage.status}.`,
      },
    };
  }

  const totalPages = Math.max(Number(firstPage.payload?.pages) || 1, 1);
  const remainingPages = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) => fetchPage(index + 1)),
  );
  const pageResults = [firstPage, ...remainingPages];
  const failedPage = pageResults.find((result) => !result.ok);
  if (failedPage) {
    return {
      article: null,
      resolution: null,
      diagnostics: {
        url: failedPage.url,
        httpStatus: failedPage.status,
        pages: totalPages,
        error: `GET /api/articulos fallo con status HTTP ${failedPage.status}.`,
      },
    };
  }

  const articles = pageResults.flatMap((result) =>
    Array.isArray(result.payload?.data) ? result.payload.data : [],
  );
  const resolution = resolveArcoreCode(searchedCode, articles);
  const article = isAutomaticSupplierResolution(resolution)
    ? articles[resolution.matchedCandidateIndex] || null
    : null;

  return {
    article,
    resolution,
    diagnostics: {
      url: firstPage.url,
      httpStatus: firstPage.status,
      pages: totalPages,
      candidates: articles.length,
      candidateCodes: articles.map((candidate) => candidate.codComercial).filter(Boolean),
      error: article ? null : `Resolucion Arcore: ${resolution.type}.`,
    },
  };
}

async function extractMatchingCard(page, requestedCode) {
  const cards = await page.evaluate(
    () => {
      function cleanText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
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
          precio: null,
          priceSourceLabel: null,
          disponibilidadTexto,
          rawText,
          image: images[0] || null,
        };
      }

      const cards = Array.from(
        document.querySelectorAll(
          "button.MuiCardActionArea-root, .MuiCardActionArea-root, .MuiCard-root, [data-product], [data-codigo], .product, .producto, article, tr",
        ),
      ).map(extractCard);

      return cards;
    },
  );

  const resolution = resolveArcoreCode(requestedCode, cards);
  if (!isAutomaticSupplierResolution(resolution)) {
    return {
      found: false,
      resolution,
      totalCandidates: cards.length,
      observation: `Resolucion Arcore desde DOM: ${resolution.type}.`,
    };
  }

  const card = cards.find(
    (candidate) => normalizeCode(candidate.codigo) === normalizeCode(resolution.matchedCode),
  );
  return {
    found: Boolean(card),
    resolution,
    card: card || null,
    totalCandidates: cards.length,
    observation: card
      ? `Resolucion Arcore desde DOM: ${resolution.type}.`
      : "El codigo fue resuelto, pero no se encontro su tarjeta exacta.",
  };
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
  const stockCodigo = rawProduct.stockCodigo || rawProduct.codigo;
  const marcaId = rawProduct.marcaId;
  const supermedida = rawProduct.supermedida ?? testSupermedida ?? "";

  if (!stockCodigo || !marcaId) {
    return {
      stock: null,
      stockError: "No se consulto stock: falta codigo o marcaId/marca.",
      stockDiagnostics: {
        codigo: stockCodigo || null,
        marcaId: marcaId || null,
        supermedida,
        httpStatus: null,
        response: null,
      },
    };
  }

  try {
    const result = await queryStockDetailed({
      codigo: stockCodigo,
      marcaId,
      supermedida,
    });
    return {
      stock: result.data,
      stockError: null,
      stockDiagnostics: result.diagnostics,
    };
  } catch (error) {
    return {
      stock: null,
      stockError: error.message,
      stockDiagnostics:
        error.diagnostics || {
          codigo: stockCodigo,
          marcaId,
          supermedida,
          httpStatus: error.response?.status || null,
          response: error.response?.data || null,
        },
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
    priceSourceLabel: card.priceSourceLabel || null,
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

  const articleLookup = await fetchArticleMetadata(page, code);
  let supplierResolution = articleLookup.resolution;

  if (supplierResolution && !isAutomaticSupplierResolution(supplierResolution)) {
    console.log(`[${code}] Resolucion bloqueada: ${supplierResolution.type}.`);
    return {
      found: false,
      code,
      observation: `Resolucion Arcore estructurada: ${supplierResolution.type}.`,
      totalCandidates: articleLookup.diagnostics.candidates || 0,
      supplierResolution,
    };
  }

  let match;
  if (isAutomaticSupplierResolution(supplierResolution)) {
    match = await extractMatchingCard(page, supplierResolution.matchedCode);
    if (!match.found) {
      await searchCode(page, supplierResolution.matchedCode);
      match = await extractMatchingCard(page, supplierResolution.matchedCode);
    }
  } else {
    match = await extractMatchingCard(page, code);
    supplierResolution = match.resolution;
  }

  if (!match.found || !isAutomaticSupplierResolution(supplierResolution)) {
    const resolution = supplierResolution || {
      type: SupplierResolutionType.NOT_FOUND,
      sourceCode: normalizeCode(code),
      matchedCode: null,
      rule: null,
      candidates: [],
    };
    console.log(`[${code}] Resolucion bloqueada: ${resolution.type}.`);
    return {
      found: false,
      code,
      observation: match.observation,
      totalCandidates: match.totalCandidates,
      supplierResolution: resolution,
    };
  }

  const matchType = supplierResolution.type;
  const matchedCode = supplierResolution.matchedCode;
  const supplierPrice = extractSupplierPriceFromText(match.card.rawText);
  match.card.precio = supplierPrice.precio;
  match.card.priceSourceLabel = supplierPrice.priceSourceLabel;
  const matchObservation =
    supplierResolution.type === SupplierResolutionType.EXACT
      ? "Coincidencia exacta encontrada."
      : "Transformacion segura aplicada: se agrego un unico cero final.";

  if (supplierResolution.type === SupplierResolutionType.EXACT) {
    console.log(`[${code}] Coincidencia exacta encontrada: ${matchedCode}.`);
  } else {
    console.log(
      `[${code}] SAFE_TRANSFORM APPEND_TRAILING_ZERO: ${matchedCode}.`,
    );
  }
  console.log(
    `[${code}] Precio proveedor detectado desde: ${
      supplierPrice.priceSourceLabel || "NO_ENCONTRADO"
    }.`,
  );

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
  rawProduct.supplierResolution = {
    type: supplierResolution.type,
    sourceCode: supplierResolution.sourceCode,
    matchedCode: supplierResolution.matchedCode,
    rule: supplierResolution.rule,
    candidates: supplierResolution.candidates,
  };
  rawProduct.articleLookup = articleLookup.diagnostics;
  if (articleLookup.article) {
    rawProduct.articleId = articleLookup.article.id || null;
    rawProduct.stockCodigo = articleLookup.article.codigo || null;
    rawProduct.codComercial = articleLookup.article.codComercial || matchedCode;
    rawProduct.marcaId = articleLookup.article.marcaId || rawProduct.marcaId;
    rawProduct.marca = articleLookup.article.marca || rawProduct.marca;
    rawProduct.supermedida = articleLookup.article.supermedida ?? null;
    rawProduct.articleMetadata = articleLookup.article;
  }

  const { stock, stockError, stockDiagnostics } =
    await queryStockIfPossible(rawProduct);
  rawProduct.stock = stock;
  rawProduct.stockDiagnostics = stockDiagnostics;
  if (stockError) rawProduct.stockError = stockError;

  const normalized = normalizeProduct(rawProduct);

  return {
    found: true,
    product: {
      searchedCode: code,
      matchedCode,
      matchType,
      supplierResolution: rawProduct.supplierResolution,
      observacion: matchObservation,
      codigo: normalized.codigo,
      marcaId: normalized.marcaId,
      marca: normalized.marca,
      nombre: normalized.nombre,
      precio: normalized.precio,
      priceSourceLabel: normalized.priceSourceLabel,
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
              supplierResolution: result.supplierResolution || null,
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
  ensureAuthenticatedSession,
  extractCode,
  extractSupplierPriceFromText,
  fetchArticleMetadata,
  looksLikeRealImage,
  main,
  readCodes,
};
