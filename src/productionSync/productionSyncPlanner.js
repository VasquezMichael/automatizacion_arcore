// CREATE materializa recursos nuevos; los dominios de existentes se ejecutan
// despues y IMAGE queda ultimo porque cada reemplazo puede consumir dos writes.
const DOMAIN_ORDER = Object.freeze(["CREATE", "PRICE", "STATUS", "IMAGE"]);

const DEFAULT_BATCH_CONFIG = Object.freeze({
  single: 15,
  create: 10,
  image: 8,
});

const AUTOMATIC_RESOLUTIONS = new Set(["EXACT", "SAFE_TRANSFORM"]);
const AUTOMATIC_IMAGE_SOURCE_TYPES = new Set([
  "COVER_FULL",
  "COVER_THUMBNAIL_FALLBACK",
]);

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${name} debe ser un entero mayor que cero.`);
    error.code = "PRODUCTION_SYNC_CONFIG_INVALID";
    throw error;
  }
  return parsed;
}

function readBatchConfig(env = process.env, overrides = {}) {
  return {
    single: positiveInteger(
      overrides.single ?? env.PRODUCTION_SYNC_BATCH_SIZE_SINGLE,
      DEFAULT_BATCH_CONFIG.single,
      "PRODUCTION_SYNC_BATCH_SIZE_SINGLE",
    ),
    create: positiveInteger(
      overrides.create ?? env.PRODUCTION_SYNC_BATCH_SIZE_CREATE,
      DEFAULT_BATCH_CONFIG.create,
      "PRODUCTION_SYNC_BATCH_SIZE_CREATE",
    ),
    image: positiveInteger(
      overrides.image ?? env.PRODUCTION_SYNC_BATCH_SIZE_IMAGE,
      DEFAULT_BATCH_CONFIG.image,
      "PRODUCTION_SYNC_BATCH_SIZE_IMAGE",
    ),
  };
}

function issueCodes(item) {
  return [...(item.warnings || []), ...(item.errors || [])]
    .map((entry) => entry?.code)
    .filter(Boolean);
}

function exclusionFor(item) {
  const resolution = item.supplierResolution?.type || null;
  if (resolution === "NOT_FOUND") return "NOT_FOUND";
  if (resolution === "AMBIGUOUS" || item.classification === "MANUAL_REVIEW") {
    return "MANUAL_REVIEW";
  }
  if (!AUTOMATIC_RESOLUTIONS.has(resolution)) return "TECHNICAL_BLOCKED";
  if (item.availability === "UNKNOWN") return "UNKNOWN";
  if (
    item.classification === "LEGACY_GROUP" &&
    item.tiendanube?.legacyGroup?.valid !== true
  ) {
    return "MANUAL_REVIEW";
  }
  if (!["SINGLE", "CREATE_SINGLE", "LEGACY_GROUP"].includes(item.classification)) {
    return "TECHNICAL_BLOCKED";
  }
  if (
    item.status === "FAILED" ||
    item.status === "BLOCKED" ||
    item.result?.revalidationStatus !== "PASSED" ||
    (item.errors || []).length > 0
  ) {
    return "TECHNICAL_BLOCKED";
  }
  return null;
}

function publicationWriteCount(plan, writableActions) {
  const publications = Array.isArray(plan?.publications) ? plan.publications : [];
  if (publications.length > 0) {
    return publications.filter((publication) => writableActions.has(publication.action)).length;
  }
  return writableActions.has(plan?.action) ? 1 : 0;
}

function expectedWrites(item, domain) {
  if (domain === "CREATE") {
    return item.classification === "CREATE_SINGLE" &&
      item.plans?.create?.plannedAction === "CREATE_SINGLE" &&
      item.plans?.create?.simulationResult === "WOULD_CREATE"
      ? 1
      : 0;
  }
  if (item.classification === "CREATE_SINGLE") return 0;
  if (domain === "PRICE") {
    return publicationWriteCount(item.plans?.price, new Set(["PRICE_UPDATE"]));
  }
  if (domain === "STATUS") {
    return publicationWriteCount(item.plans?.status, new Set(["PUBLISH", "UNPUBLISH"]));
  }
  if (domain === "IMAGE") {
    if (!AUTOMATIC_IMAGE_SOURCE_TYPES.has(item.supplier?.imageSourceType)) return 0;
    return publicationWriteCount(item.plans?.image, new Set(["IMAGE_REPLACE"])) * 2;
  }
  return 0;
}

function automationClass(item) {
  if (item.classification === "SINGLE") return "AUTO_SINGLE";
  if (item.classification === "CREATE_SINGLE") return "AUTO_CREATE";
  if (item.classification === "LEGACY_GROUP") return "AUTO_LEGACY";
  return null;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function buildSubBatch(domain, kind, entries, index) {
  return {
    id: `${String(index).padStart(3, "0")}_${domain}_${kind}`,
    domain,
    kind,
    skus: entries.map((entry) => entry.inputSku),
    normalizedSkus: entries.map((entry) => entry.normalizedSku),
    expectedWrites: entries.reduce((total, entry) => total + entry.expectedWrites, 0),
    analysisExpectedWrites: entries.reduce(
      (total, entry) => total + entry.expectedWrites,
      0,
    ),
    consumedWrites: 0,
    remainingWrites: entries.reduce(
      (total, entry) => total + entry.expectedWrites,
      0,
    ),
    state: "PLANNED",
  };
}

function buildSafeProductionPlan(analysis, options = {}) {
  const batchConfig = readBatchConfig(options.env, options.batchConfig);
  const items = analysis.items || [];
  const classifications = {};
  const resolutions = {};
  const exclusions = {
    manualReview: [],
    notFound: [],
    unknown: [],
    technicalBlocked: [],
  };
  const domainExclusions = { PRICE: [], STATUS: [], IMAGE: [], CREATE: [] };
  const safeItems = [];

  for (const item of items) {
    const classification = item.classification || "UNCLASSIFIED";
    const resolution = item.supplierResolution?.type || "UNRESOLVED";
    classifications[classification] = (classifications[classification] || 0) + 1;
    resolutions[resolution] = (resolutions[resolution] || 0) + 1;
    const exclusion = exclusionFor(item);
    if (exclusion) {
      const record = {
        inputSku: item.inputSku,
        normalizedSku: item.normalizedSku,
        supplierResolution: resolution,
        classification,
        reason: exclusion,
        codes: issueCodes(item),
      };
      if (exclusion === "MANUAL_REVIEW") exclusions.manualReview.push(record);
      else if (exclusion === "NOT_FOUND") exclusions.notFound.push(record);
      else if (exclusion === "UNKNOWN") exclusions.unknown.push(record);
      else exclusions.technicalBlocked.push(record);
      continue;
    }

    const actions = Object.fromEntries(
      DOMAIN_ORDER.map((domain) => [domain, expectedWrites(item, domain)]),
    );
    const rawImageWrites = publicationWriteCount(
      item.plans?.image,
      new Set(["IMAGE_REPLACE"]),
    ) * 2;
    if (rawImageWrites > 0 && actions.IMAGE === 0) {
      domainExclusions.IMAGE.push({
        inputSku: item.inputSku,
        normalizedSku: item.normalizedSku,
        code: "IMAGE_SOURCE_TYPE_NOT_APPROVED",
        imageSourceType: item.supplier?.imageSourceType || null,
      });
    }
    safeItems.push({
      inputSku: item.inputSku,
      normalizedSku: item.normalizedSku,
      classification: item.classification,
      automationClass: automationClass(item),
      actions,
      warnings: issueCodes(item),
    });
  }

  const subBatches = [];
  let batchIndex = 1;
  for (const domain of DOMAIN_ORDER) {
    const entries = safeItems
      .map((item) => ({ ...item, expectedWrites: item.actions[domain] }))
      .filter((item) => item.expectedWrites > 0);
    const legacy = entries.filter((item) => item.classification === "LEGACY_GROUP");
    const regular = entries.filter((item) => item.classification !== "LEGACY_GROUP");
    const size = domain === "CREATE"
      ? batchConfig.create
      : domain === "IMAGE" ? batchConfig.image : batchConfig.single;

    for (const group of chunk(regular, size)) {
      subBatches.push(buildSubBatch(domain, "STANDARD", group, batchIndex));
      batchIndex += 1;
    }
    for (const entry of legacy) {
      subBatches.push(buildSubBatch(domain, "LEGACY", [entry], batchIndex));
      batchIndex += 1;
    }
  }

  const autoExecutable = safeItems.filter((item) =>
    Object.values(item.actions).some((count) => count > 0),
  );
  return {
    domainOrder: [...DOMAIN_ORDER],
    batchConfig,
    classifications,
    resolutions,
    resolved: items.filter((item) =>
      AUTOMATIC_RESOLUTIONS.has(item.supplierResolution?.type),
    ).length,
    safeItems,
    alreadySynced: safeItems.length - autoExecutable.length,
    autoExecutable: autoExecutable.length,
    exclusions,
    domainExclusions,
    subBatches,
    plannedWrites: subBatches.reduce(
      (total, subBatch) => total + subBatch.expectedWrites,
      0,
    ),
  };
}

module.exports = {
  AUTOMATIC_RESOLUTIONS,
  AUTOMATIC_IMAGE_SOURCE_TYPES,
  DEFAULT_BATCH_CONFIG,
  DOMAIN_ORDER,
  buildSafeProductionPlan,
  exclusionFor,
  expectedWrites,
  readBatchConfig,
};
