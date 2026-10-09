import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OLD_AZURE_PROVIDER_ID,
  NEW_AZURE_PROVIDER_ID,
  AZURE_MIGRATION_JOURNAL_FILE,
  getAzureMigrationJournalPath,
  planAzureProviderMigration,
  applyAzureProviderMigration,
} from "../azure-migration.ts";
import { tryAcquireMutationLock } from "../process-lock.ts";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("Azure migration: plans and applies clean multi-file migration idempotently", async () => {
  const agentDir = createTempDir("azure-test-agent-");
  const projectDir = createTempDir("azure-test-project-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const payloadsPath = path.join(agentDir, "model-config-payloads.json");
    const userSettingsPath = path.join(agentDir, "settings.json");
    const projectSettingsDir = path.join(projectDir, ".pi");
    fs.mkdirSync(projectSettingsDir, { recursive: true });
    const projectSettingsPath = path.join(projectSettingsDir, "settings.json");
    fs.writeFileSync(projectSettingsPath, JSON.stringify({
      defaultProvider: OLD_AZURE_PROVIDER_ID,
    }, null, 2));
    const authPath = path.join(agentDir, "auth.json");

    // Seed test fixtures
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: {
        [OLD_AZURE_PROVIDER_ID]: {
          baseUrl: "https://example.invalid/openai/v1",
          models: [{ id: "gpt-4o" }],
        },
      },
    }, null, 2));

    fs.writeFileSync(payloadsPath, JSON.stringify({
      version: 1,
      extraPayloads: {
        [JSON.stringify([OLD_AZURE_PROVIDER_ID, "gpt-4o"])]: { custom: "payload" },
      },
    }, null, 2));

    fs.writeFileSync(userSettingsPath, JSON.stringify({
      defaultProvider: OLD_AZURE_PROVIDER_ID,
      enabledModels: [`${OLD_AZURE_PROVIDER_ID}/gpt-4o`, "anthropic/claude-3-7-sonnet"],
      modelThinkingLevels: { [`${OLD_AZURE_PROVIDER_ID}/gpt-4o`]: "high" },
      compaction: {
        modelOverrides: {
          [`${OLD_AZURE_PROVIDER_ID}/gpt-4o`]: { reserveTokens: 40000 },
        },
      },
      subagents: {
        agentOverrides: {
          worker: { model: `${OLD_AZURE_PROVIDER_ID}/gpt-4o`, defaultProvider: OLD_AZURE_PROVIDER_ID },
        },
        agentOverridesByProvider: {
          [OLD_AZURE_PROVIDER_ID]: {
            worker: { model: `${OLD_AZURE_PROVIDER_ID}/gpt-4o` },
          },
          openai: {
            reviewer: { model: `${OLD_AZURE_PROVIDER_ID}/gpt-4o`, defaultProvider: OLD_AZURE_PROVIDER_ID },
          },
        },
      },
    }, null, 2));

    fs.writeFileSync(authPath, JSON.stringify({
      [OLD_AZURE_PROVIDER_ID]: { apiKey: "secret-key" },
    }, null, 2));

    // 1. Plan
    const plan = planAzureProviderMigration({ agentDir, projectDir });
    assert.equal(plan.status, "ready");
    assert.equal(plan.migratedModelsCount, 1);
    assert.equal(plan.migratedPayloadsCount, 1);
    assert.ok(plan.changes.length >= 3);

    // 2. Apply dry run
    const dryRunResult = await applyAzureProviderMigration({ agentDir, projectDir, dryRun: true });
    assert.equal(dryRunResult.status, "success");
    assert.equal(dryRunResult.writtenFiles.length, 0);

    // 3. Apply real migration
    const result = await applyAzureProviderMigration({ agentDir, projectDir });
    assert.equal(result.status, "success");
    assert.ok(result.writtenFiles.length >= 3);

    // Verify models.json
    const updatedModels = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    assert.equal(OLD_AZURE_PROVIDER_ID in updatedModels.providers, false);
    assert.equal(NEW_AZURE_PROVIDER_ID in updatedModels.providers, true);
    assert.equal(updatedModels.providers[NEW_AZURE_PROVIDER_ID].models[0].id, "gpt-4o");

    // Verify payloads
    const updatedPayloads = JSON.parse(fs.readFileSync(payloadsPath, "utf8"));
    const oldKey = JSON.stringify([OLD_AZURE_PROVIDER_ID, "gpt-4o"]);
    const newKey = JSON.stringify([NEW_AZURE_PROVIDER_ID, "gpt-4o"]);
    assert.equal(oldKey in updatedPayloads.extraPayloads, false);
    assert.equal(newKey in updatedPayloads.extraPayloads, true);

    // Verify settings
    const updatedSettings = JSON.parse(fs.readFileSync(userSettingsPath, "utf8"));
    assert.equal(updatedSettings.defaultProvider, NEW_AZURE_PROVIDER_ID);
    assert.deepEqual(updatedSettings.enabledModels, [`${NEW_AZURE_PROVIDER_ID}/gpt-4o`, "anthropic/claude-3-7-sonnet"]);
    assert.equal(updatedSettings.modelThinkingLevels[`${NEW_AZURE_PROVIDER_ID}/gpt-4o`], "high");
    assert.equal(`${OLD_AZURE_PROVIDER_ID}/gpt-4o` in updatedSettings.modelThinkingLevels, false);

    // Verify compaction.modelOverrides (P1-4)
    assert.equal(updatedSettings.compaction.modelOverrides[`${NEW_AZURE_PROVIDER_ID}/gpt-4o`].reserveTokens, 40000);
    assert.equal(`${OLD_AZURE_PROVIDER_ID}/gpt-4o` in updatedSettings.compaction.modelOverrides, false);

    // Verify subagents including other provider groups (P1-4)
    const subagents = updatedSettings.subagents;
    assert.equal(subagents.agentOverrides.worker.model, `${NEW_AZURE_PROVIDER_ID}/gpt-4o`);
    assert.equal(subagents.agentOverrides.worker.defaultProvider, NEW_AZURE_PROVIDER_ID);
    assert.equal(OLD_AZURE_PROVIDER_ID in subagents.agentOverridesByProvider, false);
    assert.equal(NEW_AZURE_PROVIDER_ID in subagents.agentOverridesByProvider, true);
    assert.equal(subagents.agentOverridesByProvider[NEW_AZURE_PROVIDER_ID].worker.model, `${NEW_AZURE_PROVIDER_ID}/gpt-4o`);
    assert.equal(subagents.agentOverridesByProvider.openai.reviewer.model, `${NEW_AZURE_PROVIDER_ID}/gpt-4o`);
    assert.equal(subagents.agentOverridesByProvider.openai.reviewer.defaultProvider, NEW_AZURE_PROVIDER_ID);

    // Verify auth.json untouched
    const authContent = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.equal(OLD_AZURE_PROVIDER_ID in authContent, true);

    // 4. Idempotency: second run is no-op
    const secondPlan = planAzureProviderMigration({ agentDir, projectDir });
    assert.equal(secondPlan.status, "no-op");
    const secondResult = await applyAzureProviderMigration({ agentDir, projectDir });
    assert.equal(secondResult.status, "no-op");
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("Azure migration: supports legal JSONC models.json with comments and trailing commas (P1-6)", async () => {
  const agentDir = createTempDir("azure-jsonc-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    fs.writeFileSync(modelsPath, `// legal JSONC comment
{
  "providers": {
    "${OLD_AZURE_PROVIDER_ID}": {
      "baseUrl": "https://example.invalid/v1",
      "models": [
        { "id": "m", }, // trailing comma
      ],
    },
  },
}
`, "utf8");

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "ready");
    assert.equal(plan.migratedModelsCount, 1);

    const result = await applyAzureProviderMigration({ agentDir }, plan);
    assert.equal(result.status, "success");
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: aborts fail-closed on target collision in models.json", async () => {
  const agentDir = createTempDir("azure-conflict-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: {
        [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "model-1" }] },
        [NEW_AZURE_PROVIDER_ID]: { models: [{ id: "model-2" }] },
      },
    }, null, 2));

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "conflict");
    assert.match(plan.conflictReason!, /同时存在/);

    const result = await applyAzureProviderMigration({ agentDir });
    assert.equal(result.status, "aborted");
    assert.equal(result.writtenFiles.length, 0);

    // File untouched
    const untouched = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    assert.equal(OLD_AZURE_PROVIDER_ID in untouched.providers, true);
    assert.equal(NEW_AZURE_PROVIDER_ID in untouched.providers, true);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: aborts fail-closed on target collision in model-config-payloads.json", async () => {
  const agentDir = createTempDir("azure-payload-conflict-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const payloadsPath = path.join(agentDir, "model-config-payloads.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "gpt-4o" }] } },
    }));
    fs.writeFileSync(payloadsPath, JSON.stringify({
      version: 1,
      extraPayloads: {
        [JSON.stringify([OLD_AZURE_PROVIDER_ID, "gpt-4o"])]: { old: true },
        [JSON.stringify([NEW_AZURE_PROVIDER_ID, "gpt-4o"])]: { existing: true },
      },
    }));

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "conflict");
    assert.match(plan.conflictReason!, /已存在目标 key/);

    const result = await applyAzureProviderMigration({ agentDir });
    assert.equal(result.status, "aborted");
    assert.equal(result.writtenFiles.length, 0);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: aborts fail-closed on target collision in settings agentOverridesByProvider", async () => {
  const agentDir = createTempDir("azure-settings-conflict-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const settingsPath = path.join(agentDir, "settings.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "gpt-4o" }] } },
    }));
    fs.writeFileSync(settingsPath, JSON.stringify({
      subagents: {
        agentOverridesByProvider: {
          [OLD_AZURE_PROVIDER_ID]: { worker: { model: "m1" } },
          [NEW_AZURE_PROVIDER_ID]: { worker: { model: "m2" } },
        },
      },
    }));

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "conflict");
    assert.match(plan.conflictReason!, /agentOverridesByProvider 已存在目标提供商/);

    const result = await applyAzureProviderMigration({ agentDir });
    assert.equal(result.status, "aborted");
    assert.equal(result.writtenFiles.length, 0);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: aborts fail-closed on malformed JSON without leaking source tokens (P1-7)", async () => {
  const agentDir = createTempDir("azure-malformed-");
  const SENTINEL = "SYNTHETIC_SECRET_TOKEN";
  try {
    const modelsPath = path.join(agentDir, "models.json");
    fs.writeFileSync(modelsPath, `{ "invalid": ${SENTINEL} }`, "utf8");

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "conflict");
    assert.match(plan.conflictReason!, /语法错误/);
    assert.equal(plan.conflictReason!.includes(SENTINEL), false, "must not leak source tokens");

    const result = await applyAzureProviderMigration({ agentDir });
    assert.equal(result.status, "aborted");
    assert.equal(result.error!.includes(SENTINEL), false, "must not leak source tokens");
    assert.equal(result.writtenFiles.length, 0);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: aborts on concurrent modification (expectedHash mismatch)", async () => {
  const agentDir = createTempDir("azure-hash-mismatch-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "gpt-4o" }] } },
    }, null, 2));

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "ready");

    // Concurrently mutate the file before apply
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "gpt-4o-concurrent" }] } },
    }, null, 2));

    const result = await applyAzureProviderMigration({ agentDir }, plan);
    assert.equal(result.status, "aborted");
    assert.match(result.error!, /hash mismatch/);
    assert.equal(result.writtenFiles.length, 0);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: aborts when mutation lock is busy (P1-2)", async () => {
  const agentDir = createTempDir("azure-lock-busy-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "gpt-4o" }] } },
    }, null, 2));

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "ready");

    const lockHandle = await tryAcquireMutationLock(agentDir);
    assert.equal(lockHandle.type, "acquired");

    try {
      const result = await applyAzureProviderMigration({ agentDir }, plan);
      assert.equal(result.status, "aborted");
      assert.match(result.error!, /互斥锁|忙/);
      assert.equal(result.writtenFiles.length, 0);
    } finally {
      await lockHandle.handle.release();
    }
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: aborts on pending transaction journal (P1-2)", async () => {
  const agentDir = createTempDir("azure-pending-journal-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const journalPath = path.join(agentDir, "model-config-transaction.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "gpt-4o" }] } },
    }, null, 2));
    fs.writeFileSync(journalPath, JSON.stringify({
      version: 1,
      operationId: "pending",
      nativeBeforeHash: "a",
      nativeAfterHash: "b",
    }));

    const plan = planAzureProviderMigration({ agentDir });
    const result = await applyAzureProviderMigration({ agentDir }, plan);
    assert.equal(result.status, "aborted");
    assert.match(result.error!, /未决事务日志/);
    assert.equal(result.writtenFiles.length, 0);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: aborts when absent file is created after plan (P1-1)", async () => {
  const agentDir = createTempDir("azure-unplanned-create-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const settingsPath = path.join(agentDir, "settings.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "m" }] } },
    }, null, 2));

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "ready");

    // Concurrently create settings.json after plan
    fs.writeFileSync(settingsPath, JSON.stringify({
      modelThinkingLevels: { [`${OLD_AZURE_PROVIDER_ID}/m`]: "low" },
    }, null, 2));

    const result = await applyAzureProviderMigration({ agentDir }, plan);
    assert.equal(result.status, "aborted");
    assert.match(result.error!, /外部并发创建/);
    assert.equal(result.writtenFiles.length, 0);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: aborts when previously unchanged file drifts after plan (P1-1 drift detection)", async () => {
  const agentDir = createTempDir("azure-unchanged-drift-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const settingsPath = path.join(agentDir, "settings.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "m" }] } },
    }, null, 2));
    // settings exists but is empty / requires no changes
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2));

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "ready");
    assert.equal(plan.changes.some((c) => c.path === settingsPath), false);

    // Concurrently write old Azure defaultProvider to settings.json
    fs.writeFileSync(settingsPath, JSON.stringify({ defaultProvider: OLD_AZURE_PROVIDER_ID }, null, 2));

    const result = await applyAzureProviderMigration({ agentDir }, plan);
    assert.equal(result.status, "aborted");
    assert.match(result.error!, /hash mismatch/);
    assert.equal(result.writtenFiles.length, 0);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: safely rejects null root JSON without throwing TypeError (P1-6)", async () => {
  const agentDir = createTempDir("azure-null-json-");
  try {
    const settingsPath = path.join(agentDir, "settings.json");
    fs.writeFileSync(settingsPath, "null", "utf8");

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "conflict");
    assert.match(plan.conflictReason!, /根节点必须为对象/);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: migrates legacy slash-format payload keys and prevents collisions (P1-5)", async () => {
  const agentDir = createTempDir("azure-slash-payload-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const payloadsPath = path.join(agentDir, "model-config-payloads.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "gpt-4o" }] } },
    }, null, 2));
    fs.writeFileSync(payloadsPath, JSON.stringify({
      version: 1,
      extraPayloads: {
        [`${OLD_AZURE_PROVIDER_ID}/gpt-4o`]: { custom: "slash" },
      },
    }, null, 2));

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "ready");
    assert.equal(plan.migratedPayloadsCount, 1);

    const result = await applyAzureProviderMigration({ agentDir }, plan);
    assert.equal(result.status, "success");

    const updated = JSON.parse(fs.readFileSync(payloadsPath, "utf8"));
    assert.equal(`${OLD_AZURE_PROVIDER_ID}/gpt-4o` in updated.extraPayloads, false);
    assert.equal(`${NEW_AZURE_PROVIDER_ID}/gpt-4o` in updated.extraPayloads, true);
    assert.deepEqual(updated.extraPayloads[`${NEW_AZURE_PROVIDER_ID}/gpt-4o`], { custom: "slash" });
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: cleans up migration journal upon complete migration (P1-3)", async () => {
  const agentDir = createTempDir("azure-journal-clean-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "m" }] } },
    }, null, 2));

    const plan = planAzureProviderMigration({ agentDir });
    const result = await applyAzureProviderMigration({ agentDir }, plan);
    assert.equal(result.status, "success");

    const journalPath = getAzureMigrationJournalPath(agentDir);
    assert.equal(fs.existsSync(journalPath), false, "journal must be deleted on success");
    assert.equal(AZURE_MIGRATION_JOURNAL_FILE, "azure-migration-journal.json");
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: preserves canonical tuple format for tuple keys with leading JSON whitespace and slash in model ID (P1)", async () => {
  const agentDir = createTempDir("azure-ws-tuple-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const payloadsPath = path.join(agentDir, "model-config-payloads.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "model/with/slash" }] } },
    }, null, 2));
    // Valid JSON tuple with leading whitespace
    const wsTupleKey = `   ["${OLD_AZURE_PROVIDER_ID}", "model/with/slash"]`;
    fs.writeFileSync(payloadsPath, JSON.stringify({
      version: 1,
      extraPayloads: {
        [wsTupleKey]: { preserve: true },
      },
    }, null, 2));

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "ready");
    assert.equal(plan.migratedPayloadsCount, 1);

    const result = await applyAzureProviderMigration({ agentDir }, plan);
    assert.equal(result.status, "success");

    const updated = JSON.parse(fs.readFileSync(payloadsPath, "utf8"));
    const expectedCanonicalTuple = JSON.stringify([NEW_AZURE_PROVIDER_ID, "model/with/slash"]);
    assert.equal(expectedCanonicalTuple in updated.extraPayloads, true);
    assert.equal("azure/model/with/slash" in updated.extraPayloads, false, "must not degrade to slash format");
    assert.deepEqual(updated.extraPayloads[expectedCanonicalTuple], { preserve: true });
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: fails closed when leftover migration journal exists even if plan is no-op (P2)", async () => {
  const agentDir = createTempDir("azure-noop-journal-");
  try {
    const journalPath = getAzureMigrationJournalPath(agentDir);
    fs.writeFileSync(journalPath, JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      files: [],
    }));

    const plan = planAzureProviderMigration({ agentDir });
    assert.equal(plan.status, "no-op");

    const result = await applyAzureProviderMigration({ agentDir }, plan);
    assert.equal(result.status, "aborted");
    assert.match(result.error!, /未完成的迁移日志/);
    assert.equal(result.writtenFiles.length, 0);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: aborts fail-closed when multiple source keys map to same target model (in-batch payload collision)", async () => {
  const agentDir = createTempDir("azure-batch-payload-conflict-");
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
    assert.equal(plan.status, "conflict");
    assert.match(plan.conflictReason!, /批内目标冲突/);

    const result = await applyAzureProviderMigration({ agentDir }, plan);
    assert.equal(result.status, "aborted");
    assert.equal(result.writtenFiles.length, 0);

    // Assert files kept completely untouched
    const untouchedPayloads = JSON.parse(fs.readFileSync(payloadsPath, "utf8"));
    assert.equal(canonicalKey in untouchedPayloads.extraPayloads, true);
    assert.equal(wsKey in untouchedPayloads.extraPayloads, true);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Azure migration: aborts fail-closed and preserves journal when journal appears during lock acquisition", async () => {
  const agentDir = createTempDir("azure-inflight-journal-");
  try {
    const modelsPath = path.join(agentDir, "models.json");
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [OLD_AZURE_PROVIDER_ID]: { models: [{ id: "m" }] } },
    }, null, 2));

    const journalPath = getAzureMigrationJournalPath(agentDir);
    const sentinelContent = JSON.stringify({ version: 1, plantedInFlight: true }, null, 2);

    const promise = applyAzureProviderMigration({ agentDir });
    fs.writeFileSync(journalPath, sentinelContent, "utf8");

    const result = await promise;
    assert.equal(result.status, "aborted");
    assert.match(result.error!, /未完成的迁移日志/);
    assert.equal(result.writtenFiles.length, 0);
    assert.equal(fs.existsSync(journalPath), true, "journal must not be deleted");
    assert.equal(fs.readFileSync(journalPath, "utf8"), sentinelContent, "journal content must be preserved untouched");
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
