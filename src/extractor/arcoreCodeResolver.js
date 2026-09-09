const { normalizeSku } = require("../tiendanube/sku");

const SupplierResolutionType = Object.freeze({
  EXACT: "EXACT",
  SAFE_TRANSFORM: "SAFE_TRANSFORM",
  AMBIGUOUS: "AMBIGUOUS",
  NOT_FOUND: "NOT_FOUND",
});

function toCandidateRecord(candidate, index) {
  const value =
    typeof candidate === "object" && candidate !== null
      ? candidate.codComercial ?? candidate.codigo ?? candidate.code
      : candidate;
  const code = String(value || "").trim();

  return {
    index,
    id:
      typeof candidate === "object" && candidate !== null
        ? candidate.id ?? null
        : null,
    code,
    normalizedCode: normalizeSku(code),
  };
}

function deduplicateCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const identity = candidate.id
      ? `${candidate.id}:${candidate.normalizedCode}`
      : candidate.normalizedCode;
    if (!candidate.normalizedCode || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function publicCandidate(candidate) {
  return {
    id: candidate.id,
    code: candidate.code,
    normalizedCode: candidate.normalizedCode,
  };
}

function resolveArcoreCode(requestedCode, candidates = []) {
  const sourceCode = normalizeSku(requestedCode);
  const normalizedCandidates = deduplicateCandidates(
    candidates.map(toCandidateRecord),
  );
  if (!sourceCode) {
    return {
      type: SupplierResolutionType.NOT_FOUND,
      sourceCode,
      matchedCode: null,
      rule: null,
      candidates: normalizedCandidates.map(publicCandidate),
      matchedCandidateIndex: null,
    };
  }
  const potentialCandidates = normalizedCandidates.filter(
    (candidate) =>
      candidate.normalizedCode === sourceCode ||
      candidate.normalizedCode === `${sourceCode}0`,
  );

  if (potentialCandidates.length === 0) {
    return {
      type: SupplierResolutionType.NOT_FOUND,
      sourceCode,
      matchedCode: null,
      rule: null,
      candidates: normalizedCandidates.map(publicCandidate),
      matchedCandidateIndex: null,
    };
  }

  if (potentialCandidates.length > 1) {
    return {
      type: SupplierResolutionType.AMBIGUOUS,
      sourceCode,
      matchedCode: null,
      rule: null,
      candidates: potentialCandidates.map(publicCandidate),
      matchedCandidateIndex: null,
    };
  }

  const match = potentialCandidates[0];
  const exact = match.normalizedCode === sourceCode;
  return {
    type: exact
      ? SupplierResolutionType.EXACT
      : SupplierResolutionType.SAFE_TRANSFORM,
    sourceCode,
    matchedCode: match.code,
    rule: exact ? "EXACT_CODE" : "APPEND_TRAILING_ZERO",
    candidates: [publicCandidate(match)],
    matchedCandidateIndex: match.index,
  };
}

function isAutomaticSupplierResolution(resolution) {
  return (
    resolution?.type === SupplierResolutionType.EXACT ||
    resolution?.type === SupplierResolutionType.SAFE_TRANSFORM
  );
}

module.exports = {
  SupplierResolutionType,
  isAutomaticSupplierResolution,
  resolveArcoreCode,
};
