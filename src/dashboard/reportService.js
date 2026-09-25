const fs = require("fs");
const path = require("path");

const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, "..", "..", "output");

function listJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      return {
        filePath,
        modifiedAt: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((first, second) => second.modifiedAt - first.modifiedAt);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function loadLatestClientScopeReport(outputDir = DEFAULT_OUTPUT_DIR) {
  const files = listJsonFiles(path.join(outputDir, "client-scope"));
  for (const file of files) {
    const report = readJsonSafe(file.filePath);
    if (report?.metadata?.mode === "READ_ONLY" && Array.isArray(report.items)) {
      return report;
    }
  }
  return null;
}

function countReportItems(report) {
  return report.batchSummary?.processedCount ??
    report.plan?.metadata?.allowlist?.length ??
    report.metadata?.allowlist?.length ??
    report.items?.length ??
    0;
}

function activityFromClientScope(report) {
  if (!report?.metadata || !report.scopeSummary) return null;
  return {
    id: report.metadata.runId || report.metadata.completedAt,
    date: report.metadata.completedAt || report.metadata.startedAt,
    type: "Análisis de catálogo",
    result: report.batchSummary?.failedCount > 0 ? "CON_OBSERVACIONES" : "COMPLETADO",
    processed: countReportItems(report),
    writes: 0,
    status: report.batchSummary?.failedCount > 0
      ? `${report.batchSummary.failedCount} con error`
      : `${report.batchSummary?.succeededCount ?? 0} analizados correctamente`,
  };
}

function activityFromMutableBatch(report) {
  if (!report?.metadata || !report.plan || !report.budget) return null;
  const domains = report.plan.metadata?.domains || [];
  const mode = report.metadata.mode || report.plan.metadata?.mode;
  const writes = report.budget.writesConsumed || 0;
  return {
    id: report.metadata.runId,
    date: report.metadata.completedAt || report.metadata.startedAt,
    type: mode === "PLAN"
      ? `Plan de ${domains.join(" + ") || "sincronización"}`
      : `Sincronización ${domains.join(" + ") || "controlada"}`,
    result: report.stopped ? "DETENIDO" : mode === "PLAN" ? "PLANIFICADO" : "COMPLETADO",
    processed: countReportItems(report),
    writes,
    status: report.stopped
      ? report.stopReason?.code || "Ejecución detenida"
      : writes > 0 ? `${writes} operaciones verificadas` : "Sin escrituras",
  };
}

function activityFromBatch(report) {
  if (!report?.metadata || !report.summary || !Array.isArray(report.items)) return null;
  return {
    id: report.metadata.runId,
    date: report.metadata.completedAt || report.metadata.startedAt,
    type: "Análisis por lote",
    result: report.summary.failedCount > 0 ? "CON_OBSERVACIONES" : "COMPLETADO",
    processed: report.summary.processedCount || report.items.length,
    writes: 0,
    status: `${report.summary.succeededCount || 0} procesados correctamente`,
  };
}

function loadActivity(outputDir = DEFAULT_OUTPUT_DIR, limit = 12) {
  const sources = [
    { directory: "client-scope", parse: activityFromClientScope },
    { directory: "mutable-batch", parse: activityFromMutableBatch },
    { directory: "batches", parse: activityFromBatch },
  ];
  const events = [];
  for (const source of sources) {
    for (const file of listJsonFiles(path.join(outputDir, source.directory))) {
      const report = readJsonSafe(file.filePath);
      const event = source.parse(report);
      if (event?.date) events.push(event);
    }
  }
  return events
    .sort((first, second) => new Date(second.date) - new Date(first.date))
    .slice(0, limit);
}

module.exports = {
  DEFAULT_OUTPUT_DIR,
  activityFromBatch,
  activityFromClientScope,
  activityFromMutableBatch,
  listJsonFiles,
  loadActivity,
  loadLatestClientScopeReport,
  readJsonSafe,
};
