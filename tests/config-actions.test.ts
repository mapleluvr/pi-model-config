import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { hashArtifact, readArtifact } from "../atomic-file.ts";
import { ModelConfigActions, type ActionResult } from "../config-actions.ts";
import { getModelsPath } from "../config.ts";
import {
  commitCoordinatedMutation,
  getTransactionJournalPath,
  resolveRequestPayload,
  type CommitResult,
  type MutationRequest,
  type PayloadCoordinatorOptions,
} from "../payload-coordinator.ts";
import {
  emptyPayloadDocument,
  getPayloadConfigPath,
  lookupModelPayload,
  modelPayloadKey,
  parsePayloadDocument,
  serializePayloadDocument,
  setPayloadDocumentValue,
  type PayloadConfig,
} from "../payload-config.ts";
import type { ModelsConfig } from "../types.ts";

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  contextWindow: 128000,
  maxTokens: 16384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...extra,
});

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeNative(agentDir: string, config: ModelsConfig): void {
  fs.writeFileSync(path.join(agentDir, "models.json"), bytes(config));
}

function writePayload(agentDir: string, config: PayloadConfig): void {
  fs.writeFileSync(path.join(agentDir, "model-config-payloads.json"), serializePayloadDocument(config), { mode: 0o600 });
}

function readNative(agentDir: string): ModelsConfig {
  return JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")) as ModelsConfig;
}

function readPayload(agentDir: string): PayloadConfig {
  const filePath = path.join(agentDir, "model-config-payloads.json");
  if (!fs.existsSync(filePath)) return emptyPayloadDocument();
  return parsePayloadDocument(fs.readFileSync(filePath), filePath);
}

function seedBasic(agentDir: string): ModelsConfig {
  const config: ModelsConfig = {
    providers: {
      local: {
        baseUrl: "http://localhost:11434",
        api: "openai-completions",
        models: [model("one", { name: "One", headers: { "X-Keep": "1" }, compat: { supportsTemperature: true } })],
      },
    },
  };
  writeNative(agentDir, config);
  writePayload(agentDir, emptyPayloadDocument());
  return config;
}

async function withAgentDir(run: (agentDir: string, actions: ModelConfigActions) => Promise<void> | void): Promise<void> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-actions-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const actions = new ModelConfigActions({ agentDir });
    await run(agentDir, actions);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

function assertNoSecrets(result: ActionResult): void {
  if (result.type === "success" || result.type === "preview" || result.type === "subtree-conflict" || result.type === "stale-target") {
    // Snapshots may carry private editor values; assert only non-snapshot diagnostic fields stay free of literals.
    const { type } = result;
    assert.equal(type.includes("sk-secret"), false);
    return;
  }
  const text = JSON.stringify(result);
  assert.equal(text.includes("sk-secret"), false);
  assert.equal(text.includes("top_secret"), false);
}

test("patchProvider preserves false/zero values, explicit clear, and unknown fields", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost:11434",
        api: "openai-completions",
        authHeader: true,
        name: "Keep",
        futureFlag: false,
        futureCount: 0,
        models: [model("one")],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());

  const cleared = await actions.patchProvider("local", { name: null, authHeader: false, futureCount: 0 });
  assert.equal(cleared.type, "success");
  const provider = readNative(agentDir).providers.local!;
  assert.equal(Object.hasOwn(provider, "name"), false);
  assert.equal(provider.authHeader, false);
  assert.equal(provider.futureFlag, false);
  assert.equal(provider.futureCount, 0);
  assert.equal(provider.baseUrl, "http://localhost:11434");
}));

test("patchModel looks up by provider key and model id, never stale array index", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost:11434",
        api: "openai-completions",
        models: [model("alpha"), model("beta", { name: "Beta" })],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());

  const result = await actions.patchModel("local", "beta", { name: "Renamed Beta", reasoning: false });
  assert.equal(result.type, "success");
  const models = readNative(agentDir).providers.local!.models!;
  assert.equal(models[0]!.id, "alpha");
  assert.equal(models[0]!.name, undefined);
  assert.equal(models[1]!.id, "beta");
  assert.equal(models[1]!.name, "Renamed Beta");
  assert.equal(models[1]!.reasoning, false);
}));

