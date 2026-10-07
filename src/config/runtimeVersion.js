const path = require("path");
const { execFileSync } = require("child_process");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");

function normalizeMetadataValue(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function readGitCommit(options = {}) {
  const runGit = options.runGit || execFileSync;
  try {
    return normalizeMetadataValue(runGit("git", ["rev-parse", options.gitRef || "HEAD"], {
      cwd: options.cwd || REPOSITORY_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch (_error) {
    return null;
  }
}

function resolveRuntimeVersion(options = {}) {
  const env = options.env || process.env;
  const candidates = [
    ["RAILWAY_GIT_COMMIT_SHA", env.RAILWAY_GIT_COMMIT_SHA],
    ["APP_COMMIT_SHA", env.APP_COMMIT_SHA],
    ["GIT_COMMIT_SHA", env.GIT_COMMIT_SHA],
  ];

  for (const [source, value] of candidates) {
    const commitSha = normalizeMetadataValue(value);
    if (commitSha) {
      return {
        commitSha,
        source,
        railwayBranch: normalizeMetadataValue(env.RAILWAY_GIT_BRANCH),
        railwayDeploymentId: normalizeMetadataValue(env.RAILWAY_DEPLOYMENT_ID),
      };
    }
  }

  const commitSha = readGitCommit(options);
  return {
    commitSha,
    source: commitSha ? "GIT" : "UNAVAILABLE",
    railwayBranch: normalizeMetadataValue(env.RAILWAY_GIT_BRANCH),
    railwayDeploymentId: normalizeMetadataValue(env.RAILWAY_DEPLOYMENT_ID),
  };
}

module.exports = {
  REPOSITORY_ROOT,
  normalizeMetadataValue,
  readGitCommit,
  resolveRuntimeVersion,
};
