const fs = require("fs");
const path = require("path");
const { persistJsonAtomic } = require("../mutableBatch/mutableBatchOutput");

function defaultRunProductionSync(...args) {
  const { runProductionSync } = require("../productionSync/productionSyncRunner");
  return runProductionSync(...args);
}

function emptyMetadata() {
  return {
    lastRunAt: null,
    lastRunId: null,
    lastMode: null,
    lastResult: null,
    lastDuration: null,
    lastError: null,
    nextRunAt: null,
  };
}

function sanitizeError(error) {
  return {
    code: error?.code || "SCHEDULED_SYNC_FAILED",
    message: "La sincronizacion programada no pudo completarse.",
  };
}

class ProductionScheduler {
  constructor(options) {
    this.config = options.config;
    this.dataDir = options.dataDir;
    this.env = options.env || process.env;
    this.logger = options.logger;
    this.runSync = options.runSync || defaultRunProductionSync;
    this.now = options.now || (() => new Date());
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.metadataFile = options.metadataFile || path.join(this.dataDir, "scheduler", "metadata.json");
    this.timer = null;
    this.activeRun = null;
    this.started = false;
    this.stopping = false;
    this.metadataError = null;
    this.metadata = this.loadMetadata();
  }

  loadMetadata() {
    if (!fs.existsSync(this.metadataFile)) return emptyMetadata();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metadataFile, "utf8"));
      return { ...emptyMetadata(), ...parsed };
    } catch (_error) {
      this.metadataError = {
        code: "SCHEDULER_METADATA_INVALID",
        message: "La metadata persistida del scheduler no es valida.",
      };
      return emptyMetadata();
    }
  }

  persistMetadata() {
    persistJsonAtomic(this.metadataFile, this.metadata);
  }

  readiness() {
    return this.metadataError
      ? { ready: false, error: this.metadataError }
      : { ready: true };
  }

  state() {
    if (this.stopping) return "STOPPING";
    if (this.activeRun) return "RUNNING";
    if (!this.config.enabled) return "DISABLED";
    if (this.config.blocked) return "BLOCKED";
    return this.started ? "IDLE" : "STARTING";
  }

  status() {
    return {
      enabled: this.config.enabled,
      mode: this.config.mode,
      intervalMinutes: this.config.intervalMinutes,
      state: this.state(),
      blockedReasons: this.config.blockedReasons || [],
      activeRunId: null,
      metadata: { ...this.metadata },
    };
  }

  start() {
    if (this.started) return this.status();
    this.started = true;
    if (!this.config.enabled) {
      this.logger.info("scheduler.disabled", "Scheduler deshabilitado por configuracion.");
      return this.status();
    }
    if (this.config.blocked) {
      this.metadata.nextRunAt = null;
      this.metadata.lastResult = "BLOCKED";
      this.metadata.lastError = this.config.blockedReasons[0] || null;
      this.persistMetadata();
      this.logger.warn("scheduler.blocked", "Scheduler bloqueado por configuracion segura.", {
        reasons: this.config.blockedReasons.map((item) => item.code),
      });
      return this.status();
    }
    this.scheduleNext();
    return this.status();
  }

  scheduleNext() {
    if (!this.started || this.stopping || !this.config.enabled || this.config.blocked) return;
    const delayMs = this.config.intervalMinutes * 60 * 1000;
    this.metadata.nextRunAt = new Date(this.now().getTime() + delayMs).toISOString();
    this.persistMetadata();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.runNow().finally(() => this.scheduleNext());
    }, delayMs);
    this.timer?.unref?.();
  }

  async runNow() {
    if (!this.started || !this.config.enabled) return { status: "SKIPPED_DISABLED" };
    if (this.config.blocked) return { status: "BLOCKED", reasons: this.config.blockedReasons };
    if (this.activeRun) {
      this.logger.warn("scheduler.overlap_skipped", "Se omitio un run porque existe otro activo.");
      return { status: "SKIPPED_OVERLAP" };
    }
    if (this.stopping) return { status: "SKIPPED_SHUTDOWN" };

    const startedAt = this.now();
    this.metadata.nextRunAt = null;
    this.logger.info("scheduler.run_started", "Inicio de sincronizacion programada.", {
      mode: this.config.mode,
    });
    this.activeRun = (async () => {
      try {
        const report = await this.runSync({
          mode: this.config.mode,
          dataDir: this.dataDir,
          confirmRealWrites: this.config.mode === "EXECUTE" && this.config.executionConfirmed,
        }, { env: this.env });
        this.metadata = {
          ...this.metadata,
          lastRunAt: startedAt.toISOString(),
          lastRunId: report.runId || null,
          lastMode: this.config.mode,
          lastResult: report.stopped ? "STOPPED" : "COMPLETED",
          lastDuration: report.durationMs ?? this.now().getTime() - startedAt.getTime(),
          lastError: report.stopped ? sanitizeError(report.stopReason) : null,
          nextRunAt: null,
        };
        this.persistMetadata();
        this.logger.info("scheduler.run_finished", "Sincronizacion programada finalizada.", {
          runId: report.runId,
          result: this.metadata.lastResult,
          writes: report.executedWrites || 0,
        });
        return { status: this.metadata.lastResult, report };
      } catch (error) {
        this.metadata = {
          ...this.metadata,
          lastRunAt: startedAt.toISOString(),
          lastMode: this.config.mode,
          lastResult: "ERROR",
          lastDuration: this.now().getTime() - startedAt.getTime(),
          lastError: sanitizeError(error),
          nextRunAt: null,
        };
        this.persistMetadata();
        this.logger.error("scheduler.run_failed", "Fallo la sincronizacion programada.", {
          error: sanitizeError(error),
        });
        return { status: "ERROR", error: sanitizeError(error) };
      } finally {
        this.activeRun = null;
      }
    })();
    return this.activeRun;
  }

  async stop(timeoutMs) {
    this.stopping = true;
    this.started = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.metadata.nextRunAt = null;
    this.persistMetadata();
    if (!this.activeRun) return { completed: true, timedOut: false };
    let timeout;
    const timedOut = new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ completed: false, timedOut: true }), timeoutMs);
      timeout.unref?.();
    });
    const completed = this.activeRun.then(() => ({ completed: true, timedOut: false }));
    const result = await Promise.race([completed, timedOut]);
    clearTimeout(timeout);
    return result;
  }
}

module.exports = {
  ProductionScheduler,
  defaultRunProductionSync,
  emptyMetadata,
  sanitizeError,
};
