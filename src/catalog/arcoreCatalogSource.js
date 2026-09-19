const { chromium } = require("playwright");
const { baseUrl } = require("../config");
const { ensureAuthenticatedSession } = require("../extractByCodesTest");
const { loadStorageState } = require("../session");
const { extractArcoreProductFromPage } = require("../sync/arcoreProduct");

const DEFAULT_BACKOFF_MS = Object.freeze([1000, 2000]);
const DEFAULT_MAX_ATTEMPTS = 3;

class CatalogReadError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CatalogReadError";
    this.code = code;
    this.details = details;
    this.status = details.status ?? null;
    this.attempts = details.attempts ?? null;
    this.retries = details.retries ?? null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoginRedirect(result) {
  return (
    [301, 302, 303, 307, 308].includes(result.status) ||
    /\/auth\/login/i.test(result.url || "")
  );
}

function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

function isTransientNetworkError(error) {
  const code = String(error.code || "").toUpperCase();
  return (
    ["ECONNRESET", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(
      code,
    ) || /timeout|network|socket/i.test(error.message || "")
  );
}

function validatePayload(payload, details) {
  if (!payload || !Array.isArray(payload.data)) {
    throw new CatalogReadError(
      "CATALOG_RESPONSE_INVALID",
      "La respuesta de /api/articulos no contiene un array data valido.",
      details,
    );
  }

  const total = Number(payload.total);
  const totalPages = Number(payload.pages);
  const pageSize = Number(payload.pageSize);
  if (![total, totalPages, pageSize].every(Number.isFinite) || total < 0 || totalPages < 0 || pageSize <= 0) {
    throw new CatalogReadError(
      "CATALOG_PAGINATION_INVALID",
      "La metadata de paginacion de /api/articulos es invalida.",
      details,
    );
  }

  return {
    items: payload.data,
    total,
    totalPages,
    pageSize,
  };
}

async function createDefaultTransport() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: { cookies: loadStorageState().cookies },
  });
  const page = await context.newPage();
  return {
    page,
    async requestPage(pageNumber) {
      const response = await page.request.get(`${baseUrl}/api/articulos`, {
        params: { query: "", page: pageNumber },
        maxRedirects: 0,
      });
      const contentType = response.headers()["content-type"] || "";
      let payload = null;
      if (response.ok() && /application\/json/i.test(contentType)) {
        payload = await response.json();
      }
      return {
        status: response.status(),
        url: response.url(),
        contentType,
        payload,
      };
    },
    async close() {
      await browser.close();
    },
  };
}

class ArcoreCatalogSource {
  constructor(options = {}) {
    this.ensureSession = options.ensureSession || ensureAuthenticatedSession;
    this.transportFactory = options.transportFactory || createDefaultTransport;
    this.requestPageOverride = options.requestPage || null;
    this.extractProductOverride = options.extractProduct || null;
    this.reauthenticateOverride = options.reauthenticate || null;
    this.sleepFn = options.sleepFn || sleep;
    this.backoffMs = options.backoffMs || DEFAULT_BACKOFF_MS;
    this.maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
    this.transport = null;
    this.opened = false;
    this.metrics = {
      requestCount: 0,
      reauthCount: 0,
      contextsOpened: 0,
      healthChecks: 0,
    };
  }

  async open() {
    if (this.opened) return;
    if (this.requestPageOverride) {
      this.opened = true;
      return;
    }
    await this.ensureSession();
    this.transport = await this.transportFactory();
    this.metrics.contextsOpened += 1;
    this.opened = true;
  }

  async close() {
    if (this.transport?.close) await this.transport.close();
    this.transport = null;
    this.opened = false;
  }

  async reauthenticate() {
    this.metrics.reauthCount += 1;
    if (this.reauthenticateOverride) {
      await this.reauthenticateOverride();
      return;
    }
    await this.close();
    await this.ensureSession();
    this.transport = await this.transportFactory();
    this.metrics.contextsOpened += 1;
    this.opened = true;
  }

  async requestPage(pageNumber) {
    await this.open();
    this.metrics.requestCount += 1;
    if (this.requestPageOverride) return this.requestPageOverride(pageNumber);
    return this.transport.requestPage(pageNumber);
  }

  async readPage(pageNumber, options = {}) {
    const maxAttempts = options.maxAttempts || this.maxAttempts;
    let reauthenticated = false;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.requestPage(pageNumber);
        const details = {
          page: pageNumber,
          status: response.status,
          url: response.url,
          contentType: response.contentType,
          attempts: attempt,
          retries: attempt - 1,
        };

        if (response.status === 401 || isLoginRedirect(response)) {
          if (!reauthenticated) {
            reauthenticated = true;
            try {
              await this.reauthenticate();
            } catch (error) {
              throw new CatalogReadError(
                "ARCORE_REAUTH_FAILED",
                "La sesion Arcore expiro y la reautenticacion fallo.",
                { ...details, causeCode: error.code || "ERROR" },
              );
            }
            continue;
          }
          throw new CatalogReadError(
            "ARCORE_SESSION_EXPIRED",
            "La sesion Arcore sigue expirada despues de reautenticar.",
            details,
          );
        }

        if (response.status < 200 || response.status >= 300) {
          if (isTransientStatus(response.status) && attempt < maxAttempts) {
            await this.sleepFn(this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)]);
            continue;
          }
          throw new CatalogReadError(
            isTransientStatus(response.status)
              ? "CATALOG_PAGE_RETRIES_EXHAUSTED"
              : "CATALOG_PAGE_HTTP_ERROR",
            `GET /api/articulos fallo con status HTTP ${response.status}.`,
            details,
          );
        }

        if (!/application\/json/i.test(response.contentType || "")) {
          throw new CatalogReadError(
            "CATALOG_CONTENT_TYPE_INVALID",
            "GET /api/articulos no devolvio JSON.",
            details,
          );
        }

        return {
          page: pageNumber,
          ...validatePayload(response.payload, details),
          httpStatus: response.status,
          contentType: response.contentType,
          attempts: attempt,
          retries: attempt - 1,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        if (error instanceof CatalogReadError) throw error;
        lastError = error;
        if (!isTransientNetworkError(error) || attempt >= maxAttempts) break;
        await this.sleepFn(this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)]);
      }
    }

    throw new CatalogReadError(
      "CATALOG_PAGE_RETRIES_EXHAUSTED",
      "No se pudo leer la pagina de catalogo despues de los reintentos permitidos.",
      {
        page: pageNumber,
        attempts: maxAttempts,
        retries: Math.max(maxAttempts - 1, 0),
        causeCode: lastError?.code || "NETWORK_ERROR",
      },
    );
  }

  async healthCheck() {
    this.metrics.healthChecks += 1;
    const page = await this.readPage(0);
    return {
      status: "VALID",
      checkedAt: new Date().toISOString(),
      httpStatus: page.httpStatus,
      total: page.total,
      totalPages: page.totalPages,
      pageSize: page.pageSize,
      attempts: page.attempts,
      retries: page.retries,
    };
  }

  async extractProduct(sourceSku) {
    await this.open();
    if (this.extractProductOverride) return this.extractProductOverride(sourceSku);
    return extractArcoreProductFromPage(this.transport.page, sourceSku);
  }
}

module.exports = {
  ArcoreCatalogSource,
  CatalogReadError,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  createDefaultTransport,
  isTransientNetworkError,
  isTransientStatus,
  validatePayload,
};
