import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OLD_AZURE_PROVIDER_ID,
  NEW_AZURE_PROVIDER_ID,
  planAzureProviderMigration,
  applyAzureProviderMigration,
} from "../../azure-migration.ts";

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const results = {};

// Case 1
{
  const agentDir = createTempDir("rev-case1-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const settingsPath = path.join(agentDir, "settings.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "m" }] } }
    }, null, 2));

    const plan = planAzureProviderMigration({ agentDir });
    const planChangesPaths = plan.changes.map(c => c.path);

    // Concurrently create settings.json with collision
    fs.writeFileSync(settingsPath, JSON.stringify({
      modelThinkingLevels: {
        [`${OLD_AZURE_PROVIDER_ID}/m`]: "low",
        [`${NEW_AZURE_PROVIDER_ID}/m`]: "high",
      }
    }, null, 2));

    const applyResult = await applyAzureProviderMigration({ agentDir }, plan);
    const postSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

    results.case1 = {
      planStatus: plan.status,
      planChangesIncludeSettings: planChangesPaths.includes(settingsPath),
      applyStatus: applyResult.status,
      applyError: applyResult.error,
      applyWrittenFiles: applyResult.writtenFiles,
      postSettingsThinkingLevels: postSettings.modelThinkingLevels,
      silentOverwriteObserved: postSettings.modelThinkingLevels[`${NEW_AZURE_PROVIDER_ID}/m`] === "low",
    };
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

// Case 2
{
  const agentDir = createTempDir("rev-case2-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const settingsPath = path.join(agentDir, "settings.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "m" }] } }
    }, null, 2));

    fs.writeFileSync(settingsPath, JSON.stringify({
      subagents: {
        agentOverridesByProvider: {
          openai: {
            worker: {
              model: `${OLD_AZURE_PROVIDER_ID}/m`,
              defaultProvider: OLD_AZURE_PROVIDER_ID,
            }
          }
        }
      }
    }, null, 2));

    const plan = planAzureProviderMigration({ agentDir });
    const applyResult = await applyAzureProviderMigration({ agentDir }, plan);
    const postSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const workerOverride = postSettings?.subagents?.agentOverridesByProvider?.openai?.worker;

    results.case2 = {
      planStatus: plan.status,
      migratedSubagentsCount: plan.migratedSubagentsCount,
      applyStatus: applyResult.status,
      workerOverridePostMigration: workerOverride,
      modelRemainedOld: workerOverride?.model === `${OLD_AZURE_PROVIDER_ID}/m`,
      defaultProviderRemainedOld: workerOverride?.defaultProvider === OLD_AZURE_PROVIDER_ID,
    };
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

// Case 3
{
  const agentDir = createTempDir("rev-case3-");
  const SENTINEL = "SYNTHETIC_SECRET_SENTINEL";
  try {
    const modelsPath = path.join(agentDir, "models.json");
    fs.writeFileSync(modelsPath, `{ "key": ${SENTINEL} }`, "utf8");

    const plan = planAzureProviderMigration({ agentDir });
    const applyResult = await applyAzureProviderMigration({ agentDir }, plan);

    const planReasonContainsSentinel = Boolean(plan.conflictReason && plan.conflictReason.includes(SENTINEL));
    const applyErrorContainsSentinel = Boolean(applyResult.error && applyResult.error.includes(SENTINEL));

    results.case3 = {
      planStatus: plan.status,
      planConflictReason: plan.conflictReason,
      applyStatus: applyResult.status,
      applyError: applyResult.error,
      planReasonContainsSentinel,
      applyErrorContainsSentinel,
      sentinelLeakedInErrorMessage: planReasonContainsSentinel || applyErrorContainsSentinel,
    };
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

fs.writeFileSync("docs/research/reviewer-boundary-results.json", JSON.stringify(results, null, 2));
process.stdout.write(JSON.stringify(results, null, 2) + "\n");
