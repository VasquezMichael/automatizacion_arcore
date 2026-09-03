const assert = require("assert");

const {
  aggregatePublicationAction,
  applyAggregateTrace,
} = require("./testPriceSync");

function makePublication(action) {
  if (action === "PRICE_NO_CHANGE") {
    return {
      action,
      writeAttempted: false,
      writeSucceeded: false,
      verified: true,
      updated: false,
    };
  }

  if (action === "PRICE_UPDATED") {
    return {
      action,
      writeAttempted: true,
      writeSucceeded: true,
      verified: true,
      updated: true,
    };
  }

  if (action === "PRICE_UPDATE_FAILED") {
    return {
      action,
      writeAttempted: true,
      writeSucceeded: false,
      verified: false,
      updated: false,
    };
  }

  if (action === "PRICE_UPDATE_VERIFICATION_FAILED") {
    return {
      action,
      writeAttempted: true,
      writeSucceeded: true,
      verified: false,
      updated: false,
    };
  }

  return {
    action,
    writeAttempted: false,
    writeSucceeded: false,
    verified: false,
    updated: false,
  };
}

function repeatPublication(action, count) {
  return Array.from({ length: count }, () => makePublication(action));
}

function evaluate(publications) {
  const result = {
    type: "LEGACY_GROUP",
    action: aggregatePublicationAction(publications),
    publications,
  };
  applyAggregateTrace(result);
  return result;
}

function assertResult(label, publications, expected) {
  const result = evaluate(publications);

  for (const [key, value] of Object.entries(expected)) {
    assert.strictEqual(
      result[key],
      value,
      `${label}: expected ${key}=${value}, got ${result[key]}`,
    );
  }

  console.log(
    `OK ${label}: action=${result.action}, updated=${result.updated}, verified=${result.verified}`,
  );
}

function main() {
  assertResult("12 PRICE_NO_CHANGE", repeatPublication("PRICE_NO_CHANGE", 12), {
    action: "PRICE_NO_CHANGE",
    writeAttempted: false,
    writeSucceeded: false,
    verified: true,
    updated: false,
    anyWriteSucceeded: false,
    allWritesSucceeded: false,
    allVerified: true,
    anyUpdated: false,
    noChangeCount: 12,
    updatedCount: 0,
    failedCount: 0,
  });

  assertResult("12 PRICE_UPDATED", repeatPublication("PRICE_UPDATED", 12), {
    action: "PRICE_UPDATED",
    writeAttempted: true,
    writeSucceeded: true,
    verified: true,
    updated: true,
    anyWriteSucceeded: true,
    allWritesSucceeded: true,
    allVerified: true,
    anyUpdated: true,
    noChangeCount: 0,
    updatedCount: 12,
    failedCount: 0,
  });

  assertResult(
    "11 PRICE_UPDATED + 1 PRICE_UPDATE_FAILED",
    [
      ...repeatPublication("PRICE_UPDATED", 11),
      makePublication("PRICE_UPDATE_FAILED"),
    ],
    {
      action: "LEGACY_PRICE_PARTIAL_FAILURE",
      writeAttempted: true,
      writeSucceeded: false,
      verified: false,
      updated: false,
      anyWriteSucceeded: true,
      allWritesSucceeded: false,
      allVerified: false,
      anyUpdated: true,
      noChangeCount: 0,
      updatedCount: 11,
      failedCount: 1,
    },
  );

  assertResult(
    "10 PRICE_UPDATED + 1 PRICE_NO_CHANGE + 1 MANUAL_REVIEW",
    [
      ...repeatPublication("PRICE_UPDATED", 10),
      makePublication("PRICE_NO_CHANGE"),
      makePublication("MANUAL_REVIEW"),
    ],
    {
      action: "LEGACY_PRICE_PARTIAL_FAILURE",
      writeAttempted: true,
      writeSucceeded: true,
      verified: false,
      updated: false,
      anyWriteSucceeded: true,
      allWritesSucceeded: true,
      allVerified: false,
      anyUpdated: true,
      noChangeCount: 1,
      updatedCount: 10,
      failedCount: 1,
    },
  );
}

if (require.main === module) {
  main();
}