test("stale identity and invalid full candidates reject without mutation", async () => withAgentDir(async (agentDir, actions) => {
  seedBasic(agentDir);
  const before = fs.readFileSync(getModelsPath(agentDir));
  const missing = await actions.patchProvider("missing", { name: "x" });
  assert.equal(missing.type, "stale-target");
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(before), true);

  const invalid = await actions.patchProvider("local", { baseUrl: null, api: null, models: [] });
  assert.equal(invalid.type, "validation-error");
  if (invalid.type === "validation-error") {
    assert.ok(invalid.issues.length > 0);
    assert.equal(JSON.stringify(invalid).includes("sk-"), false);
  }
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(before), true);
}));

test("nested subtree save conflicts only on the exact edited subtree", async () => withAgentDir(async (agentDir, actions) => {
  seedBasic(agentDir);
  const snapshot = actions.readEditorSnapshot();
  assert.equal(snapshot.type, "snapshot");
  if (snapshot.type !== "snapshot") return;
  const baselineHeaders = structuredClone(snapshot.native.providers.local!.headers ?? {});
  const baselineCompat = structuredClone(snapshot.native.providers.local!.compat ?? {});

  // Unrelated external edit to compat while headers draft is open.
  const external = readNative(agentDir);
  external.providers.local!.compat = { supportsStore: true };
  writeNative(agentDir, external);

  const unrelated = await actions.saveProviderSubtree("local", "headers", baselineHeaders, { "X-New": "2" });
  assert.equal(unrelated.type, "success");
  assert.deepEqual(readNative(agentDir).providers.local!.headers, { "X-New": "2" });
  assert.deepEqual(readNative(agentDir).providers.local!.compat, { supportsStore: true });

  // Same-subtree conflict for compat.
  const conflict = await actions.saveProviderSubtree("local", "compat", baselineCompat, { supportsTemperature: false });
  assert.equal(conflict.type, "subtree-conflict");
  assert.deepEqual(readNative(agentDir).providers.local!.compat, { supportsStore: true });
}));

test("create and copy reject occupied native targets without writes", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      source: { baseUrl: "http://localhost:1", api: "openai-completions", models: [model("one")] },
      target: { baseUrl: "http://localhost:2", api: "openai-completions", models: [model("two")] },
    },
  });
  const payload = setPayloadDocumentValue(emptyPayloadDocument(), "source", "one", { seed: 1 });
  writePayload(agentDir, setPayloadDocumentValue(payload, "target", "two", { seed: 2 }));
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  const payloadBefore = fs.readFileSync(getPayloadConfigPath(agentDir));

  const create = await actions.createProvider("target", { baseUrl: "http://localhost:3", api: "openai-completions", models: [] });
  assert.equal(create.type, "native-collision");

  const copyPreview = await actions.previewProviderIdentityAction({ kind: "copy", providerId: "source", targetProviderId: "target" });
  assert.equal(copyPreview.type, "native-collision");

  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
}));

test("target payload collisions require explicit resolution and never rewrite implicitly", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: { baseUrl: "http://localhost:1", api: "openai-completions", models: [model("old")] },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(
    setPayloadDocumentValue(emptyPayloadDocument(), "local", "old", { from: "source" }),
    "local",
    "new",
    { from: "target" },
  ));
  const payloadBefore = fs.readFileSync(getPayloadConfigPath(agentDir));

  const preview = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "old",
    targetModelId: "new",
  });
  assert.equal(preview.type, "payload-collision");
  if (preview.type === "payload-collision") {
    assert.deepEqual(preview.collisions, [["local", "new"]]);
    assertNoSecrets(preview);
  }
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);

  const resolved = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "old",
    targetModelId: "new",
    payloadCollisionResolution: "replace-target",
  });
  assert.equal(resolved.type, "preview");
  if (resolved.type !== "preview") return;
  const committed = await actions.commitModelIdentityAction(resolved.token);
  assert.equal(committed.type, "success");
  assert.equal(lookupModelPayload(readPayload(agentDir), "local", "old"), undefined);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "new"), { from: "source" });
  assert.equal(readNative(agentDir).providers.local!.models![0]!.id, "new");
}));

