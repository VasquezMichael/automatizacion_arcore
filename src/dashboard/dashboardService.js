const { loadClientScope } = require("../clientScope/clientScope");
const { runClientScope } = require("../clientScope/clientScopeRunner");
const {
  DEFAULT_OUTPUT_DIR,
  loadActivity,
  loadLatestClientScopeReport,
} = require("./reportService");

class DashboardError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "DashboardError";
    this.code = code;
    this.status = status;
  }
}

function localizedName(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return value.es || value.pt || value.en || Object.values(value).find(Boolean) || null;
}

function firstPublication(item) {
  return item.plans?.price?.publications?.[0] ||
    item.plans?.image?.publications?.[0] ||
    item.tiendanube?.legacyGroup?.registeredPublications?.[0] ||
    null;
}

function productName(item) {
  return item.plans?.create?.desiredState?.name ||
    localizedName(firstPublication(item)?.name) ||
    (item.supplierResolution?.type === "NOT_FOUND" ? "Sin datos de Arcore" : "Producto sin nombre");
}

function planAction(plan, fallback = "NOT_APPLICABLE") {
  if (!plan) return fallback;
  if (plan.action) return plan.action;
  if (plan.plannedAction) return plan.plannedAction;
  return fallback;
}

function actionRequiresUpdate(item) {
  const status = planAction(item.plans?.status);
  const price = planAction(item.plans?.price);
  const image = planAction(item.plans?.image);
  return ["PUBLISH", "UNPUBLISH"].includes(status) ||
    price === "PRICE_UPDATE" ||
    ["IMAGE_REPLACE", "IMAGE_CREATE"].includes(image);
}

function deriveUiStatus(item) {
  if (item.supplierResolution?.type === "NOT_FOUND") return "NOT_FOUND";
  if (item.requiresManualReview || item.classification === "MANUAL_REVIEW") {
    return "MANUAL_REVIEW";
  }
  if (
    item.classification === "CREATE_SINGLE" &&
    item.plans?.create?.simulationResult === "WOULD_CREATE"
  ) {
    return "CREATE_REQUIRED";
  }
  if (actionRequiresUpdate(item)) return "UPDATE_REQUIRED";
  return "OK";
}

function publicationRows(item) {
  const byPair = new Map();
  const add = (publication, extras = {}) => {
    if (!publication) return;
    const key = `${publication.productId ?? "new"}:${publication.variantId ?? "new"}`;
    byPair.set(key, {
      productId: publication.productId ?? null,
      variantId: publication.variantId ?? null,
      name: localizedName(publication.name) || null,
      price: publication.currentPrice ?? publication.price ?? null,
      published: publication.published ?? null,
      imageCount: publication.tiendanubeImageCount ?? publication.imageCount ?? null,
      ...byPair.get(key),
      ...extras,
    });
  };
  for (const publication of item.tiendanube?.legacyGroup?.registeredPublications || []) add(publication);
  for (const publication of item.plans?.price?.publications || []) add(publication, {
    price: publication.currentPrice ?? null,
  });
  for (const publication of item.plans?.status?.publications || []) add(publication, {
    published: publication.published ?? null,
  });
  for (const publication of item.plans?.image?.publications || []) add(publication, {
    imageCount: publication.tiendanubeImageCount ?? null,
  });
  return [...byPair.values()];
}

function commonValue(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return null;
  return present.every((value) => value === present[0]) ? present[0] : null;
}

function mapProduct(item) {
  const publications = publicationRows(item);
  const plannedActions = {
    status: planAction(item.plans?.status),
    price: planAction(item.plans?.price),
    image: planAction(item.plans?.image),
    create: item.plans?.create?.plannedAction ||
      (item.classification === "CREATE_SINGLE" ? "BLOCKED" : "NOT_APPLICABLE"),
  };
  return {
    sourceSku: item.inputSku,
    normalizedSku: item.normalizedSku,
    name: productName(item),
    matchedCode: item.matchedCode || null,
    supplierResolution: item.supplierResolution?.type || "UNKNOWN",
    availability: item.availability || "UNKNOWN",
    supplierPrice: item.plans?.price?.calculation?.supplierPrice ?? null,
    calculatedPrice: item.plans?.price?.calculation?.calculatedPrice ?? null,
    classification: item.classification || "MANUAL_REVIEW",
    tiendanubeMatchCount: item.tiendanube?.matchCount ?? 0,
    tiendanubePrice: commonValue(publications.map((publication) => publication.price)),
    published: commonValue(publications.map((publication) => publication.published)),
    imageState: plannedActions.image,
    imageSource: item.plans?.image?.sourceImageUrl ||
      item.plans?.create?.desiredState?.primaryImage || null,
    plannedActions,
    uiStatus: deriveUiStatus(item),
    analysisStatus: item.status || "UNKNOWN",
    requiresManualReview: item.requiresManualReview === true,
    warnings: (item.warnings || []).map((warning) => ({ code: warning.code })),
    errors: (item.errors || []).map((error) => ({ code: error.code })),
    details: {
      client: {
        sourceSku: item.clientScope?.sourceSku || item.inputSku,
        normalizedSku: item.normalizedSku,
        occurrenceCount: item.clientScope?.occurrenceCount ?? 1,
      },
      arcore: {
        product: productName(item),
        matchedCode: item.matchedCode || null,
        resolution: item.supplierResolution?.type || "UNKNOWN",
        availability: item.availability || "UNKNOWN",
        supplierPrice: item.plans?.price?.calculation?.supplierPrice ?? null,
        imageSource: item.plans?.image?.sourceImageUrl ||
          item.plans?.create?.desiredState?.primaryImage || null,
      },
      tiendanube: {
        classification: item.classification || "MANUAL_REVIEW",
        matchCount: item.tiendanube?.matchCount ?? 0,
        publications,
      },
      plan: plannedActions,
    },
  };
}

