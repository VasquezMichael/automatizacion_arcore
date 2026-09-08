function desiredPublishedForAvailability(availability) {
  if (availability === "AVAILABLE" || availability === "PARTIAL") return true;
  if (availability === "UNAVAILABLE") return false;
  return null;
}

function planPublicationStatus(match, availability) {
  const desiredPublished = desiredPublishedForAvailability(availability);
  let action = "STATUS_UNKNOWN";

  if (desiredPublished !== null && match.published === desiredPublished) {
    action = "STATUS_NO_CHANGE";
  } else if (desiredPublished === true) {
    action = "PUBLISH";
  } else if (desiredPublished === false) {
    action = "UNPUBLISH";
  }

  return {
    productId: match.productId,
    variantId: match.variantId,
    published: match.published,
    desiredPublished,
    action,
  };
}

function buildStatusPlan({ classification, matches, availability }) {
  const desiredPublished = desiredPublishedForAvailability(availability);

  if (classification === "MANUAL_REVIEW") {
    return {
      action: "MANUAL_REVIEW",
      desiredPublished,
      publications: [],
    };
  }

  if (classification === "CREATE_SINGLE") {
    return {
      action: desiredPublished === null ? "STATUS_UNKNOWN" : "STATUS_FOR_CREATION",
      desiredPublished,
      publications: [],
    };
  }

  const publications = matches.map((match) =>
    planPublicationStatus(match, availability),
  );
  const actions = publications.map((publication) => publication.action);
  let action = "STATUS_NO_CHANGE";

  if (actions.includes("STATUS_UNKNOWN")) action = "STATUS_UNKNOWN";
  else if (actions.includes("PUBLISH")) action = "PUBLISH";
  else if (actions.includes("UNPUBLISH")) action = "UNPUBLISH";

  return {
    action,
    desiredPublished,
    publications,
  };
}

module.exports = {
  buildStatusPlan,
  desiredPublishedForAvailability,
  planPublicationStatus,
};
