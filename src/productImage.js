const { chromium } = require("playwright");
const { baseUrl } = require("./config");
const { loadStorageState, storageStateExists } = require("./session");

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeImageUrl(value) {
  if (typeof value !== "string") return false;
  const src = value.trim().toLowerCase();
  if (!src) return false;
  if (src.includes("empty-image") || src.includes("placeholder")) return false;
  if (src.startsWith("data:image/")) return true;
  if (/\.(jpg|jpeg|png|webp|gif|bmp|avif)(\?|$)/.test(src)) return true;
  if (src.includes("/img/") || src.includes("/image") || src.includes("media"))
    return true;
  return false;
}

function toAbsoluteImageUrl(imageUrl) {
  if (!imageUrl) return null;
  try {
    return new URL(imageUrl, baseUrl).toString();
  } catch {
    return imageUrl;
  }
}

function pickBestImageCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const cleanCandidates = candidates
    .filter((item) => item && item.src && looksLikeImageUrl(item.src))
    .map((item) => ({
      ...item,
      src: toAbsoluteImageUrl(item.src),
      area: Number(item.area) || Number(item.width) * Number(item.height) || 0,
    }))
    .sort((a, b) => b.area - a.area);
  return cleanCandidates[0] || null;
}

function extractImageFromObject(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const keys = Object.keys(candidate);

  const directKey = keys.find((key) =>
    /(image|imagen|img|foto|thumb|thumbnail|picture)/i.test(key),
  );
  if (directKey && typeof candidate[directKey] === "string") {
    return candidate[directKey];
  }

  const nested = keys
    .filter((key) => typeof candidate[key] === "object")
    .map((key) => extractImageFromObject(candidate[key]))
    .find((value) => typeof value === "string" && value.trim() !== "");

  return nested || null;
}

function findImageInJsonByCode(payload, codigo) {
  const target = normalizeCode(codigo);
  if (!target) return null;
  const queue = [payload];
  const visited = new Set();

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;
    if (visited.has(node)) continue;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }

    const values = Object.entries(node);
    const codeMatch = values.some(([key, value]) => {
      if (!/(cod|codigo|sku|code|item)/i.test(key)) return false;
      return normalizeCode(value).includes(target);
    });

    if (codeMatch) {
      const imageValue = extractImageFromObject(node);
      if (looksLikeImageUrl(imageValue)) {
        return imageValue;
      }
    }

    for (const [, value] of values) {
      if (value && typeof value === "object") queue.push(value);
    }
  }

  return null;
}

async function extractImageFromVisibleCards(page, codigo) {
  const cardsResult = await page.evaluate((targetCode) => {
    const escaped = String(targetCode || "").replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const exactCodeRe = new RegExp(`(^|\\D)${escaped}(\\D|$)`);

    const allCards = Array.from(
      document.querySelectorAll(
        "button.MuiCardActionArea-root, .MuiCardActionArea-root, [data-product], [data-codigo], .product, .producto, article, li, tr, .card",
      ),
    );

    const matchedCards = allCards
      .filter((card) => {
        const text = (card.textContent || "").replace(/\s+/g, " ").trim();
        const attrCode =
          card.getAttribute("data-codigo") ||
          card.getAttribute("data-code") ||
          card.getAttribute("data-sku") ||
          "";
        return exactCodeRe.test(text) || String(attrCode).trim() === targetCode;
      })
      .slice(0, 10);

    function readSrcset(value) {
      if (!value) return "";
      const firstCandidate = value.split(",")[0] || "";
      return firstCandidate.trim().split(/\s+/)[0] || "";
    }

    const cardCandidates = [];
    for (const card of matchedCards) {
      const cardImages = [];
      const imgTags = Array.from(card.querySelectorAll("img"));
      for (const img of imgTags) {
        const src =
          img.getAttribute("src") ||
          img.getAttribute("data-src") ||
          img.getAttribute("data-lazy-src") ||
          img.getAttribute("data-original") ||
          readSrcset(img.getAttribute("srcset")) ||
          "";
        if (!src) continue;
        const width = img.naturalWidth || img.width || 0;
        const height = img.naturalHeight || img.height || 0;
        cardImages.push({
          src,
          width,
          height,
          area: width * height,
          source: "card-img",
        });
      }

      const bgNodes = Array.from(card.querySelectorAll("div,span,a"));
      for (const node of bgNodes) {
        const bg = window.getComputedStyle(node).backgroundImage || "";
        const match = bg.match(/url\(['"]?([^'"()]+)['"]?\)/);
        if (!match || !match[1]) continue;
        const width = node.clientWidth || 0;
        const height = node.clientHeight || 0;
        cardImages.push({
          src: match[1],
          width,
          height,
          area: width * height,
          source: "card-background",
        });
      }

      cardCandidates.push({
        cardText: (card.textContent || "").replace(/\s+/g, " ").trim(),
        images: cardImages,
      });
    }

    return cardCandidates;
  }, codigo);

  for (const candidate of cardsResult) {
    const best = pickBestImageCandidate(candidate.images || []);
    if (best) {
      return {
        ...best,
        cardText: candidate.cardText || "",
      };
    }
  }

  return null;
}