function countUiStatuses(products) {
  const summary = {
    OK: 0,
    UPDATE_REQUIRED: 0,
    CREATE_REQUIRED: 0,
    MANUAL_REVIEW: 0,
    NOT_FOUND: 0,
  };
  for (const product of products) summary[product.uiStatus] += 1;
  return summary;
}

function assertReadOnlyReport(report) {
  const security = report?.security || {};
  const writeRequested = [
    security.globalWriteRequested,
    security.createWriteRequested,
    security.priceWriteRequested,
    security.statusWriteRequested,
    security.imageWriteRequested,
  ].some(Boolean);
  if (
    report?.metadata?.mode !== "READ_ONLY" ||
    report?.metadata?.writesAllowed !== false ||
    security.writeAttempted !== 0 ||
    writeRequested
  ) {
    throw new DashboardError(
      "READ_ONLY_INVARIANT_VIOLATION",
      "El análisis no confirmó el modo seguro.",
    );
  }
}

class DashboardService {
  constructor(options = {}) {
    this.outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
    this.runClientScope = options.runClientScope || runClientScope;
    this.loadScope = options.loadScope || loadClientScope;
    this.refreshPromise = null;
  }

  latestReport() {
    return loadLatestClientScopeReport(this.outputDir);
  }

  products() {
    return (this.latestReport()?.items || []).map((item) => {
      const { details, ...summary } = mapProduct(item);
      return summary;
    });
  }

  product(normalizedSku) {
    const item = (this.latestReport()?.items || [])
      .find((candidate) => candidate.normalizedSku === normalizedSku);
    return item ? mapProduct(item) : null;
  }

  dashboard() {
    const report = this.latestReport();
    const products = (report?.items || []).map(mapProduct);
    const scopeSummary = report?.scopeSummary || this.loadScope().summary;
    return {
      generatedAt: new Date().toISOString(),
      lastAnalysisAt: report?.metadata?.completedAt || null,
      hasReport: Boolean(report),
      analysisRunning: Boolean(this.refreshPromise),
      scopeSummary: {
        clientSkus: scopeSummary.uniqueSkuCount,
        resolvedInArcore: products.filter((item) =>
          ["EXACT", "SAFE_TRANSFORM"].includes(item.supplierResolution),
        ).length,
        notFound: products.filter((item) => item.supplierResolution === "NOT_FOUND").length,
        existingInTiendanube: products.filter((item) =>
          ["SINGLE", "LEGACY_GROUP"].includes(item.classification),
        ).length,
        productsToCreate: products.filter((item) => item.classification === "CREATE_SINGLE").length,
        manualReview: products.filter((item) => item.requiresManualReview).length,
      },
      availabilitySummary: {
        available: report?.availabilitySummary?.AVAILABLE || 0,
        partial: report?.availabilitySummary?.PARTIAL || 0,
        unavailable: report?.availabilitySummary?.UNAVAILABLE || 0,
        unknown: report?.availabilitySummary?.UNKNOWN || report?.availabilitySummary?.null || 0,
      },
      classificationSummary: report?.batchSummary?.classifications || {},
      actionsSummary: report?.plannedActions || {},
      uiStatusSummary: countUiStatuses(products),
      session: report
        ? {
            status: report.batchSummary?.failedCount > 0 ? "DEGRADED" : "HEALTHY",
            contexts: report.metadata?.sourceMetrics?.contextsOpened ?? null,
            reauthCount: report.metadata?.sourceMetrics?.reauthCount ?? null,
            retries: report.metadata?.sourceMetrics?.sessionRetryCount ?? null,
          }
        : { status: "NO_DATA", contexts: null, reauthCount: null, retries: null },
    };
  }

  activity() {
    return loadActivity(this.outputDir);
  }

  async refresh() {
    if (this.refreshPromise) {
      throw new DashboardError(
        "ANALYSIS_ALREADY_RUNNING",
        "Ya existe un análisis en curso.",
        409,
      );
    }
    this.refreshPromise = (async () => {
      const report = await this.runClientScope();
      assertReadOnlyReport(report);
      return report;
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
    return this.dashboard();
  }
}

module.exports = {
  DashboardError,
  DashboardService,
  assertReadOnlyReport,
  deriveUiStatus,
  mapProduct,
};
