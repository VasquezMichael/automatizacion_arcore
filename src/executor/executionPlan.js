const { moneyEquals } = require("../pricing/priceCalculator");

const EXECUTION_ORDER = Object.freeze([
  "REVALIDATE",
  "STATUS",
  "PRICE",
  "IMAGE",
  "FINAL_VERIFY",
]);

const ExecutionStatus = Object.freeze({
  SUCCESS: "SUCCESS",
  PARTIAL_FAILURE: "PARTIAL_FAILURE",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
  NO_CHANGES: "NO_CHANGES",
  SIMULATED: "SIMULATED",
  SIMULATED_WITH_BLOCKS: "SIMULATED_WITH_BLOCKS",
});

function pairKey(item) {
  return `${item.productId}:${item.variantId}`;
}

function publicationMap(planGroup) {
  return new Map((planGroup?.publications || []).map((item) => [pairKey(item), item]));
}

function actionBase(type, planned, current) {
  return {
    type,
    productId: planned?.productId ?? current?.productId ?? null,
    variantId: planned?.variantId ?? current?.variantId ?? null,
    plannedAction: planned?.action || null,
    currentState: null,
    desiredState: null,
    simulationResult: null,
    executionResult: null,
    writeAttempted: false,
    writeSucceeded: false,
    verified: false,
    updated: false,
    errors: [],
  };
}

function stateChangedIssue(type, action, message) {
  return {
    code: "REVALIDATION_FAILED",
    message,
    type,
    productId: action.productId,
    variantId: action.variantId,
  };
}

function buildStatusAction(planned, current) {
  const action = actionBase("STATUS", planned, current);
  action.currentState = { published: current?.published ?? null };
  action.desiredState = { published: planned?.desiredPublished ?? null };

  if (!current) {
    return {
      action: { ...action, simulationResult: "REVALIDATION_FAILED" },
      issue: stateChangedIssue("STATUS", action, "Falta la publicacion al revalidar estado."),
    };
  }
  if (current.published === planned.desiredPublished) {
    return { action: { ...action, simulationResult: "SKIPPED_ALREADY_APPLIED" } };
  }
  if (current.published !== planned.published) {
    return {
      action: { ...action, simulationResult: "REVALIDATION_FAILED" },
      issue: stateChangedIssue(
        "STATUS",
        action,
        "El estado published cambio desde la planificacion y no coincide con el deseado.",
      ),
    };
  }
  if (planned.action === "PUBLISH" || planned.action === "UNPUBLISH") {
    return { action: { ...action, simulationResult: "WOULD_UPDATE" } };
  }
  return {
    action: { ...action, simulationResult: "REVALIDATION_FAILED" },
    issue: stateChangedIssue("STATUS", action, "El plan de estado ya no es consistente."),
  };
}

function buildPriceAction(planned, current) {
  const action = actionBase("PRICE", planned, current);
  const currentPrice = current?.currentPrice ?? null;
  action.currentState = { price: currentPrice };
  action.desiredState = { price: planned?.requestedPrice ?? null };

  if (!current) {
    return {
      action: { ...action, simulationResult: "REVALIDATION_FAILED" },
      issue: stateChangedIssue("PRICE", action, "Falta la publicacion al revalidar precio."),
    };
  }
  if (moneyEquals(currentPrice, planned.requestedPrice)) {
    return { action: { ...action, simulationResult: "SKIPPED_ALREADY_APPLIED" } };
  }
  if (!moneyEquals(currentPrice, planned.currentPrice)) {
    return {
      action: { ...action, simulationResult: "REVALIDATION_FAILED" },
      issue: stateChangedIssue(
        "PRICE",
        action,
        "El precio cambio desde la planificacion y no coincide con el deseado.",
      ),
    };
  }
  if (planned.action === "PRICE_UPDATE") {
    return { action: { ...action, simulationResult: "WOULD_UPDATE" } };
  }
  return {
    action: { ...action, simulationResult: "REVALIDATION_FAILED" },
    issue: stateChangedIssue("PRICE", action, "El plan de precio ya no es consistente."),
  };
}

