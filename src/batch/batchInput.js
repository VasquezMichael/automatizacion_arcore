const fs = require("fs");
const path = require("path");
const { normalizeSku } = require("../tiendanube/sku");

class BatchInputError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BatchInputError";
    this.code = code;
    if (details) this.details = details;
  }
}

function prepareBatchInput(skus) {
  if (!Array.isArray(skus)) {
    throw new BatchInputError("BATCH_INPUT_NOT_ARRAY", "El input batch debe ser un array de SKUs.");
  }

  const items = [];
  const seen = new Map();
  const duplicates = [];

  skus.forEach((value, index) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new BatchInputError(
        "BATCH_INPUT_INVALID_SKU",
        `El SKU en la posicion ${index} debe ser un string no vacio.`,
        { index },
      );
    }

    const inputSku = value.trim();
    const normalizedSku = normalizeSku(inputSku);
    if (!normalizedSku) {
      throw new BatchInputError(
        "BATCH_INPUT_INVALID_SKU",
        `El SKU en la posicion ${index} no puede normalizarse.`,
        { index },
      );
    }

    if (seen.has(normalizedSku)) {
      duplicates.push({
        inputSku,
        normalizedSku,
        duplicateOf: seen.get(normalizedSku),
      });
      return;
    }

    seen.set(normalizedSku, inputSku);
    items.push({ inputSku, normalizedSku, inputIndex: index });
  });

  return {
    inputCount: skus.length,
    uniqueSkuCount: items.length,
    duplicateInputCount: duplicates.length,
    items,
    duplicates,
  };
}

function readSkuFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new BatchInputError("BATCH_INPUT_FILE_NOT_FOUND", `No existe el archivo: ${resolvedPath}`);
  }

  const contents = fs.readFileSync(resolvedPath, "utf8");
  const extension = path.extname(resolvedPath).toLowerCase();
  if (extension === ".json") {
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new BatchInputError("BATCH_INPUT_JSON_INVALID", "El archivo JSON no es valido.", {
        cause: error.message,
      });
    }
    if (!Array.isArray(parsed)) {
      throw new BatchInputError(
        "BATCH_INPUT_JSON_NOT_ARRAY",
        "El archivo JSON debe contener un array de SKUs.",
      );
    }
    return parsed;
  }

  if (extension !== ".txt") {
    throw new BatchInputError(
      "BATCH_INPUT_FILE_TYPE_UNSUPPORTED",
      "El archivo de entrada debe ser .json o .txt.",
    );
  }

  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BatchInputError("BATCH_CLI_INVALID_OPTION", `${name} debe ser un entero positivo.`);
  }
  return parsed;
}

function parseBatchCliArgs(argv) {
  const positional = [];
  let filePath = null;
  let concurrency = 1;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--file") {
      filePath = argv[index + 1];
      if (!filePath) {
        throw new BatchInputError("BATCH_CLI_MISSING_FILE", "Falta el valor de --file.");
      }
      index += 1;
      continue;
    }
    if (argument === "--concurrency") {
      concurrency = parsePositiveInteger(argv[index + 1], "--concurrency");
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new BatchInputError("BATCH_CLI_UNKNOWN_OPTION", `Opcion desconocida: ${argument}`);
    }
    positional.push(argument);
  }

  if (filePath && positional.length > 0) {
    throw new BatchInputError(
      "BATCH_CLI_MULTIPLE_INPUTS",
      "Usa --file o una lista separada por comas, no ambos.",
    );
  }

  const skus = filePath
    ? readSkuFile(filePath)
    : positional.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);

  if (!filePath && positional.length === 0) {
    throw new BatchInputError(
      "BATCH_CLI_INPUT_REQUIRED",
      "Indica --file input/skus.txt o una lista de SKUs separada por comas.",
    );
  }

  return { skus, concurrency, filePath: filePath ? path.resolve(filePath) : null };
}

module.exports = {
  BatchInputError,
  parseBatchCliArgs,
  prepareBatchInput,
  readSkuFile,
};
