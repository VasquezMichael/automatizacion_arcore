const fs = require("fs");
const path = require("path");

const LEGACY_GROUPS_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "config",
  "tiendanube-legacy-sku-groups.json",
);

const AUDIT_REPORT_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "output",
  "tiendanube-ambiguous-skus.json",
);

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function loadLegacySkuGroups() {
  return readJsonIfExists(LEGACY_GROUPS_FILE, {});
}

function getLegacySkuGroup(normalizedSku, groups = loadLegacySkuGroups()) {
  return groups[normalizedSku] || null;
}

function buildLegacySkuGroupsFromAudit(auditItems) {
  const groups = {};

  for (const item of auditItems) {
    const matches = Array.isArray(item.matches) ? item.matches : [];

    groups[item.normalizedSku] = {
      type: "LEGACY_GROUP",
      normalizedSku: item.normalizedSku,
      expectedMatches: matches.length,
      productIds: matches.map((match) => match.productId),
      variantIds: matches.map((match) => match.variantId),
      createdFrom: "output/tiendanube-ambiguous-skus.json",
      createdAt: new Date().toISOString(),
      note:
        "Historical duplicated SKU group. Do not add new SKUs here automatically during sync.",
    };
  }

  return groups;
}

function generateLegacySkuGroupsFromAudit() {
  const auditItems = readJsonIfExists(AUDIT_REPORT_FILE, null);
  if (!Array.isArray(auditItems)) {
    throw new Error(
      `No se encontro reporte de auditoria valido: ${AUDIT_REPORT_FILE}`,
    );
  }

  const groups = buildLegacySkuGroupsFromAudit(auditItems);
  writeJson(LEGACY_GROUPS_FILE, groups);
  return {
    filePath: LEGACY_GROUPS_FILE,
    groups,
  };
}

module.exports = {
  AUDIT_REPORT_FILE,
  LEGACY_GROUPS_FILE,
  buildLegacySkuGroupsFromAudit,
  generateLegacySkuGroupsFromAudit,
  getLegacySkuGroup,
  loadLegacySkuGroups,
};