function buildImageAction(planned, current) {
  const action = actionBase("IMAGE", planned, current);
  action.currentState = {
    imageId: current?.imageId ?? null,
    exactHash: current?.tiendanubeHash ?? null,
  };
  action.desiredState = {
    exactHash: planned?.sourceHash ?? null,
  };

  if (!current) {
    return {
      action: { ...action, simulationResult: "REVALIDATION_FAILED" },
      issue: stateChangedIssue("IMAGE", action, "Falta la publicacion al revalidar imagen."),
    };
  }
  if (current.action === "IMAGE_NO_CHANGE") {
    return { action: { ...action, simulationResult: "SKIPPED_ALREADY_APPLIED" } };
  }
  if (planned.action === "IMAGE_NO_CHANGE") {
    return {
      action: { ...action, simulationResult: "REVALIDATION_FAILED" },
      issue: stateChangedIssue(
        "IMAGE",
        action,
        "La imagen dejo de coincidir desde la planificacion.",
      ),
    };
  }
  if (planned.action === "IMAGE_CREATE" && current.action === "IMAGE_CREATE") {
    return { action: { ...action, simulationResult: "WOULD_CREATE" } };
  }
  if (planned.action === "IMAGE_REPLACE" && current.action === "IMAGE_REPLACE") {
    if (String(planned.imageId || "") !== String(current.imageId || "")) {
      return {
        action: { ...action, simulationResult: "REVALIDATION_FAILED" },
        issue: stateChangedIssue(
          "IMAGE",
          action,
          "La imagen principal cambio desde la planificacion.",
        ),
      };
    }
    return { action: { ...action, simulationResult: "WOULD_REPLACE" } };
  }
  return {
    action: { ...action, simulationResult: "REVALIDATION_FAILED" },
    issue: stateChangedIssue("IMAGE", action, "El plan de imagen ya no es consistente."),
  };
}

function blockedDomainActions(type, plannedGroup, currentGroup, blocks) {
  const plannedPublications = plannedGroup?.publications || [];
  const currentPublications = publicationMap(currentGroup);
  const targets = plannedPublications.length > 0 ? plannedPublications : [null];

  return targets.map((planned) => {
    const current = planned ? currentPublications.get(pairKey(planned)) : null;
    return {
      type,
      productId: planned?.productId ?? null,
      variantId: planned?.variantId ?? null,
      plannedAction: planned?.action || plannedGroup?.action || null,
      currentState: current || null,
      desiredState: null,
      simulationResult: "NOT_EXECUTABLE",
      blocks,
    };
  });
}

function buildPublicationActions(plan, currentPlans, domainBlocks) {
  const actions = [];
  const issues = [];
  const currentStatus = publicationMap(currentPlans.status);
  const currentPrice = publicationMap(currentPlans.price);
  const currentImage = publicationMap(currentPlans.image);

  if (domainBlocks.status.length > 0) {
    actions.push(
      ...blockedDomainActions(
        "STATUS",
        plan.plans.status,
        currentPlans.status,
        domainBlocks.status,
      ),
    );
  } else {
    for (const planned of plan.plans.status?.publications || []) {
      const result = buildStatusAction(planned, currentStatus.get(pairKey(planned)));
      actions.push(result.action);
      if (result.issue) issues.push(result.issue);
    }
  }

  if (domainBlocks.price.length > 0) {
    actions.push(
      ...blockedDomainActions(
        "PRICE",
        plan.plans.price,
        currentPlans.price,
        domainBlocks.price,
      ),
    );
  } else {
    for (const planned of plan.plans.price?.publications || []) {
      const result = buildPriceAction(planned, currentPrice.get(pairKey(planned)));
      actions.push(result.action);
      if (result.issue) issues.push(result.issue);
    }
  }

  if (domainBlocks.image.length > 0) {
    actions.push(
      ...blockedDomainActions(
        "IMAGE",
        plan.plans.image,
        currentPlans.image,
        domainBlocks.image,
      ),
    );
  } else if (plan.plans.image?.action === "NO_SOURCE_IMAGE") {
    actions.push({
      type: "IMAGE",
      productId: null,
      variantId: null,
      plannedAction: "NO_SOURCE_IMAGE",
      currentState: null,
      desiredState: { primaryImage: null },
      simulationResult: "SKIPPED_NO_SOURCE_IMAGE",
    });
  } else {
    for (const planned of plan.plans.image?.publications || []) {
      const result = buildImageAction(planned, currentImage.get(pairKey(planned)));
      actions.push(result.action);
      if (result.issue) issues.push(result.issue);
    }
  }

  return { actions, issues };
}

