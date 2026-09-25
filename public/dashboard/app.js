const state = {
  dashboard: null,
  products: [],
  activity: [],
  filter: "ALL",
  query: "",
};

const elements = {
  summary: document.querySelector("#summary-grid"),
  body: document.querySelector("#products-body"),
  empty: document.querySelector("#empty-state"),
  resultCount: document.querySelector("#result-count"),
  search: document.querySelector("#search-input"),
  filters: document.querySelector("#filter-tabs"),
  refresh: document.querySelector("#refresh-button"),
  activity: document.querySelector("#activity-list"),
  sessionDot: document.querySelector("#session-dot"),
  sessionLabel: document.querySelector("#session-label"),
  lastAnalysis: document.querySelector("#last-analysis"),
  dialog: document.querySelector("#product-dialog"),
  detailSku: document.querySelector("#detail-sku"),
  detailTitle: document.querySelector("#detail-title"),
  detailBody: document.querySelector("#detail-body"),
  closeDialog: document.querySelector("#close-dialog"),
  toast: document.querySelector("#toast"),
};

const uiLabels = {
  OK: "OK",
  UPDATE_REQUIRED: "ACTUALIZAR",
  CREATE_REQUIRED: "CREAR",
  MANUAL_REVIEW: "REVISIÓN MANUAL",
  NOT_FOUND: "NO ENCONTRADO",
};

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatMoney(value) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

function badge(text, className) {
  const span = document.createElement("span");
  span.className = `badge ${className}`;
  span.textContent = text;
  return span;
}

function statusBadge(status) {
  const classes = {
    OK: "badge-ok",
    UPDATE_REQUIRED: "badge-update",
    CREATE_REQUIRED: "badge-create",
    MANUAL_REVIEW: "badge-review",
    NOT_FOUND: "badge-not-found",
  };
  return badge(uiLabels[status] || status, classes[status] || "badge-neutral");
}

function availabilityBadge(availability) {
  const labels = { AVAILABLE: "DISPONIBLE", PARTIAL: "PARCIAL", UNAVAILABLE: "NO DISPONIBLE", UNKNOWN: "SIN DATOS" };
  const classes = { AVAILABLE: "badge-available", PARTIAL: "badge-partial", UNAVAILABLE: "badge-unavailable", UNKNOWN: "badge-neutral" };
  return badge(labels[availability] || availability, classes[availability] || "badge-neutral");
}

function createSummaryCard(value, label) {
  const card = document.createElement("article");
  card.className = "summary-card";
  const strong = document.createElement("strong");
  const span = document.createElement("span");
  strong.textContent = String(value ?? 0);
  span.textContent = label;
  card.append(strong, span);
  return card;
}

function renderSummary() {
  const dashboard = state.dashboard;
  const scope = dashboard?.scopeSummary || {};
  const availability = dashboard?.availabilitySummary || {};
  const cards = [
    [scope.clientSkus, "SKU del cliente"],
    [scope.resolvedInArcore, "Resueltos en Arcore"],
    [scope.notFound, "No encontrados"],
    [scope.existingInTiendanube, "Existentes en Tiendanube"],
    [scope.productsToCreate, "Productos a crear"],
    [scope.manualReview, "Revisión manual"],
    [availability.available, "Disponibles"],
    [availability.partial, "Parciales"],
    [availability.unavailable, "No disponibles"],
  ];
  elements.summary.replaceChildren(...cards.map(([value, label]) => createSummaryCard(value, label)));
  const session = dashboard?.session;
  elements.sessionDot.className = `status-dot ${session?.status === "HEALTHY" ? "healthy" : session?.status === "DEGRADED" ? "degraded" : ""}`;
  elements.sessionLabel.textContent = session?.status === "HEALTHY"
    ? "Análisis disponible · sesión estable"
    : session?.status === "DEGRADED" ? "Análisis disponible con observaciones" : "Sin análisis disponible";
  elements.lastAnalysis.textContent = `Último análisis: ${formatDate(dashboard?.lastAnalysisAt)}`;
}

