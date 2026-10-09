import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OLD_AZURE_PROVIDER_ID,
  NEW_AZURE_PROVIDER_ID,
  planAzureProviderMigration,
  applyAzureProviderMigration,
} from "../../azure-migration.ts";
import { ModelConfigActions } from "../../config-actions.ts";
import { runModelEditor } from "../../model-editor.ts";
import { tryAcquireMutationLock } from "../../process-lock.ts";
import { readModelsConfig } from "../../config.ts";

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let priorResults = {};
try {
  priorResults = JSON.parse(fs.readFileSync("docs/research/reviewer-boundary-results.json", "utf8"));
} catch {
  priorResults = {};
}

// Case A: Model editor retained draft overwrite on conflict
let caseAResult;
{
  const agentDir = createTempDir("rev-caseA-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: {
        openai: {
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          models: [{ id: "m" }],
        },
      },
    }, null, 2));

    const actions = new ModelConfigActions({ agentDir });

    // Panel step sequences
    // Turn 1: open capability -> promptCache
    // In promptCache: select "short (秒) = (未设置)" -> "设置秒数" -> input "300" -> "保存并返回"
    // Just before actions.saveModelSubtree is called by runModelEditor, we can simulate external mutation
    // In our custom openPanel mock:
    let turn = 0;
    const notifications = [];
    const ui = {
      select: async (title, options) => {
        if (title.includes("Model Prompt Cache - short")) return "设置秒数";
        if (title.includes("Model Prompt Cache")) {
          turn += 1;
          if (turn === 1) return options[0]; // "short (秒) = ..."
          return "保存并返回";
        }
        return options[0];
      },
      input: async (title) => {
        if (title.includes("short")) return "300";
        return undefined;
      },
      editor: async () => undefined,
      notify: (msg) => notifications.push(msg),
    };

    let panelTurns = 0;
    const openPanelMock = async (_ctx, _descriptor, state) => {
      panelTurns += 1;
      if (panelTurns === 1) {
        // First entry: user clicks promptCache
        // Simulate external mutation before or during this save
        const currentDoc = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
        currentDoc.providers.openai.models[0].promptCache = { long: 3600 };
        fs.writeFileSync(modelsPath, JSON.stringify(currentDoc, null, 2));

        return {
          type: "field",
          categoryId: "capability",
          fieldId: "promptCache",
          state: { ...state, categoryId: "capability", fieldId: "promptCache" },
        };
      }
      if (panelTurns === 2) {
        // User re-enters promptCache to save the retained draft
        return {
          type: "field",
          categoryId: "capability",
          fieldId: "promptCache",
          state: { ...state, categoryId: "capability", fieldId: "promptCache" },
        };
      }
      return { type: "back", state };
    };

    const ctx = { ui };
    await runModelEditor(ctx, "openai", "m", {
      actions,
      openPanel: openPanelMock,
    });

    const finalDoc = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    const finalPromptCache = finalDoc.providers.openai.models[0].promptCache;

    caseAResult = {
      finalPromptCache,
      externalLongLost: finalPromptCache?.long === undefined,
      onlyShortSaved: finalPromptCache?.short === 300,
      notifications,
    };
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

// Case B: Legal JSONC models.json with comments and trailing commas
let caseBResult;
{
  const agentDir = createTempDir("rev-caseB-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const jsoncContent = `// Top comment
{
  "providers": {
    /* provider comment */
    "${OLD_AZURE_PROVIDER_ID}": {
      "baseUrl": "https://example.invalid/v1",
      "api": "azure-openai-responses",
      "models": [
        { "id": "m", }, // trailing comma
      ],
    },
  },
}
`;
    fs.writeFileSync(modelsPath, jsoncContent, "utf8");

    const readModelsConfigResult = readModelsConfig(modelsPath);
    const plan = planAzureProviderMigration({ agentDir });

    caseBResult = {
      readModelsConfigLoaded: Boolean(readModelsConfigResult && readModelsConfigResult.providers?.[OLD_AZURE_PROVIDER_ID]),
      planStatus: plan.status,
      planConflictReason: plan.conflictReason,
      planRejectedLegalJsonc: plan.status === "conflict" && plan.conflictReason.includes("格式损坏"),
    };
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

// Case C: settings contains compaction.modelOverrides['azure-openai-responses/m']
let caseCResult;
{
  const agentDir = createTempDir("rev-caseC-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const settingsPath = path.join(agentDir, "settings.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "m" }] } },
    }));
    fs.writeFileSync(settingsPath, JSON.stringify({
      compaction: {
        modelOverrides: {
          [`${OLD_AZURE_PROVIDER_ID}/m`]: { reserveTokens: 50000 },
        },
      },
    }));

    const plan = planAzureProviderMigration({ agentDir });
    const applyResult = await applyAzureProviderMigration({ agentDir }, plan);
    const postSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const postCompaction = postSettings?.compaction?.modelOverrides;

    caseCResult = {
      planStatus: plan.status,
      applyStatus: applyResult.status,
      compactionModelOverrides: postCompaction,
      oldKeyPreservedUnmigrated: Boolean(postCompaction?.[`${OLD_AZURE_PROVIDER_ID}/m`]),
      newKeyCreated: Boolean(postCompaction?.[`${NEW_AZURE_PROVIDER_ID}/m`]),
    };
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

// Case D: Mutation lock held & pending transaction journal presence
let caseDResult;
{
  const agentDir = createTempDir("rev-caseD-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const journalPath = path.join(agentDir, "model-config-transaction.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "m" }] } },
    }));

    // Plant pending uncommitted transaction journal
    fs.writeFileSync(journalPath, JSON.stringify({
      version: 1,
      operationId: "pending-op",
      nativeBeforeHash: "a",
      nativeAfterHash: "b",
    }));

    // Acquire live OS IPC lock
    const lockHandle = await tryAcquireMutationLock(agentDir);

    const plan = planAzureProviderMigration({ agentDir });
    const applyResult = await applyAzureProviderMigration({ agentDir }, plan);

    const postModels = JSON.parse(fs.readFileSync(modelsPath, "utf8"));

    caseDResult = {
      lockAcquiredByTest: lockHandle.type === "acquired",
      applyStatusWhileLockHeld: applyResult.status,
      applyBypassedLock: applyResult.status === "success" && (NEW_AZURE_PROVIDER_ID in postModels.providers),
      pendingJournalChecked: false, // journal was present and completely ignored
      journalStillExists: fs.existsSync(journalPath),
    };

    if (lockHandle.type === "acquired") {
      await lockHandle.handle.release();
    }
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

const fullResults = {
  ...priorResults,
  caseA: caseAResult,
  caseB: caseBResult,
  caseC: caseCResult,
  caseD: caseDResult,
};

fs.writeFileSync("docs/research/reviewer-boundary-results.json", JSON.stringify(fullResults, null, 2));
process.stdout.write(JSON.stringify({ caseA: caseAResult, caseB: caseBResult, caseC: caseCResult, caseD: caseDResult }, null, 2) + "\n");