function buildCreationAction(plan, domainBlocks) {
  const hasImage = Boolean(plan.supplier.imageUrl) && domainBlocks.image.length === 0;
  const hasMinimumName = Boolean(plan.supplier.name);
  return {
    type: "CREATE_PRODUCT",
    productId: null,
    variantId: null,
    plannedAction: "CREATE_SINGLE",
    currentState: { matchCount: 0 },
    desiredState: {
      sku: plan.normalizedSku,
      name: plan.supplier.name || null,
      nameSource: hasMinimumName ? "ARCORE_MINIMAL" : null,
      price: plan.plans.price.calculation.calculatedPrice,
      published: plan.plans.status.desiredPublished,
      primaryImage: hasImage ? plan.supplier.imageUrl : null,
      allowedFields: [
        "sku",
        "price",
        "published",
        ...(hasMinimumName ? ["name"] : []),
        ...(hasImage ? ["primaryImage"] : []),
      ],
    },
    simulationResult: "WOULD_CREATE",
  };
}

function summarizeActions(actions, blocked) {
  const domainActions = actions.filter(
    (action) => action.type !== "REVALIDATE" && action.type !== "FINAL_VERIFY",
  );
  const wouldResults = new Set(["WOULD_CREATE", "WOULD_REPLACE", "WOULD_UPDATE"]);
  const wouldWrite = domainActions.filter((action) =>
    wouldResults.has(action.simulationResult) && !action.writeAttempted,
  ).length;
  const skippedAlreadyApplied = domainActions.filter(
    (action) => action.simulationResult === "SKIPPED_ALREADY_APPLIED",
  ).length;
  const blockedActions = domainActions.filter((action) =>
    ["BLOCKED", "NOT_EXECUTABLE", "REVALIDATION_FAILED"].includes(
      action.simulationResult,
    ),
  ).length;
  const failedActions = domainActions.filter(
    (action) =>
      action.simulationResult === "FAILED" ||
      action.executionResult === "WRITE_FAILED",
  ).length;
  const verificationFailedActions = domainActions.filter(
    (action) => action.executionResult === "WRITE_VERIFICATION_FAILED",
  ).length;
  const successfulWrites = domainActions.filter(
    (action) => action.executionResult === "WRITE_SUCCEEDED",
  ).length;
  const writeActions = domainActions.filter((action) => action.writeAttempted);
  const updatedActions = domainActions.filter((action) => action.updated).length;

  let executionStatus = ExecutionStatus.NO_CHANGES;
  if (blocked) executionStatus = ExecutionStatus.BLOCKED;
  else if (verificationFailedActions > 0) {
    executionStatus = ExecutionStatus.PARTIAL_FAILURE;
  }
  else if (failedActions > 0) executionStatus = ExecutionStatus.FAILED;
  else if (successfulWrites > 0) executionStatus = ExecutionStatus.SUCCESS;
  else if (blockedActions > 0) {
    executionStatus = ExecutionStatus.SIMULATED_WITH_BLOCKS;
  }
  else if (wouldWrite > 0) executionStatus = ExecutionStatus.SIMULATED;

  return {
    executionStatus,
    plannedActions: domainActions.length,
    wouldWrite,
    skippedAlreadyApplied,
    blockedActions,
    failedActions: failedActions + verificationFailedActions,
    successfulWrites,
    writeAttempted: writeActions.length > 0,
    writeSucceeded:
      writeActions.length > 0 && writeActions.every((action) => action.writeSucceeded),
    verified:
      writeActions.length > 0 && writeActions.every((action) => action.verified),
    updated: updatedActions > 0,
  };
}