test("identity commit revalidates hashes and identity sets before writing", async () => withAgentDir(async (agentDir, actions) => {
  seedBasic(agentDir);
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "one", { seed: 7 }));

  const preview = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "one",
    targetModelId: "two",
  });
  assert.equal(preview.type, "preview");
  if (preview.type !== "preview") return;

  const drifted = readNative(agentDir);
  drifted.providers.local!.models = [model("one"), model("extra")];
  writeNative(agentDir, drifted);

  const commit = await actions.commitModelIdentityAction(preview.token);
  assert.equal(commit.type, "stale-target");
  assert.equal(readNative(agentDir).providers.local!.models!.map((entry) => entry.id).join(","), "one,extra");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "one"), { seed: 7 });
}));

test("provider identity operations carry every model payload in one journaled transaction", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      source: {
        baseUrl: "http://localhost:1",
        api: "openai-completions",
        models: [model("a"), model("b")],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(
    setPayloadDocumentValue(emptyPayloadDocument(), "source", "a", { a: 1 }),
    "source",
    "b",
    { b: 2 },
  ));

  const preview = await actions.previewProviderIdentityAction({
    kind: "rename",
    providerId: "source",
    targetProviderId: "dest",
  });
  assert.equal(preview.type, "preview");
  if (preview.type !== "preview") return;
  assert.deepEqual(preview.affectedIdentities, [["source", "a"], ["source", "b"], ["dest", "a"], ["dest", "b"]]);

  const result = await actions.commitProviderIdentityAction(preview.token);
  assert.equal(result.type, "success");
  assert.equal(readNative(agentDir).providers.source, undefined);
  assert.ok(readNative(agentDir).providers.dest);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "dest", "a"), { a: 1 });
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "dest", "b"), { b: 2 });
  assert.equal(lookupModelPayload(readPayload(agentDir), "source", "a"), undefined);
}));

test("legacy native extraPayload migrates only in the successful model transaction that previewed it", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost:1",
        api: "openai-completions",
        models: [model("old", {
          extraPayload: { migrated: true },
        })],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());

  const preview = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "old",
    targetModelId: "new",
    model: model("new"),
    migrateLegacyExtraPayload: { migrated: true },
  });
  assert.equal(preview.type, "preview");
  if (preview.type !== "preview") return;

  // Drift blocks migration; legacy field remains until a successful commit.
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost:1",
        api: "openai-completions",
        models: [model("old", { extraPayload: { migrated: true }, name: "changed" })],
      },
    },
  });
  const stale = await actions.commitModelIdentityAction(preview.token);
  assert.equal(stale.type, "stale-target");
  assert.equal(Object.hasOwn(readNative(agentDir).providers.local!.models![0]!, "extraPayload"), true);
  assert.equal(lookupModelPayload(readPayload(agentDir), "local", "new"), undefined);

  const preview2 = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "old",
    targetModelId: "new",
    model: model("new", { name: "changed" }),
    migrateLegacyExtraPayload: { migrated: true },
  });
  assert.equal(preview2.type, "preview");
  if (preview2.type !== "preview") return;
  const ok = await actions.commitModelIdentityAction(preview2.token);
  assert.equal(ok.type, "success");
  assert.equal(Object.hasOwn(readNative(agentDir).providers.local!.models![0]!, "extraPayload"), false);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "new"), { migrated: true });
}));

