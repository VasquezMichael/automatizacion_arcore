const assert = require("assert/strict");
const { resolveRuntimeVersion } = require("./runtimeVersion");

function main() {
  let gitCalls = 0;
  const railway = resolveRuntimeVersion({
    env: {
      RAILWAY_GIT_COMMIT_SHA: "railway-sha",
      RAILWAY_GIT_BRANCH: "main",
      RAILWAY_DEPLOYMENT_ID: "deployment-1",
    },
    runGit: () => {
      gitCalls += 1;
      throw new Error("git should not run");
    },
  });
  assert.deepEqual(railway, {
    commitSha: "railway-sha",
    source: "RAILWAY_GIT_COMMIT_SHA",
    railwayBranch: "main",
    railwayDeploymentId: "deployment-1",
  });
  assert.equal(gitCalls, 0);
  console.log("OK 1. Railway SHA tiene prioridad y evita invocar git.");

  const generic = resolveRuntimeVersion({
    env: { APP_COMMIT_SHA: "app-sha", GIT_COMMIT_SHA: "git-env-sha" },
    runGit: () => {
      throw new Error("git should not run");
    },
  });
  assert.equal(generic.commitSha, "app-sha");
  assert.equal(generic.source, "APP_COMMIT_SHA");
  const genericGit = resolveRuntimeVersion({
    env: { GIT_COMMIT_SHA: "git-env-sha" },
    runGit: () => {
      throw new Error("git should not run");
    },
  });
  assert.equal(genericGit.commitSha, "git-env-sha");
  assert.equal(genericGit.source, "GIT_COMMIT_SHA");
  console.log("OK 2. APP_COMMIT_SHA y GIT_COMMIT_SHA funcionan como fallbacks de entorno.");

  let receivedArguments;
  const local = resolveRuntimeVersion({
    env: {},
    gitRef: "HEAD",
    runGit: (...args) => {
      receivedArguments = args;
      return "local-head-sha\n";
    },
  });
  assert.equal(local.commitSha, "local-head-sha");
  assert.equal(local.source, "GIT");
  assert.deepEqual(receivedArguments[1], ["rev-parse", "HEAD"]);
  console.log("OK 3. entorno local usa git HEAD cuando esta disponible.");

  const unavailable = resolveRuntimeVersion({
    env: {},
    runGit: () => {
      const error = new Error("not a git repository");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.deepEqual(unavailable, {
    commitSha: null,
    source: "UNAVAILABLE",
    railwayBranch: null,
    railwayDeploymentId: null,
  });
  console.log("OK 4. ausencia de git produce metadata nula sin fallar.");

  console.log("Resultado: OK. Resolucion de version runtime verificada.");
}

if (require.main === module) main();

module.exports = { main };
