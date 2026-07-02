const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { chromium } = require("playwright");
const { baseUrl } = require("./config");
const { loadStorageState, storageStateExists } = require("./session");

const RESULTS_DIR = path.resolve(__dirname, "..", "results");

async function ensureResultsDir() {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

async function extractProductImages() {
  if (!storageStateExists()) {
    throw new Error("No existe sesión guardada. Ejecuta npm run login antes.");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: { cookies: loadStorageState().cookies },
  });
  const page = await context.newPage();

  try {
    // Navegar a la ruta de artículos
    const articlesUrl = `${baseUrl}/articulos`;
    console.log(`Navegando a: ${articlesUrl}`);
    await page.goto(articlesUrl, { waitUntil: "networkidle" });

    console.log("Esperando que carguen los productos...");
    await page.waitForTimeout(3000);

    // Extracción contextual: buscar cards de producto
    const products = await page.evaluate(() => {
      const results = [];
      let cardCount = 0;

      // Estrategia 1: Buscar elementos con clases comunes de "card" o "product"
      const possibleSelectors = [
        ".product",
        ".card",
        "[data-product]",
        "article",
        ".item-product",
        ".producto",
        ".articulo",
      ];

      let cards = [];
      for (const selector of possibleSelectors) {
        cards = document.querySelectorAll(selector);
        if (cards.length > 0) {
          console.log(
            `[DEBUG] Detectadas ${cards.length} cards usando selector: ${selector}`,
          );
          break;
        }
      }

      // Si no encontró cards, buscar divs que contengan múltiples imágenes + texto
      if (cards.length === 0) {
        cards = Array.from(document.querySelectorAll("div"))
          .filter((div) => {
            const images = div.querySelectorAll("img");
            const text = div.textContent || "";
            return (
              images.length > 0 &&
              text.length > 10 &&
              div.children.length > 1 &&
              div.children.length < 20
            );
          })
          .slice(0, 100); // Limitar a máximo 100 divs
      }

      cardCount = cards.length;
      console.log(
        `[DEBUG] Total de cards de producto detectadas: ${cardCount}`,
      );

      cards.forEach((card, cardIndex) => {
        try {
          // Extraer código del producto
          let codigo = "";
          const codePatterns = [
            ".codigo",
            "[data-codigo]",
            ".code",
            ".product-code",
            ".sku",
          ];
          for (const pattern of codePatterns) {
            const codeEl = card.querySelector(pattern);
            if (codeEl) {
              codigo = codeEl.textContent?.trim() || "";
              if (codigo) break;
            }
          }

          // Si no encuentra con selectores, buscar números largos en el texto
          if (!codigo) {
            const textContent = card.textContent || "";
            const codeMatch = textContent.match(/\b\d{5,}\b/);
            if (codeMatch) codigo = codeMatch[0];
          }

          // Extraer nombre del producto
          let nombre = "";
          const namePatterns = [
            ".nombre",
            ".name",
            ".title",
            ".product-name",
            "h2",
            "h3",
            "h4",
            "[data-name]",
          ];
          for (const pattern of namePatterns) {
            const nameEl = card.querySelector(pattern);
            if (nameEl) {
              nombre = nameEl.textContent?.trim() || "";
              if (nombre && nombre.length > 5) break;
            }
          }

          // Extraer imágenes dentro de la card
          const cardImages = Array.from(card.querySelectorAll("img")).map(
            (img) => {
              const src = img.src || img.getAttribute("data-src") || "";
              const width = img.naturalWidth || img.width || 0;
              const height = img.naturalHeight || img.height || 0;
              const alt = img.alt || "";
              const area = width * height;

              return {
                src,
                width,
                height,
                area,
                alt,
                source: "img-tag",
              };
            },
          );

          // También buscar background-image
          const bgImages = [];
          Array.from(card.querySelectorAll("div, span, a")).forEach((el) => {
            const bgImg = window.getComputedStyle(el).backgroundImage;
            if (bgImg && bgImg.includes("url")) {
              const match = bgImg.match(/url\(['"]?([^'"()]+)['"]?\)/);
              if (match && match[1]) {
                bgImages.push({
                  src: match[1],
                  width: el.offsetWidth || 0,
                  height: el.offsetHeight || 0,
                  area: (el.offsetWidth || 0) * (el.offsetHeight || 0),
                  alt: "background-image",
                  source: "background-image",
                });
              }
            }
          });

          const allImages = [...cardImages, ...bgImages];

          // Filtrar imágenes no relevantes
          const filteredImages = allImages.filter((img) => {
            if (!img.src) return false;

            // Descartar imágenes muy pequeñas
            if (img.area < 5000) return false; // Menos de 70x70 aprox

            // Descartar URLs que parecen assets del sitio
            const src = img.src.toLowerCase();
            const blacklist = [
              "logo",
              "icon",
              "favicon",
              "arrow",
              "chevron",
              "menu",
              "burger",
              "spinner",
              "loader",
              "placeholder",
              "default",
              "svg",
              "/images/",
            ];
            if (blacklist.some((term) => src.includes(term))) return false;

            return true;
          });

          console.log(
            `[DEBUG] Card ${cardIndex}: código="${codigo}", nombre="${nombre}", imágenes detectadas=${cardImages.length}, después filtro=${filteredImages.length}`,
          );

          // Priorizar la imagen más grande
          if (filteredImages.length > 0) {
            filteredImages.sort((a, b) => b.area - a.area);
            const mainImage = filteredImages[0];

            results.push({
              cardIndex,
              codigo,
              nombre,
              imageUrl: mainImage.src,
              imageWidth: mainImage.width,
              imageHeight: mainImage.height,
              imageArea: mainImage.area,
              imageFuente: mainImage.source,
              imageAlt: mainImage.alt,
              observaciones:
                filteredImages.length > 1
                  ? `Múltiples imágenes (${filteredImages.length}), se eligió la mayor`
                  : "Imagen única dentro de la card",
            });
          } else if (codigo || nombre) {
            // Registrar productos sin imagen válida
            results.push({
              cardIndex,
              codigo,
              nombre,
              imageUrl: null,
              imageWidth: null,
              imageHeight: null,
              imageArea: null,
              imageFuente: null,
              imageAlt: null,
              observaciones: "No se encontró imagen válida en esta card",
            });
          }
        } catch (err) {
          console.log(
            `[DEBUG] Error procesando card ${cardIndex}: ${err.message}`,
          );
        }
      });

      return results;
    });

    console.log(
      `\nExtraccción completada: ${products.filter((p) => p.imageUrl).length} productos con imagen`,
    );
    return products;
  } finally {
    await browser.close();
  }
}