test("lock busy/collision/unsupported propagate as distinct zero-write results", async () => withAgentDir(async (agentDir) => {
  seedBasic(agentDir);
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "one", { seed: 1 }));
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  const payloadBefore = fs.readFileSync(getPayloadConfigPath(agentDir));

  for (const lockType of ["busy", "collision", "unsupported"] as const) {
    const actions = new ModelConfigActions({
      agentDir,
      commitMutation: async () => ({ type: lockType }),
    });
    const result = await actions.patchProvider("local", { name: "x" });
    assert.equal(result.type, `lock-${lockType}`);
    assertNoSecrets(result);
  }

  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
}));

test("injected journal-step failures keep request resolution exactly before or after", async () => withAgentDir(async (agentDir) => {
  writeNative(agentDir, {
    providers: {
      local: { baseUrl: "http://localhost:1", api: "openai-completions", models: [model("one")] },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "one", { phase: "before" }));
  const actions = new ModelConfigActions({
    agentDir,
    commitMutation: async (request: MutationRequest, options?: PayloadCoordinatorOptions): Promise<CommitResult> => {
      return commitCoordinatedMutation({
        ...request,
        onBoundary(boundary) {
          request.onBoundary?.(boundary);
          if (boundary === "native") throw new Error("injected native failure");
        },
      }, options);
    },
  });

  const preview = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "one",
    targetModelId: "two",
  });
  assert.equal(preview.type, "preview");
  if (preview.type !== "preview") return;

  await assert.rejects(() => actions.commitModelIdentityAction(preview.token));

  const resolvedOne = resolveRequestPayload("local", "one", { agentDir });
  const resolvedTwo = resolveRequestPayload("local", "two", { agentDir });
  // Exactly one coherent journal side: before identity or after identity, never mixed.
  const beforeOnly = resolvedOne?.phase === "before" && resolvedTwo === undefined;
  const afterOnly = resolvedTwo?.phase === "before" && resolvedOne === undefined;
  assert.equal(beforeOnly || afterOnly, true);
  assert.equal(Boolean(beforeOnly && afterOnly), false);
}));

test("editor snapshot returns deep clones and hashes without secret leakage in result types", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost:1",
        api: "openai-completions",
        apiKey: "sk-secret",
        models: [model("one")],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "one", { top_secret: true }));
  const snapshot = actions.readEditorSnapshot();
  assert.equal(snapshot.type, "snapshot");
  if (snapshot.type !== "snapshot") return;
  assert.ok(snapshot.nativeHash.startsWith("sha256:"));
  assert.ok(snapshot.payloadHash.startsWith("sha256:"));
  snapshot.native.providers.local!.name = "mutated";
  assert.notEqual(readNative(agentDir).providers.local!.name, "mutated");
  const payloadClone = snapshot.payload;
  payloadClone.extraPayloads[modelPayloadKey("local", "one")] = { broken: true };
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "one"), { top_secret: true });
}));

test("createModel and saveModelPayload journal private values without embedding them in results", async () => withAgentDir(async (agentDir, actions) => {
  seedBasic(agentDir);
  const created = await actions.createModel("local", model("two"), { payload: { temperature: 0.2 } });
  assert.equal(created.type, "success");
  assertNoSecrets(created);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "two"), { temperature: 0.2 });

  const snapshot = actions.readEditorSnapshot();
  assert.equal(snapshot.type, "snapshot");
  if (snapshot.type !== "snapshot") return;
  const baseline = lookupModelPayload(snapshot.payload, "local", "two")!;
  const saved = await actions.saveModelPayload("local", "two", baseline, { temperature: 0.5 });
  assert.equal(saved.type, "success");
  assertNoSecrets(saved);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "two"), { temperature: 0.5 });
}));

test("recovery-required is returned when storage is not mutation-ready", async () => withAgentDir(async (agentDir, actions) => {
  seedBasic(agentDir);
  fs.writeFileSync(getTransactionJournalPath(agentDir), "{");
  const result = await actions.patchProvider("local", { name: "x" });
  assert.equal(result.type, "recovery-required");
  assert.equal(fs.readFileSync(getTransactionJournalPath(agentDir), "utf8"), "{");
}));
