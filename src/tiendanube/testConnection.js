const {
  createTiendanubeClient,
  getTiendanubeConfig,
  maskToken,
} = require("./client");

function pickLocalizedValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  return value.es || value.pt || value.en || Object.values(value).find(Boolean) || "";
}

function pickSku(product) {
  if (!Array.isArray(product.variants)) return "";
  const variant = product.variants.find((item) => item && item.sku) || product.variants[0];
  return variant?.sku || "";
}

function parseApiError(response) {
  if (!response) return null;
  return {
    status: response.status,
    statusText: response.statusText,
    data: response.data,
  };
}

function printApiError(error) {
  if (error.response) {
    const apiError = parseApiError(error.response);
    console.error(`- status HTTP: ${apiError.status}`);
    console.error(`- status text: ${apiError.statusText || ""}`);
    console.error("- respuesta de Tiendanube:");
    console.error(JSON.stringify(apiError.data, null, 2));
    return;
  }

  if (error.request) {
    console.error("- no se recibio respuesta de Tiendanube");
    console.error(`- mensaje: ${error.message}`);
    return;
  }

  console.error(`- mensaje: ${error.message}`);
}

function assertOkResponse(response, label) {
  if (response.status >= 200 && response.status < 300) return;

  const error = new Error(`${label} fallo con status HTTP ${response.status}`);
  error.response = response;
  throw error;
}

async function main() {
  console.log("Conectando con Tiendanube...\n");

  try {
    console.log("Paso 1 - Validando variables...");
    const config = getTiendanubeConfig();

    console.log(`- access token: configurado (${maskToken(config.accessToken)})`);
    console.log(`- user agent: ${config.userAgent}`);

    if (!config.storeId) {
      console.log("\nPaso 2 - Store ID");
      console.log("- TIENDANUBE_STORE_ID esta vacio.");
      console.log(
        "- No puedo obtenerlo automaticamente usando solo un access token ya emitido.",
      );
      console.log(
        "- En el flujo OAuth de Tiendanube, el Store ID se entrega como user_id junto con el access_token.",
      );
      console.log(
        "- Copia ese user_id en .env como TIENDANUBE_STORE_ID y vuelve a ejecutar este comando.",
      );
      process.exitCode = 1;
      return;
    }

    console.log("\nPaso 2 - Store ID");
    console.log(`- Store ID: ${config.storeId}`);

    const client = createTiendanubeClient(config);

    console.log("\nPaso 3 - Validando autenticacion con GET /store...");
    const storeResponse = await client.getStore();
    assertOkResponse(storeResponse, "GET /store");

    const store = storeResponse.data || {};
    const confirmedStoreId = store.id ? String(store.id) : "";

    console.log("- autenticacion: OK");
    console.log(`- status: ${storeResponse.status}`);
    if (confirmedStoreId) {
      console.log(`- Store ID confirmado por API: ${confirmedStoreId}`);
      if (confirmedStoreId !== String(config.storeId)) {
        console.warn(
          `- advertencia: TIENDANUBE_STORE_ID=${config.storeId} no coincide con store.id=${confirmedStoreId}`,
        );
      }
    }

    console.log("\nPaso 4 - Listando productos de prueba...");
    const productsResponse = await client.listProducts({ page: 1, perPage: 10 });
    assertOkResponse(productsResponse, "GET /products");

    const products = Array.isArray(productsResponse.data) ? productsResponse.data : [];

    console.log("\nConexion exitosa con Tiendanube.");
    console.log(`- Store ID utilizado: ${config.storeId}`);
    console.log(`- status: ${productsResponse.status}`);
    console.log(`- productos recibidos: ${products.length}`);
    if (productsResponse.headers["x-total-count"]) {
      console.log(`- total reportado por API: ${productsResponse.headers["x-total-count"]}`);
    }

    console.log("\nProductos de prueba:");
    if (products.length === 0) {
      console.log("- La API respondio correctamente, pero no devolvio productos.");
    }

    products.slice(0, 10).forEach((product, index) => {
      const sku = pickSku(product) || "sin SKU";
      const name = pickLocalizedValue(product.name) || "sin nombre";
      const published =
        product.published !== undefined
          ? product.published
          : product.visibility === "visible";

      console.log(
        `${index + 1}. ID: ${product.id} | SKU: ${sku} | Nombre: ${name} | Publicado: ${published}`,
      );
    });

    process.exitCode = 0;
  } catch (error) {
    console.error("\nError conectando con Tiendanube:");
    printApiError(error);
    console.error("\nNota: el access token completo no se imprime por seguridad.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
