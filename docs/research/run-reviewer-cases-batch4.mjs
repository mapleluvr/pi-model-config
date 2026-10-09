import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OLD_AZURE_PROVIDER_ID,
  NEW_AZURE_PROVIDER_ID,
  getAzureMigrationJournalPath,
  planAzureProviderMigration,
  applyAzureProviderMigration,
} from "../../azure-migration.ts";
import { lookupModelPayload } from "../../payload-config.ts";

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const results = {};

// Test 1: Calling applyAzureProviderMigration, then synchronously creating migration journal before await resolves
{
  const agentDir = createTempDir("rev4-case1-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "m" }] } },
    }, null, 2));

    const journalPath = getAzureMigrationJournalPath(agentDir);

    // Call apply, then synchronously plant journal before awaiting
    const promise = applyAzureProviderMigration({ agentDir });
    fs.writeFileSync(journalPath, JSON.stringify({
      version: 1,
      plantedWhileInFlight: true,
    }, null, 2));

    const applyResult = await promise;

    results.case1 = {
      applyStatus: applyResult.status,
      applySuccess: applyResult.status === "success",
      journalStillExists: fs.existsSync(journalPath),
      journalDeletedByApply: !fs.existsSync(journalPath),
    };
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

// Test 2: Same model/with/slash has canonical old tuple and whitespace old tuple
{
  const agentDir = createTempDir("rev4-case2-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const payloadsPath = path.join(agentDir, "model-config-payloads.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "model/with/slash" }] } },
    }, null, 2));

    const canonicalKey = JSON.stringify([OLD_AZURE_PROVIDER_ID, "model/with/slash"]);
    const wsKey = `   ["${OLD_AZURE_PROVIDER_ID}", "model/with/slash"]`;

    fs.writeFileSync(payloadsPath, JSON.stringify({
      version: 1,
      extraPayloads: {
        [canonicalKey]: { source: "canonical" },
        [wsKey]: { source: "whitespace" },
      },
    }, null, 2));

    const plan = planAzureProviderMigration({ agentDir });
    const applyResult = await applyAzureProviderMigration({ agentDir }, plan);

    const postPayloads = JSON.parse(fs.readFileSync(payloadsPath, "utf8"));
    const lookedUp = lookupModelPayload(postPayloads, NEW_AZURE_PROVIDER_ID, "model/with/slash");

    results.case2 = {
      planStatus: plan.status,
      applyStatus: applyResult.status,
      canonicalOverwrittenByWhitespace: lookedUp?.source === "whitespace",
      finalLookupSource: lookedUp?.source,
    };
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

fs.writeFileSync("docs/research/reviewer-round4-results.json", JSON.stringify(results, null, 2), "utf8");
console.log(JSON.stringify(results, null, 2));