async function probeImage(imageUrl, withAuth = false) {
  const result = {
    url: imageUrl,
    statusCode: null,
    contentType: null,
    contentLength: null,
    accessible: false,
    requiresAuth: null,
    error: null,
  };

  try {
    const isAbsolute =
      imageUrl.startsWith("http://") || imageUrl.startsWith("https://");
    const fullUrl = isAbsolute ? imageUrl : `${baseUrl}${imageUrl}`;

    const config = {
      timeout: 10000,
      validateStatus: () => true,
    };

    if (withAuth && storageStateExists()) {
      const storageState = loadStorageState();
      if (storageState.cookies) {
        const cookiePairs = storageState.cookies
          .filter((cookie) => cookie.name && cookie.value)
          .map((cookie) => `${cookie.name}=${cookie.value}`);
        config.headers = {
          Cookie: cookiePairs.join("; "),
        };
      }
    }

    // Intentar con HEAD primero (más rápido)
    let response;
    try {
      response = await axios.head(fullUrl, config);
    } catch (headError) {
      // Si HEAD falla, intentar con GET
      response = await axios.get(fullUrl, {
        ...config,
        responseType: "arraybuffer",
      });
    }

    result.statusCode = response.status;
    result.contentType = response.headers["content-type"] || null;
    result.contentLength = response.headers["content-length"]
      ? parseInt(response.headers["content-length"], 10)
      : null;
    result.accessible = response.status >= 200 && response.status < 300;

    if (!result.accessible && withAuth) {
      result.requiresAuth = response.status === 403 || response.status === 401;
    }
  } catch (error) {
    result.error = error.message;
  }

  return result;
}

async function probeAllImages(products) {
  const results = [];

  for (let i = 0; i < products.length; i++) {
    const product = products[i];

    // Saltar productos sin imagen
    if (!product.imageUrl) {
      results.push(product);
      continue;
    }

    console.log(
      `[${i + 1}/${products.length}] Probando imagen de: ${product.codigo} (${product.nombre})`,
    );

    const withoutAuth = await probeImage(product.imageUrl, false);
    const withAuth = await probeImage(product.imageUrl, true);

    const record = {
      ...product,
      probedWithoutAuth: withoutAuth,
      probedWithAuth: withAuth,
      requiresSessionAuth:
        withoutAuth.statusCode !== 200 && withAuth.statusCode === 200,
      accessible: withAuth.accessible,
    };

    results.push(record);
  }

  return results;
}

function saveToJSON(results, filename) {
  const filepath = path.resolve(RESULTS_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`Resultados JSON guardados: ${filepath}`);
  return filepath;
}

function saveToCSV(results, filename) {
  const filepath = path.resolve(RESULTS_DIR, filename);

  const headers = [
    "cardIndex",
    "codigo",
    "nombre",
    "imageUrl",
    "imageWidth",
    "imageHeight",
    "imageFuente",
    "status_without_auth",
    "status_with_auth",
    "content_type",
    "content_length",
    "accessible_without_auth",
    "accessible_with_auth",
    "requires_session_auth",
    "observaciones",
  ];

  const rows = results.map((r) => [
    r.cardIndex || "",
    r.codigo || "",
    r.nombre || "",
    r.imageUrl || "",
    r.imageWidth || "",
    r.imageHeight || "",
    r.imageFuente || "",
    r.probedWithoutAuth?.statusCode || "",
    r.probedWithAuth?.statusCode || "",
    r.probedWithAuth?.contentType || "",
    r.probedWithAuth?.contentLength || "",
    r.probedWithoutAuth?.accessible ? "yes" : "no",
    r.probedWithAuth?.accessible ? "yes" : "no",
    r.requiresSessionAuth ? "yes" : "no",
    r.observaciones || "",
  ]);

  const csvContent = [
    headers.join(","),
    ...rows.map((row) =>
      row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","),
    ),
  ].join("\n");

  fs.writeFileSync(filepath, csvContent, "utf-8");
  console.log(`Resultados CSV guardados: ${filepath}`);
  return filepath;
}

module.exports = {
  ensureResultsDir,
  extractProductImages,
  probeImage,
  probeAllImages,
  saveToJSON,
  saveToCSV,
};
