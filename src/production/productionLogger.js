const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|session|token)/i;

function redactText(value) {
  return String(value)
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:authorization|cookie|credential|password|secret|session|token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

function sanitizeLogValue(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, item]) => [
      childKey,
      sanitizeLogValue(item, childKey),
    ]),
  );
}

function createProductionLogger(options = {}) {
  const write = options.write || ((line) => console.log(line));
  const component = options.component || "production";
  const now = options.now || (() => new Date());

  function log(level, event, message, context = {}) {
    const record = sanitizeLogValue({
      timestamp: now().toISOString(),
      level,
      component,
      event,
      message,
      ...context,
    });
    write(JSON.stringify(record));
    return record;
  }

  return {
    debug: (event, message, context) => log("debug", event, message, context),
    error: (event, message, context) => log("error", event, message, context),
    info: (event, message, context) => log("info", event, message, context),
    warn: (event, message, context) => log("warn", event, message, context),
  };
}

module.exports = {
  createProductionLogger,
  redactText,
  sanitizeLogValue,
};