function cell(content, className = "") {
  const td = document.createElement("td");
  td.className = className;
  if (content instanceof Node) td.append(content);
  else td.textContent = content;
  return td;
}

function actionLabel(product) {
  if (product.uiStatus === "CREATE_REQUIRED") return "Crear producto";
  if (product.uiStatus === "MANUAL_REVIEW") return "Revisar datos";
  if (product.uiStatus === "NOT_FOUND") return "Localizar en Arcore";
  const actions = [];
  if (["PUBLISH", "UNPUBLISH"].includes(product.plannedActions.status)) actions.push("Estado");
  if (product.plannedActions.price === "PRICE_UPDATE") actions.push("Precio");
  if (["IMAGE_REPLACE", "IMAGE_CREATE"].includes(product.plannedActions.image)) actions.push("Imagen");
  return actions.length ? actions.join(" · ") : "Sin cambios";
}

function filteredProducts() {
  const query = state.query.toLocaleLowerCase("es");
  return state.products.filter((product) => {
    const matchesFilter = state.filter === "ALL" || product.uiStatus === state.filter;
    const matchesQuery = !query || product.sourceSku.toLocaleLowerCase("es").includes(query) ||
      product.normalizedSku.toLocaleLowerCase("es").includes(query) ||
      product.name.toLocaleLowerCase("es").includes(query);
    return matchesFilter && matchesQuery;
  });
}

function renderProducts() {
  const products = filteredProducts();
  const rows = products.map((product) => {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.dataset.sku = product.normalizedSku;
    const productCell = document.createElement("div");
    productCell.className = "product-name";
    productCell.textContent = product.name;
    const sub = document.createElement("span");
    sub.className = "secondary";
    sub.textContent = product.matchedCode || "Sin coincidencia";
    productCell.append(sub);
    row.append(
      cell(product.sourceSku, "sku"),
      cell(productCell),
      cell(product.supplierResolution === "SAFE_TRANSFORM" ? "Coincidencia segura" : product.supplierResolution),
      cell(availabilityBadge(product.availability)),
      cell(product.classification.replaceAll("_", " ")),
      cell(formatMoney(product.supplierPrice), "money"),
      cell(formatMoney(product.tiendanubePrice), "money"),
      cell(actionLabel(product)),
      cell(statusBadge(product.uiStatus)),
    );
    const open = () => openProduct(product.normalizedSku);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open();
    });
    return row;
  });
  elements.body.replaceChildren(...rows);
  elements.empty.hidden = state.products.length > 0;
  elements.resultCount.textContent = `${products.length} de ${state.products.length} productos`;
}

function detailField(label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "detail-field";
  const term = document.createElement("dt");
  const definition = document.createElement("dd");
  term.textContent = label;
  definition.textContent = value ?? "—";
  wrapper.append(term, definition);
  return wrapper;
}

function detailSection(title, fields) {
  const section = document.createElement("section");
  section.className = "detail-section";
  const heading = document.createElement("h3");
  const grid = document.createElement("dl");
  heading.textContent = title;
  grid.className = "detail-grid";
  grid.append(...fields);
  section.append(heading, grid);
  return section;
}

