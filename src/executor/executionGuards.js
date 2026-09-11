const { normalizeSku } = require("../tiendanube/sku");

const AUTOMATIC_RESOLUTIONS = new Set(["EXACT", "SAFE_TRANSFORM"]);
const SUPPORTED_CLASSIFICATIONS = new Set([
  "CREATE_SINGLE",
  "LEGACY_GROUP",
  "MANUAL_REVIEW",
  "SINGLE",
]);
const BLOCKING_PRICE_ACTIONS = new Set([
  "INVALID_SUPPLIER_PRICE",
  "MANUAL_REVIEW",
  "PRICE_CALCULATION_FAILED",
  "PRICE_WRITE_BLOCKED",
]);
const BLOCKING_IMAGE_ACTIONS = new Set([
  "ERROR",
  "IMAGE_DOWNLOAD_FAILED",
  "MANUAL_REVIEW",
]);
const PRICE_ERROR_CODES = new Set([
  "INVALID_CALCULATED_PRICE",
  "INVALID_SUPPLIER_PRICE",
  "PRICE_CALCULATION_FAILED",
  "PRICE_WRITE_BLOCKED",
  "ZERO_SUPPLIER_PRICE",
]);
const IMAGE_ERROR_CODES = new Set([
  "ARCORE_IMAGE_HOST_NOT_ALLOWED",
  "ERROR",
  "IMAGE_DOWNLOAD_FAILED",
  "INVALID_IMAGE_CONTENT_TYPE",
  "INVALID_IMAGE_DATA",
  "INVALID_IMAGE_URL",
]);

function issue(code, message, details) {
  return {
    code,
    message,
    ...(details ? { details } : {}),
  };
}