async function searchByProductCode(page, codigo) {
  const searchInput = page.locator("input.MuiInputBase-input").first();
  if ((await searchInput.count()) === 0) {
    return false;
  }

  await searchInput.fill(String(codigo || ""));
  await searchInput.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return true;
}

async function extractImageFromDetailView(page) {
  const detailResult = await page.evaluate(() => {
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
      const elements = Array.from(document.querySelectorAll(selector));
      for (const img of elements) {
        const src =
          img.getAttribute("src") ||
          img.getAttribute("data-src") ||
          img.getAttribute("data-original") ||
          "";
        if (!src) continue;
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
    return images;
  });

  return pickBestImageCandidate(detailResult);
}

async function detailPageContainsCode(page, codigo) {
  const exactCodeRe = new RegExp(`(^|\\D)${escapeRegExp(codigo)}(\\D|$)`);
  const pageText = await page.evaluate(
    () => document.body?.innerText?.replace(/\s+/g, " ").trim() || "",
  );
  return exactCodeRe.test(pageText);
}

async function tryOpenProductDetail(page, codigo) {
  const codeRegex = new RegExp(`(^|\\D)${escapeRegExp(codigo)}(\\D|$)`);
  const card = page
    .locator("button.MuiCardActionArea-root, .MuiCardActionArea-root")
    .filter({ hasText: codeRegex })
    .first();

  if ((await card.count()) === 0) return false;

  try {
    await card.scrollIntoViewIfNeeded();
    await card.click({ timeout: 5000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  } catch {
    return false;
  }
}

async function findProductImage(codigo) {
  if (!storageStateExists()) {
    throw new Error("No existe sesion guardada. Ejecuta npm run login antes.");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: { cookies: loadStorageState().cookies },
  });
  const page = await context.newPage();

  const jsonImageCandidates = [];
  const pendingResponseParsers = [];

  page.on("response", (response) => {
    const parser = (async () => {
      try {
        const headers = response.headers();
        const contentType = headers["content-type"] || "";
        if (!contentType.includes("application/json")) return;
        const payload = await response.json();
        const image = findImageInJsonByCode(payload, codigo);
        if (image && looksLikeImageUrl(image)) {
          jsonImageCandidates.push({
            src: image,
            source: `json:${response.url()}`,
            width: 0,
            height: 0,
            area: 0,
          });
        }
      } catch {
        // ignorar respuestas no parseables
      }
    })();
    pendingResponseParsers.push(parser);
  });

  try {
    const articlesUrl = `${baseUrl}/articulos`;
    console.log(`\nBuscando imagen del producto ${codigo}...`);
    await page.goto(articlesUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await searchByProductCode(page, codigo);

    const fromCards = await extractImageFromVisibleCards(page, codigo);
    if (fromCards) {
      return {
        imageUrl: fromCards.src,
        imageWidth: fromCards.width || null,
        imageHeight: fromCards.height || null,
        fuente: fromCards.source,
        observaciones:
          "Imagen encontrada en la card del producto con codigo verificado",
      };
    }

    const openedDetail = await tryOpenProductDetail(page, codigo);
    const hasCodeInDetail = openedDetail
      ? await detailPageContainsCode(page, codigo)
      : false;
    const fromDetail = hasCodeInDetail
      ? await extractImageFromDetailView(page)
      : null;
    if (fromDetail && hasCodeInDetail) {
      return {
        imageUrl: fromDetail.src,
        imageWidth: fromDetail.width || null,
        imageHeight: fromDetail.height || null,
        fuente: fromDetail.source,
        observaciones:
          "Imagen encontrada en vista detalle del producto con codigo verificado",
      };
    }

    await Promise.allSettled(pendingResponseParsers);
    const fromJson = pickBestImageCandidate(jsonImageCandidates);
    if (fromJson) {
      return {
        imageUrl: fromJson.src,
        imageWidth: null,
        imageHeight: null,
        fuente: fromJson.source,
        observaciones:
          "Imagen encontrada en respuesta JSON asociada al codigo del producto",
      };
    }

    return {
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      fuente: null,
      observaciones:
        "No se pudo extraer imagen del producto desde card, detalle ni respuestas JSON",
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  findProductImage,
};