async function openProduct(normalizedSku) {
  try {
    const response = await fetch(`/api/products/${encodeURIComponent(normalizedSku)}`);
    if (!response.ok) throw new Error("PRODUCT_NOT_FOUND");
    const product = await response.json();
    elements.detailSku.textContent = product.sourceSku;
    elements.detailTitle.textContent = product.name;
    const publications = product.details.tiendanube.publications;
    const publicationSection = document.createElement("section");
    publicationSection.className = "detail-section";
    const publicationTitle = document.createElement("h3");
    publicationTitle.textContent = "Publicaciones en Tiendanube";
    publicationSection.append(publicationTitle);
    if (publications.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No hay publicaciones asociadas.";
      publicationSection.append(empty);
    } else {
      for (const publication of publications) {
        const row = document.createElement("div");
        row.className = "publication-row";
        row.append(
          detailField("Producto / variante", `${publication.productId} / ${publication.variantId}`),
          detailField("Precio", formatMoney(publication.price)),
          detailField("Publicado", publication.published === null ? "—" : publication.published ? "Sí" : "No"),
          detailField("Imágenes", publication.imageCount ?? "—"),
        );
        publicationSection.append(row);
      }
    }
    elements.detailBody.replaceChildren(
      detailSection("Cliente", [
        detailField("SKU origen", product.details.client.sourceSku),
        detailField("SKU normalizado", product.details.client.normalizedSku),
      ]),
      detailSection("Arcore", [
        detailField("Código encontrado", product.details.arcore.matchedCode),
        detailField("Resolución", product.details.arcore.resolution),
        detailField("Disponibilidad", product.details.arcore.availability),
        detailField("Precio proveedor", formatMoney(product.details.arcore.supplierPrice)),
        detailField("Imagen fuente", product.details.arcore.imageSource),
      ]),
      publicationSection,
      detailSection("Plan propuesto", [
        detailField("Precio", product.details.plan.price),
        detailField("Publicación", product.details.plan.status),
        detailField("Imagen", product.details.plan.image),
        detailField("Creación", product.details.plan.create),
      ]),
    );
    elements.dialog.showModal();
  } catch (_error) {
    showToast("No se pudo abrir el detalle del producto.", true);
  }
}

function renderActivity() {
  const resultClasses = {
    COMPLETADO: "badge-ok",
    PLANIFICADO: "badge-info",
    CON_OBSERVACIONES: "badge-update",
    DETENIDO: "badge-review",
  };
  const rows = state.activity.map((event) => {
    const row = document.createElement("article");
    row.className = "activity-row";
    const date = document.createElement("time");
    const title = document.createElement("div");
    const result = badge(event.result, resultClasses[event.result] || "badge-neutral");
    const meta = document.createElement("div");
    date.className = "activity-date";
    date.dateTime = event.date;
    date.textContent = formatDate(event.date);
    title.className = "activity-title";
    title.textContent = event.type;
    meta.className = "activity-meta";
    meta.textContent = `${event.processed} SKU · ${event.writes} writes · ${event.status}`;
    row.append(date, title, result, meta);
    return row;
  });
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No hay actividad registrada.";
    elements.activity.replaceChildren(empty);
  } else {
    elements.activity.replaceChildren(...rows);
  }
}

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast${error ? " error" : ""}`;
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, 5000);
}

async function loadDashboard() {
  const [dashboardResponse, productsResponse, activityResponse] = await Promise.all([
    fetch("/api/dashboard"),
    fetch("/api/products"),
    fetch("/api/activity"),
  ]);
  if (!dashboardResponse.ok || !productsResponse.ok || !activityResponse.ok) {
    throw new Error("LOAD_FAILED");
  }
  state.dashboard = await dashboardResponse.json();
  state.products = (await productsResponse.json()).products;
  state.activity = (await activityResponse.json()).activity;
  renderSummary();
  renderProducts();
  renderActivity();
}

async function refreshAnalysis() {
  elements.refresh.disabled = true;
  elements.refresh.classList.add("loading");
  elements.refresh.querySelector(".button-label").textContent = "Analizando...";
  showToast("El análisis read-only está en curso. Puede demorar varios minutos.");
  try {
    const response = await fetch("/api/analysis/refresh", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.code || "ANALYSIS_FAILED");
    await loadDashboard();
    showToast("Análisis actualizado correctamente.");
  } catch (error) {
    const message = error.message === "ANALYSIS_ALREADY_RUNNING"
      ? "Ya existe un análisis en curso."
      : "No se pudo completar el análisis.";
    showToast(message, true);
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.classList.remove("loading");
    elements.refresh.querySelector(".button-label").textContent = "Actualizar análisis";
  }
}

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  renderProducts();
});
elements.filters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  elements.filters.querySelectorAll(".filter-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
  renderProducts();
});
elements.refresh.addEventListener("click", refreshAnalysis);
elements.closeDialog.addEventListener("click", () => elements.dialog.close());
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) elements.dialog.close();
});

loadDashboard().catch(() => {
  showToast("No se pudo cargar el dashboard.", true);
  renderSummary();
  renderProducts();
  renderActivity();
});
