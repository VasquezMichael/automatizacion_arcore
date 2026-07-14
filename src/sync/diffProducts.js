const RELEVANT_FIELDS = [
  "nombre",
  "searchedCode",
  "matchedCode",
  "matchType",
  "descripcion",
  "descripcionStock",
  "descripcionAlternativa",
  "color",
  "estadoDisponibilidad",
  "imageUrl",
  "imageSource",
  "imageWidth",
  "imageHeight",
  "precio",
  "categoria",
  "subcategoria",
];

function indexByExternalId(products) {
  return new Map(products.map((product) => [product.externalId, product]));
}

function diffProduct(previous, current) {
  const changes = [];

  for (const field of RELEVANT_FIELDS) {
    if ((previous[field] ?? null) !== (current[field] ?? null)) {
      changes.push({
        field,
        previous: previous[field] ?? null,
        current: current[field] ?? null,
      });
    }
  }

  return changes;
}

function compareProducts(previousProducts = [], currentProducts = [], notFoundProducts = []) {
  const previousById = indexByExternalId(previousProducts);
  const currentById = indexByExternalId(currentProducts);

  const newProducts = [];
  const updatedProducts = [];
  const unchangedProducts = [];
  const unavailableProducts = [];

  for (const current of currentProducts) {
    const previous = previousById.get(current.externalId);

    if (!previous) {
      newProducts.push(current);
    } else {
      const changes = diffProduct(previous, current);
      if (changes.length > 0) {
        updatedProducts.push({
          product: current,
          changes,
        });
      } else {
        unchangedProducts.push(current);
      }
    }

    if (current.estadoDisponibilidad === "UNAVAILABLE") {
      unavailableProducts.push(current);
    }
  }

  for (const previous of previousProducts) {
    if (!currentById.has(previous.externalId)) {
      notFoundProducts.push({
        reason: "MISSING_FROM_CURRENT_EXTRACTION",
        product: previous,
      });
    }
  }

  return {
    newProducts,
    updatedProducts,
    unchangedProducts,
    notFoundProducts,
    unavailableProducts,
  };
}

module.exports = {
  compareProducts,
};