function summarizeLegacyPriceActions(
  actions,
  { groupIntegrityFailed = false, simulated = false } = {},
) {
  const summary = summarizeActions(actions, false);
  const priceActions = actions.filter((action) => action.type === "PRICE");
  const writeAttemptedCount = priceActions.filter(
    (action) => action.writeAttempted,
  ).length;
  const writeSucceededCount = priceActions.filter(
    (action) => action.writeSucceeded,
  ).length;
  const skippedAlreadyAppliedCount = priceActions.filter(
    (action) => action.executionResult === "SKIPPED_ALREADY_APPLIED",
  ).length;
  const failedCount = priceActions.filter((action) =>
    ["WRITE_FAILED", "WRITE_VERIFICATION_FAILED"].includes(
      action.executionResult,
    ),
  ).length;
  const blockedCount = priceActions.filter(
    (action) => action.executionResult === "BLOCKED",
  ).length;
  const verifiedCount = priceActions.filter((action) => action.verified).length;
  const updatedCount = priceActions.filter((action) => action.updated).length;
  const hasPartialResult =
    failedCount > 0 ||
    (blockedCount > 0 && (writeAttemptedCount > 0 || verifiedCount > 0));

  let executionStatus;
  if (simulated) executionStatus = summary.executionStatus;
  else if (hasPartialResult) executionStatus = ExecutionStatus.PARTIAL_FAILURE;
  else if (blockedCount > 0 || groupIntegrityFailed) {
    executionStatus = ExecutionStatus.BLOCKED;
  } else if (writeAttemptedCount > 0) {
    executionStatus =
      verifiedCount === priceActions.length
        ? ExecutionStatus.SUCCESS
        : ExecutionStatus.PARTIAL_FAILURE;
  } else {
    executionStatus = ExecutionStatus.NO_CHANGES;
  }

  return {
    ...summary,
    executionStatus,
    totalPublications: priceActions.length,
    writeAttemptedCount,
    writeSucceededCount,
    skippedAlreadyAppliedCount,
    failedCount,
    blockedCount,
    verifiedCount,
    updatedCount,
    writeAttempted: writeAttemptedCount > 0,
    writeSucceeded:
      writeAttemptedCount > 0 && writeSucceededCount === writeAttemptedCount,
    verified:
      priceActions.length > 0 && verifiedCount === priceActions.length,
    updated:
      priceActions.length > 0 &&
      verifiedCount === priceActions.length &&
      updatedCount > 0 &&
      failedCount === 0 &&
      blockedCount === 0,
  };
}

function buildExecutionPlan(plan, revalidation, { domainBlocks } = {}) {
  const activeDomainBlocks = domainBlocks || { status: [], price: [], image: [] };
  const actions = [
    {
      type: "REVALIDATE",
      productId: null,
      variantId: null,
      plannedAction: "REVALIDATE",
      currentState: { classification: plan.classification },
      desiredState: { revalidationPassed: true },
      simulationResult: revalidation.ok ? "PASSED" : "REVALIDATION_FAILED",
    },
  ];

  if (!revalidation.ok) {
    return {
      executionPlan: { order: [...EXECUTION_ORDER], actions },
      issues: revalidation.issues || [],
      summary: summarizeActions(actions, true),
    };
  }

  let domain;
  if (plan.classification === "CREATE_SINGLE") {
    domain = {
      actions: [buildCreationAction(plan, activeDomainBlocks)],
      issues: [],
    };
    if (activeDomainBlocks.image.length > 0) {
      domain.actions.push(
        ...blockedDomainActions(
          "IMAGE",
          plan.plans.image,
          revalidation.plans?.image,
          activeDomainBlocks.image,
        ),
      );
    }
  } else {
    domain = buildPublicationActions(plan, revalidation.plans, activeDomainBlocks);
  }
  actions.push(...domain.actions);

  if (domain.issues.length > 0) {
    for (const action of actions) {
      if (["WOULD_CREATE", "WOULD_REPLACE", "WOULD_UPDATE"].includes(action.simulationResult)) {
        action.simulationResult = "BLOCKED";
      }
    }
  }

  actions.push({
    type: "FINAL_VERIFY",
    productId: null,
    variantId: null,
    plannedAction: "FINAL_VERIFY",
    currentState: null,
    desiredState: { allActionsVerified: true },
    simulationResult: domain.issues.length > 0 ? "BLOCKED" : "NOT_RUN_SIMULATION",
  });

  return {
    executionPlan: { order: [...EXECUTION_ORDER], actions },
    issues: domain.issues,
    summary: summarizeActions(actions, domain.issues.length > 0),
  };
}

function buildBlockedExecutionPlan(plan, issues) {
  const actions = [
    {
      type: "REVALIDATE",
      productId: null,
      variantId: null,
      plannedAction: "REVALIDATE",
      currentState: { classification: plan?.classification || null },
      desiredState: { guardsPassed: true },
      simulationResult: "BLOCKED",
    },
  ];
  return {
    executionPlan: { order: [...EXECUTION_ORDER], actions },
    issues,
    summary: summarizeActions(actions, true),
  };
}

module.exports = {
  EXECUTION_ORDER,
  ExecutionStatus,
  buildBlockedExecutionPlan,
  buildExecutionPlan,
  summarizeActions,
  summarizeLegacyPriceActions,
};