function parseSupplierPrice(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readExecutionGates(env = process.env) {
  const dryRun = String(env.TIENDANUBE_DRY_RUN || "true").trim().toLowerCase() !== "false";
  const executionEnabled =
    String(env.TIENDANUBE_EXECUTION_ENABLED || "false").trim().toLowerCase() === "true";
  const priceExecutionEnabled =
    String(env.TIENDANUBE_PRICE_EXECUTION_ENABLED || "false").trim().toLowerCase() === "true";
  const statusExecutionEnabled =
    String(env.TIENDANUBE_STATUS_EXECUTION_ENABLED || "false").trim().toLowerCase() === "true";
  const globalWriteRequested = !dryRun && executionEnabled;
  const priceWriteRequested = globalWriteRequested && priceExecutionEnabled;
  const statusWriteRequested = globalWriteRequested && statusExecutionEnabled;
  const anyDomainWriteRequested = priceWriteRequested || statusWriteRequested;

  return {
    dryRun,
    effectiveDryRun: !anyDomainWriteRequested,
    executionEnabled,
    priceExecutionEnabled,
    statusExecutionEnabled,
    globalWriteRequested,
    priceWriteRequested,
    statusWriteRequested,
    writeOperationsAvailable: anyDomainWriteRequested,
    // Alias de compatibilidad; las rutas mutables usan los gates por dominio.
    writeModeRequested: globalWriteRequested,
  };
}

function collectPlanActions(plan) {
  const planGroups = [plan?.plans?.status, plan?.plans?.price, plan?.plans?.image].filter(
    Boolean,
  );
  return planGroups.flatMap((group) => [
    group.action,
    ...(group.publications || []).map((publication) => publication.action),
  ]);
}

function emptyDomainBlocks() {
  return { status: [], price: [], image: [] };
}

function addDomainBlock(domainBlocks, domain, code, message, details) {
  const block = issue(code, message, details);
  const duplicate = domainBlocks[domain].some(
    (item) => item.code === block.code && item.message === block.message,
  );
  if (!duplicate) domainBlocks[domain].push(block);
}

function collectDomainBlocks(plan) {
  const domainBlocks = emptyDomainBlocks();
  const actions = collectPlanActions(plan);

  if (actions.includes("STATUS_UNKNOWN")) {
    addDomainBlock(
      domainBlocks,
      "status",
      "STATUS_UNKNOWN",
      "La disponibilidad UNKNOWN impide ejecutar la accion STATUS.",
    );
  }

  const blockingPriceAction = actions.find((action) => BLOCKING_PRICE_ACTIONS.has(action));
  if (blockingPriceAction) {
    addDomainBlock(
      domainBlocks,
      "price",
      blockingPriceAction,
      `El plan de precio no es ejecutable: ${blockingPriceAction}.`,
    );
  }

  const blockingImageAction = actions.find((action) => BLOCKING_IMAGE_ACTIONS.has(action));
  if (blockingImageAction) {
    addDomainBlock(
      domainBlocks,
      "image",
      blockingImageAction,
      `El plan de imagen no es ejecutable: ${blockingImageAction}.`,
    );
  }

  const supplierPrice = parseSupplierPrice(plan?.supplier?.supplierPrice);
  const calculatedPrice = Number(plan?.plans?.price?.calculation?.calculatedPrice);
  const priceUpdateRequested = actions.includes("PRICE_UPDATE");
  if (priceUpdateRequested && (supplierPrice === null || supplierPrice < 0)) {
    addDomainBlock(
      domainBlocks,
      "price",
      "INVALID_SUPPLIER_PRICE",
      "PRICE_UPDATE requiere un precio proveedor valido y mayor que cero.",
    );
  }
  if (supplierPrice === 0) {
    addDomainBlock(
      domainBlocks,
      "price",
      "ZERO_SUPPLIER_PRICE",
      "El precio proveedor cero requiere revision manual.",
    );
  }
  if (
    priceUpdateRequested &&
    (!Number.isFinite(calculatedPrice) ||
      calculatedPrice <= 0 ||
      !Number.isInteger(calculatedPrice))
  ) {
    addDomainBlock(
      domainBlocks,
      "price",
      "INVALID_CALCULATED_PRICE",
      "PRICE_UPDATE requiere un precio final entero, valido y mayor que cero.",
    );
  }

  for (const error of plan?.errors || []) {
    if (PRICE_ERROR_CODES.has(error.code)) {
      addDomainBlock(domainBlocks, "price", error.code, error.message || error.code);
    } else if (IMAGE_ERROR_CODES.has(error.code) && plan.plans?.image?.action !== "MANUAL_REVIEW") {
      addDomainBlock(domainBlocks, "image", error.code, error.message || error.code);
    }
  }

  return domainBlocks;
}

function flattenDomainBlocks(domainBlocks) {
  return Object.entries(domainBlocks).flatMap(([domain, blocks]) =>
    blocks.map((block) => ({ ...block, domain })),
  );
}

function mergeDomainBlocks(...groups) {
  const merged = emptyDomainBlocks();
  for (const group of groups) {
    for (const domain of Object.keys(merged)) {
      for (const block of group?.[domain] || []) {
        addDomainBlock(
          merged,
          domain,
          block.code,
          block.message,
          block.details,
        );
      }
    }
  }
  return merged;
}

function validateExecutionPlan(plan) {
  const issues = [];

  if (!plan || typeof plan !== "object") {
    return {
      ok: false,
      issues: [issue("INVALID_SYNC_PLAN", "El orquestador no devolvio un plan valido.")],
      domainBlocks: emptyDomainBlocks(),
    };
  }

  if (!normalizeSku(plan.sourceSku)) {
    issues.push(issue("INVALID_SOURCE_SKU", "El plan no contiene un SKU valido."));
  }

  if (!SUPPORTED_CLASSIFICATIONS.has(plan.classification)) {
    issues.push(
      issue(
        "UNSUPPORTED_CLASSIFICATION",
        `Clasificacion no soportada: ${plan.classification || "VACIA"}.`,
      ),
    );
  }

  if (plan.classification === "MANUAL_REVIEW") {
    issues.push(issue("MANUAL_REVIEW", "El plan requiere revision manual."));
  }

  if (!AUTOMATIC_RESOLUTIONS.has(plan.supplierResolution?.type)) {
    issues.push(
      issue(
        "SUPPLIER_RESOLUTION_BLOCKED",
        `Resolucion Arcore no automatizable: ${plan.supplierResolution?.type || "AUSENTE"}.`,
      ),
    );
  }

  if (
    plan.classification === "LEGACY_GROUP" &&
    plan.tiendanube?.legacyGroup?.valid !== true
  ) {
    issues.push(
      issue(
        "INVALID_LEGACY_GROUP",
        "El LEGACY_GROUP no supero la validacion historica del planificador.",
        plan.tiendanube?.legacyGroup?.issues || [],
      ),
    );
  }

  const domainBlocks = collectDomainBlocks(plan);
  const supplierPrice = parseSupplierPrice(plan.supplier?.supplierPrice);
  const localErrorCodes = new Set(
    flattenDomainBlocks(domainBlocks).map((block) => block.code),
  );
  const criticalErrors = (plan.errors || []).filter(
    (error) => !localErrorCodes.has(error.code),
  );
  if (criticalErrors.length > 0) {
    issues.push(
      issue(
        "CRITICAL_PLAN_ERRORS",
        "El plan contiene errores globales de identidad o integridad.",
        criticalErrors.map((error) => ({ code: error.code, message: error.message })),
      ),
    );
  }

  if (plan.classification === "CREATE_SINGLE") {
    const calculatedPrice = Number(plan.plans?.price?.calculation?.calculatedPrice);
    if (supplierPrice === null || supplierPrice <= 0) {
      issues.push(
        issue(
          "INVALID_SUPPLIER_PRICE",
          "CREATE_SINGLE requiere precio proveedor valido y mayor que cero.",
        ),
      );
    }
    if (!Number.isFinite(calculatedPrice) || calculatedPrice <= 0) {
      issues.push(
        issue(
          "INVALID_CALCULATED_PRICE",
          "CREATE_SINGLE requiere precio calculado valido y mayor que cero.",
        ),
      );
    }
    if (plan.supplier?.availability === "UNKNOWN") {
      issues.push(
        issue(
          "UNKNOWN_AVAILABILITY",
          "CREATE_SINGLE no puede crearse con disponibilidad UNKNOWN.",
        ),
      );
    }
    if (typeof plan.plans?.status?.desiredPublished !== "boolean") {
      issues.push(
        issue(
          "INVALID_CREATION_STATUS",
          "CREATE_SINGLE requiere un valor published calculado.",
        ),
      );
    }
    for (const block of [...domainBlocks.status, ...domainBlocks.price]) {
      issues.push(
        issue(
          block.code,
          `CREATE_SINGLE queda bloqueado completamente: ${block.message}`,
          block.details,
        ),
      );
    }
  }

  const uniqueIssues = Array.from(
    new Map(issues.map((item) => [`${item.code}:${item.message}`, item])).values(),
  );
  return {
    ok: uniqueIssues.length === 0,
    issues: uniqueIssues,
    domainBlocks,
  };
}

module.exports = {
  AUTOMATIC_RESOLUTIONS,
  collectDomainBlocks,
  flattenDomainBlocks,
  mergeDomainBlocks,
  readExecutionGates,
  validateExecutionPlan,
};
