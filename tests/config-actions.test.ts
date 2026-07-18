import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
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

function seedBasic(agentDir: string): void {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost:11434",
        api: "openai-completions",
        models: [model("one", { name: "One", headers: { "X-Keep": "1" }, compat: { supportsTemperature: true } })],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());
}

const SECRET_MARKERS = ["sk-secret", "top_secret", "extraPayload", "\"temperature\"", "\"phase\""];

function assertDiagnosticSecretFree(result: ActionResult): void {
  if (result.type === "success") return;
  // Never put serialized diagnostics into assertion messages (may contain private values).
  const text = JSON.stringify(result);
  for (const marker of SECRET_MARKERS) {
    const leaked = text.includes(marker);
    assert.equal(leaked, false, `diagnostic result type=${result.type} leaked marker`);
  }
  assert.equal(Object.hasOwn(result as object, "snapshot"), false, `type=${result.type} snapshot flag`);
  assert.equal(Object.hasOwn(result as object, "native"), false, `type=${result.type} native flag`);
  assert.equal(Object.hasOwn(result as object, "payload"), false, `type=${result.type} payload flag`);
  if (result.type === "preview") {
    assert.equal(typeof result.token, "string", "preview token type");
    assert.equal(Object.hasOwn(result.descriptor as object, "request"), false, "descriptor request flag");
    assert.equal(Object.hasOwn(result as object, "request"), false, "result request flag");
  }
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
}));

test("stale identity and invalid full candidates reject without mutation", async () => withAgentDir(async (agentDir, actions) => {
  seedBasic(agentDir);
  const before = fs.readFileSync(getModelsPath(agentDir));
  const missing = await actions.patchProvider("missing", { name: "x" });
  assert.equal(missing.type, "stale-target");
  assertDiagnosticSecretFree(missing);
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(before), true);

  const invalid = await actions.patchProvider("local", { baseUrl: null, api: null });
  assert.equal(invalid.type, "validation-error");
  assertDiagnosticSecretFree(invalid);
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(before), true);
}));

test("nested subtree save conflicts only on the exact edited subtree", async () => withAgentDir(async (agentDir, actions) => {
  seedBasic(agentDir);
  const snapshot = actions.readEditorSnapshot();
  assert.equal(snapshot.type, "snapshot");
  if (snapshot.type !== "snapshot") return;
  const baselineHeaders = structuredClone(snapshot.native.providers.local!.headers ?? {});
  const baselineCompat = structuredClone(snapshot.native.providers.local!.compat ?? {});

  const external = readNative(agentDir);
  external.providers.local!.compat = { supportsStore: true };
  writeNative(agentDir, external);

  const unrelated = await actions.saveProviderSubtree("local", "headers", baselineHeaders, { "X-New": "2" });
  assert.equal(unrelated.type, "success");
  assert.deepEqual(readNative(agentDir).providers.local!.headers, { "X-New": "2" });
  assert.deepEqual(readNative(agentDir).providers.local!.compat, { supportsStore: true });

  const conflict = await actions.saveProviderSubtree("local", "compat", baselineCompat, { supportsTemperature: false });
  assert.equal(conflict.type, "subtree-conflict");
  assertDiagnosticSecretFree(conflict);
  if (conflict.type === "subtree-conflict") {
    assert.equal(conflict.path.includes("compat"), true);
  }
  assert.deepEqual(readNative(agentDir).providers.local!.compat, { supportsStore: true });
}));

test("object key reorder does not cause subtree conflict", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost:1",
        api: "openai-completions",
        headers: { b: "2", a: "1" },
        models: [model("one")],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());
  // Baseline with different key insertion order must still match.
  const result = await actions.saveProviderSubtree("local", "headers", { a: "1", b: "2" }, { a: "1", b: "2", c: "3" });
  assert.equal(result.type, "success");
  assert.deepEqual(readNative(agentDir).providers.local!.headers, { a: "1", b: "2", c: "3" });
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
  assertDiagnosticSecretFree(create);

  const copyPreview = await actions.previewProviderIdentityAction({ kind: "copy", providerId: "source", targetProviderId: "target" });
  assert.equal(copyPreview.type, "native-collision");
  assertDiagnosticSecretFree(copyPreview);

  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
}));

test("createProvider rejects duplicate model ids with zero writes", async () => withAgentDir(async (agentDir, actions) => {
  seedBasic(agentDir);
  const before = fs.readFileSync(getModelsPath(agentDir));
  const result = await actions.createProvider("dup", {
    baseUrl: "http://localhost:9",
    api: "openai-completions",
    models: [model("same"), model("same", { name: "Other" })],
  });
  assert.equal(result.type, "validation-error");
  assertDiagnosticSecretFree(result);
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(before), true);
  assert.equal(readNative(agentDir).providers.dup, undefined);
}));

test("provider identity enumerates native and payload-only tuple identities including slash ids", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      "src/prov": {
        baseUrl: "http://localhost:1",
        api: "openai-completions",
        models: [model("native/one")],
      },
    },
  });
  let payload = setPayloadDocumentValue(emptyPayloadDocument(), "src/prov", "native/one", { n: 1 });
  payload = setPayloadDocumentValue(payload, "src/prov", "payload/only", { p: 1 });
  writePayload(agentDir, payload);

  const preview = await actions.previewProviderIdentityAction({
    kind: "rename",
    providerId: "src/prov",
    targetProviderId: "dst/prov",
  });
  assert.equal(preview.type, "preview");
  if (preview.type !== "preview") return;
  assert.deepEqual(preview.affectedIdentities, [
    ["src/prov", "native/one"],
    ["src/prov", "payload/only"],
    ["dst/prov", "native/one"],
    ["dst/prov", "payload/only"],
  ]);
  assertDiagnosticSecretFree(preview);

  const committed = await actions.commitProviderIdentityAction(preview.token);
  assert.equal(committed.type, "success");
  assert.equal(readNative(agentDir).providers["src/prov"], undefined);
  assert.ok(readNative(agentDir).providers["dst/prov"]);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "dst/prov", "native/one"), { n: 1 });
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "dst/prov", "payload/only"), { p: 1 });
  assert.equal(lookupModelPayload(readPayload(agentDir), "src/prov", "payload/only"), undefined);
}));

test("provider delete removes exactly all disclosed native and payload-only identities", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      gone: { baseUrl: "http://localhost:1", api: "openai-completions", models: [model("a")] },
      keep: { baseUrl: "http://localhost:2", api: "openai-completions", models: [model("b")] },
    },
  });
  let payload = setPayloadDocumentValue(emptyPayloadDocument(), "gone", "a", { a: 1 });
  payload = setPayloadDocumentValue(payload, "gone", "orphan", { o: 1 });
  payload = setPayloadDocumentValue(payload, "keep", "b", { b: 1 });
  writePayload(agentDir, payload);

  const preview = await actions.previewProviderIdentityAction({ kind: "delete", providerId: "gone" });
  assert.equal(preview.type, "preview");
  if (preview.type !== "preview") return;
  assert.deepEqual(preview.affectedIdentities, [["gone", "a"], ["gone", "orphan"]]);
  const ok = await actions.commitProviderIdentityAction(preview.token);
  assert.equal(ok.type, "success");
  assert.equal(readNative(agentDir).providers.gone, undefined);
  assert.equal(lookupModelPayload(readPayload(agentDir), "gone", "a"), undefined);
  assert.equal(lookupModelPayload(readPayload(agentDir), "gone", "orphan"), undefined);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "keep", "b"), { b: 1 });
}));

test("reuse-target preserves existing target payload even with explicit payload or null", async () => withAgentDir(async (agentDir, actions) => {
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

  const rename = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "old",
    targetModelId: "new",
    payload: null,
    payloadCollisionResolution: "reuse-target",
  });
  assert.equal(rename.type, "preview");
  if (rename.type !== "preview") return;
  assert.deepEqual(rename.collisions, [["local", "new"]]);
  const renamed = await actions.commitModelIdentityAction(rename.token);
  assert.equal(renamed.type, "success");
  assert.equal(lookupModelPayload(readPayload(agentDir), "local", "old"), undefined);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "new"), { from: "target" });

  // Copy reuse: source and target both retained.
  writeNative(agentDir, {
    providers: {
      local: { baseUrl: "http://localhost:1", api: "openai-completions", models: [model("src"), model("dst")] },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(
    setPayloadDocumentValue(emptyPayloadDocument(), "local", "src", { from: "source" }),
    "local",
    "dst",
    { from: "target" },
  ));
  // Need free target for copy - use free id with pre-existing payload only.
  writeNative(agentDir, {
    providers: {
      local: { baseUrl: "http://localhost:1", api: "openai-completions", models: [model("src")] },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(
    setPayloadDocumentValue(emptyPayloadDocument(), "local", "src", { from: "source" }),
    "local",
    "copy-target",
    { from: "target" },
  ));
  const copy = await actions.previewModelIdentityAction({
    kind: "copy",
    providerId: "local",
    modelId: "src",
    targetModelId: "copy-target",
    payloadCollisionResolution: "reuse-target",
  });
  assert.equal(copy.type, "preview");
  if (copy.type !== "preview") return;
  const copied = await actions.commitModelIdentityAction(copy.token);
  assert.equal(copied.type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "src"), { from: "source" });
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "copy-target"), { from: "target" });
}));

test("replace-target overwrites target payload with source semantics", async () => withAgentDir(async (agentDir, actions) => {
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
  const preview = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "old",
    targetModelId: "new",
    payloadCollisionResolution: "replace-target",
  });
  assert.equal(preview.type, "preview");
  if (preview.type !== "preview") return;
  assert.deepEqual(preview.collisions, [["local", "new"]]);
  const committed = await actions.commitModelIdentityAction(preview.token);
  assert.equal(committed.type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "new"), { from: "source" });
  assert.equal(lookupModelPayload(readPayload(agentDir), "local", "old"), undefined);
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
  assertDiagnosticSecretFree(preview);
  if (preview.type === "payload-collision") {
    assert.deepEqual(preview.collisions, [["local", "new"]]);
  }
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
}));

test("opaque preview tokens reject mutation and unknown tokens", async () => withAgentDir(async (agentDir, actions) => {
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
  assertDiagnosticSecretFree(preview);

  // Mutate every public field on the result object; commit still uses bound state.
  (preview as { affectedIdentities: unknown }).affectedIdentities = [["evil", "x"]];
  (preview as { collisions: unknown }).collisions = [["evil", "y"]];
  (preview.descriptor as { kind: string }).kind = "delete";
  (preview.descriptor as { sourceProviderId: string }).sourceProviderId = "evil";
  const text = JSON.stringify(preview);
  assert.equal(text.includes("seed"), false);

  const committed = await actions.commitModelIdentityAction(preview.token);
  assert.equal(committed.type, "success");
  assert.equal(readNative(agentDir).providers.local!.models![0]!.id, "two");

  const unknown = await actions.commitModelIdentityAction("not-a-real-token");
  assert.equal(unknown.type, "stale-target");
  assertDiagnosticSecretFree(unknown);

  // Tampered token string cannot invent a new action.
  const again = await actions.previewModelIdentityAction({
    kind: "copy",
    providerId: "local",
    modelId: "two",
    targetModelId: "three",
  });
  assert.equal(again.type, "preview");
  if (again.type !== "preview") return;
  const forged = `${again.token}-forged`;
  const forgedResult = await actions.commitModelIdentityAction(forged);
  assert.equal(forgedResult.type, "stale-target");
  assert.equal(readNative(agentDir).providers.local!.models!.some((entry) => entry.id === "three"), false);
}));

test("identity commit drift returns refreshed sanitized preview without write", async () => withAgentDir(async (agentDir, actions) => {
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
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  const payloadBefore = fs.readFileSync(getPayloadConfigPath(agentDir));

  const commit = await actions.commitModelIdentityAction(preview.token);
  assert.equal(commit.type, "stale-target");
  assertDiagnosticSecretFree(commit);
  if (commit.type === "stale-target") {
    assert.ok(commit.preview);
    assert.equal(typeof commit.preview!.token, "string");
    assert.equal(commit.preview!.kind, "rename");
    assert.deepEqual(commit.preview!.affectedIdentities, [["local", "one"], ["local", "two"]]);
  }
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "one"), { seed: 7 });
}));

test("field baselines prevent overwriting concurrent unedited model additions", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost:1",
        api: "openai-completions",
        name: "Original",
        headers: { "X-Keep": "1" },
        models: [model("one")],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());
  const baselines = { name: "Original", baseUrl: "http://localhost:1", api: "openai-completions" };

  // Concurrent process adds a model and changes headers.
  const concurrent = readNative(agentDir);
  concurrent.providers.local!.models!.push(model("two"));
  concurrent.providers.local!.headers = { "X-Keep": "1", "X-New": "2" };
  writeNative(agentDir, concurrent);

  const result = await actions.patchProvider("local", { name: "Renamed" }, { fieldBaselines: baselines });
  assert.equal(result.type, "success");
  const provider = readNative(agentDir).providers.local!;
  assert.equal(provider.name, "Renamed");
  assert.equal(provider.models!.map((entry) => entry.id).join(","), "one,two");
  assert.deepEqual(provider.headers, { "X-Keep": "1", "X-New": "2" });

  // Same field concurrent edit conflicts.
  const conflict = await actions.patchProvider("local", { name: "Again" }, {
    fieldBaselines: { name: "Original" },
  });
  assert.equal(conflict.type, "subtree-conflict");
  assertDiagnosticSecretFree(conflict);
  assert.equal(readNative(agentDir).providers.local!.name, "Renamed");
}));

test("provider rename applies managed patch without replacing concurrent models", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      source: {
        baseUrl: "http://localhost:1",
        api: "openai-completions",
        name: "Src",
        models: [model("a")],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());
  const preview = await actions.previewProviderIdentityAction({
    kind: "rename",
    providerId: "source",
    targetProviderId: "dest",
    providerPatch: { name: "Dest" },
    fieldBaselines: { name: "Src" },
  });
  assert.equal(preview.type, "preview");
  if (preview.type !== "preview") return;

  // Concurrent model addition before commit.
  const concurrent = readNative(agentDir);
  concurrent.providers.source!.models!.push(model("b"));
  writeNative(agentDir, concurrent);

  const committed = await actions.commitProviderIdentityAction(preview.token);
  // Hash drift -> refreshed preview, zero write of rename under old identity set.
  assert.equal(committed.type, "stale-target");
  assertDiagnosticSecretFree(committed);
  assert.ok(readNative(agentDir).providers.source);
  assert.equal(readNative(agentDir).providers.dest, undefined);
  assert.equal(readNative(agentDir).providers.source!.models!.length, 2);
}));

function legacyRows(entries: Record<string, { type: "string" | "bool" | "json"; value: string }>): unknown[] {
  return Object.entries(entries).map(([key, row]) => ({ key, type: row.type, value: row.value }));
}

test("legacy extraPayload migrates on model copy and provider rename with private precedence", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost:1",
        api: "openai-completions",
        models: [model("old", { extraPayload: legacyRows({ migrated: { type: "bool", value: "true" } }) })],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());

  const copyPreview = await actions.previewModelIdentityAction({
    kind: "copy",
    providerId: "local",
    modelId: "old",
    targetModelId: "copy",
  });
  assert.equal(copyPreview.type, "preview");
  if (copyPreview.type !== "preview") return;
  const copied = await actions.commitModelIdentityAction(copyPreview.token);
  assert.equal(copied.type, "success");
  const copyModel = readNative(agentDir).providers.local!.models!.find((entry) => entry.id === "copy")!;
  assert.equal(Object.hasOwn(copyModel, "extraPayload"), false);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "copy"), { migrated: true });
  // Source native still may retain legacy until edited; copy must not remove source private absence.
  assert.equal(lookupModelPayload(readPayload(agentDir), "local", "old"), undefined);

  // Private existing takes precedence over legacy on rename target with replace.
  writeNative(agentDir, {
    providers: {
      source: {
        baseUrl: "http://localhost:1",
        api: "openai-completions",
        models: [model("m", { extraPayload: legacyRows({ legacy: { type: "bool", value: "true" } }) })],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "source", "m", { private: true }));
  const rename = await actions.previewProviderIdentityAction({
    kind: "rename",
    providerId: "source",
    targetProviderId: "dest",
  });
  assert.equal(rename.type, "preview");
  if (rename.type !== "preview") return;
  const renamed = await actions.commitProviderIdentityAction(rename.token);
  assert.equal(renamed.type, "success");
  const destModel = readNative(agentDir).providers.dest!.models![0]!;
  assert.equal(Object.hasOwn(destModel, "extraPayload"), false);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "dest", "m"), { private: true });
}));

test("legacy migration is skipped on collision/stale/validation/lock failure", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost:1",
        api: "openai-completions",
        models: [model("old", { extraPayload: legacyRows({ migrated: { type: "bool", value: "true" } }) })],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "new", { keep: true }));
  const beforeNative = fs.readFileSync(getModelsPath(agentDir));
  const beforePayload = fs.readFileSync(getPayloadConfigPath(agentDir));

  const collision = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "old",
    targetModelId: "new",
  });
  assert.equal(collision.type, "payload-collision");
  assert.equal(Object.hasOwn(readNative(agentDir).providers.local!.models![0]!, "extraPayload"), true);
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(beforeNative), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(beforePayload), true);

  const lockActions = new ModelConfigActions({
    agentDir,
    commitMutation: async () => ({ type: "busy" }),
  });
  writePayload(agentDir, emptyPayloadDocument());
  const lockPreview = await lockActions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "old",
    targetModelId: "free",
    migrateLegacyExtraPayload: { migrated: true },
  });
  assert.equal(lockPreview.type, "preview");
  if (lockPreview.type !== "preview") return;
  const lockResult = await lockActions.commitModelIdentityAction(lockPreview.token);
  assert.equal(lockResult.type, "lock-busy");
  assertDiagnosticSecretFree(lockResult);
  assert.equal(Object.hasOwn(readNative(agentDir).providers.local!.models![0]!, "extraPayload"), true);
  assert.equal(lookupModelPayload(readPayload(agentDir), "local", "free"), undefined);
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
    assertDiagnosticSecretFree(result);
  }

  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
}));

test("action layer faults at journal/native/payload/journal-removal keep exact before or after resolution", async () => withAgentDir(async (agentDir) => {
  const boundaries = ["journal", "native", "payload", "journal-removed"] as const;
  for (const failAt of boundaries) {
    writeNative(agentDir, {
      providers: {
        local: { baseUrl: "http://localhost:1", api: "openai-completions", models: [model("one")] },
      },
    });
    writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "one", { phase: "before" }));
    // Clean journal from prior iteration.
    const journalPath = getTransactionJournalPath(agentDir);
    if (fs.existsSync(journalPath)) fs.rmSync(journalPath);

    const actions = new ModelConfigActions({
      agentDir,
      commitMutation: async (request: MutationRequest, options?: PayloadCoordinatorOptions): Promise<CommitResult> => {
        return commitCoordinatedMutation({
          ...request,
          onBoundary(boundary) {
            request.onBoundary?.(boundary);
            if (boundary === failAt && failAt !== "journal-removed") throw new Error(`injected ${failAt} failure`);
            if (boundary === "journal-removed" && failAt === "journal-removed") throw new Error("injected journal-removed failure");
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

    if (failAt === "journal-removed") {
      // Failure after journal removal: commit may surface as thrown after success path mid-flight.
      try {
        await actions.commitModelIdentityAction(preview.token);
      } catch {
        // expected
      }
    } else {
      await assert.rejects(() => actions.commitModelIdentityAction(preview.token));
    }

    const resolvedOne = resolveRequestPayload("local", "one", { agentDir });
    const resolvedTwo = resolveRequestPayload("local", "two", { agentDir });
    const beforeOnly = resolvedOne?.phase === "before" && resolvedTwo === undefined;
    const afterOnly = resolvedTwo?.phase === "before" && resolvedOne === undefined;
    // Never serialize private resolved payloads into assertion messages.
    assert.equal(beforeOnly || afterOnly, true, `boundary ${failAt} mixed before/after resolution`);
    assert.equal(Boolean(beforeOnly && afterOnly), false, `boundary ${failAt} dual views`);
  }
}));

test("editor snapshot returns deep clones; diagnostics never embed private docs", async () => withAgentDir(async (agentDir, actions) => {
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
  snapshot.native.providers.local!.name = "mutated";
  assert.notEqual(readNative(agentDir).providers.local!.name, "mutated");

  const missing = await actions.patchModel("local", "missing", { name: "x" });
  assert.equal(missing.type, "stale-target");
  assertDiagnosticSecretFree(missing);
}));

test("createModel and saveModelPayload succeed without leaking payload into diagnostics", async () => withAgentDir(async (agentDir, actions) => {
  seedBasic(agentDir);
  const created = await actions.createModel("local", model("two"), { payload: { temperature: 0.2 } });
  assert.equal(created.type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "two"), { temperature: 0.2 });

  const snapshot = actions.readEditorSnapshot();
  assert.equal(snapshot.type, "snapshot");
  if (snapshot.type !== "snapshot") return;
  const baseline = lookupModelPayload(snapshot.payload, "local", "two")!;
  const saved = await actions.saveModelPayload("local", "two", baseline, { temperature: 0.5 });
  assert.equal(saved.type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "two"), { temperature: 0.5 });
}));

test("recovery-required is returned when storage is not mutation-ready", async () => withAgentDir(async (agentDir, actions) => {
  seedBasic(agentDir);
  fs.writeFileSync(getTransactionJournalPath(agentDir), "{");
  const result = await actions.patchProvider("local", { name: "x" });
  assert.equal(result.type, "recovery-required");
  assertDiagnosticSecretFree(result);
  assert.equal(fs.readFileSync(getTransactionJournalPath(agentDir), "utf8"), "{");
}));

test("prototype-looking provider ids are own-key-safe for create/read/patch/identity", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, { providers: {} });
  writePayload(agentDir, emptyPayloadDocument());

  // Inherited names without own keys are stale, not Object.prototype reads.
  const stale = await actions.patchProvider("constructor", { name: "nope" });
  assert.equal(stale.type, "stale-target");
  assertDiagnosticSecretFree(stale);

  const created = await actions.createProvider("__proto__", {
    baseUrl: "http://proto.example",
    api: "openai-completions",
    models: [model("m1")],
  });
  assert.equal(created.type, "success");
  const native = readNative(agentDir);
  assert.equal(Object.hasOwn(native.providers, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(native.providers) === Object.prototype, true);
  assert.equal(native.providers["__proto__"]!.baseUrl, "http://proto.example");

  const patched = await actions.patchProvider("__proto__", { name: "Proto" }, {
    fieldBaselines: { name: undefined },
  });
  assert.equal(patched.type, "success");
  assert.equal(readNative(agentDir).providers["__proto__"]!.name, "Proto");

  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "__proto__", "only", { ok: true }));
  const preview = await actions.previewProviderIdentityAction({
    kind: "rename",
    providerId: "__proto__",
    targetProviderId: "constructor",
  });
  assert.equal(preview.type, "preview");
  if (preview.type !== "preview") return;
  assert.deepEqual(preview.affectedIdentities, [
    ["__proto__", "m1"],
    ["__proto__", "only"],
    ["constructor", "m1"],
    ["constructor", "only"],
  ]);
  assert.equal((await actions.commitProviderIdentityAction(preview.token)).type, "success");
  assert.equal(Object.hasOwn(readNative(agentDir).providers, "constructor"), true);
  assert.equal(Object.hasOwn(readNative(agentDir).providers, "__proto__"), false);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "constructor", "only"), { ok: true });

  // Payload map own-key safety for prototype-looking tuple parts.
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "constructor", "__proto__", { p: 1 }));
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "constructor", "__proto__"), { p: 1 });
  assert.equal(Object.hasOwn(readPayload(agentDir).extraPayloads, modelPayloadKey("constructor", "__proto__")), true);
}));

test("provider identity previews include unambiguous legacy delimiter keys", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      source: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("native")],
      },
    },
  });
  const payload = emptyPayloadDocument();
  // Unambiguous legacy key for payload-only orphan.
  setOwnLegacy(payload, "source/orphan", { orphan: true });
  // Ambiguous multi-slash legacy stays inert.
  setOwnLegacy(payload, "source/a/b", { inert: true });
  writePayload(agentDir, payload);

  const preview = await actions.previewProviderIdentityAction({
    kind: "rename",
    providerId: "source",
    targetProviderId: "dest",
  });
  assert.equal(preview.type, "preview");
  if (preview.type !== "preview") return;
  assert.deepEqual(preview.affectedIdentities, [
    ["source", "native"],
    ["source", "orphan"],
    ["dest", "native"],
    ["dest", "orphan"],
  ]);
  assert.equal((await actions.commitProviderIdentityAction(preview.token)).type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "dest", "orphan"), { orphan: true });
  assert.equal(lookupModelPayload(readPayload(agentDir), "source", "orphan"), undefined);
  // Ambiguous key preserved under original key.
  assert.equal(Object.hasOwn(readPayload(agentDir).extraPayloads, "source/a/b"), true);
  assert.equal(Object.hasOwn(readNative(agentDir).providers, "source"), false);
  assert.equal(Object.hasOwn(readNative(agentDir).providers, "dest"), true);

  // Delete discloses the same set.
  writeNative(agentDir, {
    providers: {
      p: { baseUrl: "http://localhost", api: "openai-completions", models: [model("n")] },
    },
  });
  const delPayload = emptyPayloadDocument();
  setOwnLegacy(delPayload, "p/only", { x: 1 });
  writePayload(agentDir, delPayload);
  const delPreview = await actions.previewProviderIdentityAction({ kind: "delete", providerId: "p" });
  assert.equal(delPreview.type, "preview");
  if (delPreview.type !== "preview") return;
  assert.deepEqual(delPreview.affectedIdentities, [["p", "n"], ["p", "only"]]);
  assert.equal((await actions.commitProviderIdentityAction(delPreview.token)).type, "success");
  assert.equal(Object.keys(readPayload(agentDir).extraPayloads).length, 0);
}));

test("createProvider requires explicit payload collision resolution and never attaches private payloads", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, { providers: {} });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "newp", "m1", { keep: true }));
  const before = fs.readFileSync(getPayloadConfigPath(agentDir));
  const blocked = await actions.createProvider("newp", {
    baseUrl: "http://localhost",
    api: "openai-completions",
    models: [model("m1")],
  });
  assert.equal(blocked.type, "payload-collision");
  assertDiagnosticSecretFree(blocked);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(before), true);
  assert.equal(Object.hasOwn(readNative(agentDir).providers, "newp"), false);

  const reused = await actions.createProvider("newp", {
    baseUrl: "http://localhost",
    api: "openai-completions",
    models: [model("m1")],
  }, { payloadCollisionResolution: "reuse-target" });
  assert.equal(reused.type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "newp", "m1"), { keep: true });

  writeNative(agentDir, { providers: {} });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "newp", "m1", { keep: true }));
  const replaced = await actions.createProvider("newp", {
    baseUrl: "http://localhost",
    api: "openai-completions",
    models: [model("m1")],
  }, { payloadCollisionResolution: "replace-target" });
  assert.equal(replaced.type, "success");
  assert.equal(lookupModelPayload(readPayload(agentDir), "newp", "m1"), undefined);
}));

test("replace-target clears absent source payload; reuse preserves absolute target", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("old"), model("keep")],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "new", { keep: true }));

  // Model rename without source private + replace => remove target.
  const replacePreview = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "old",
    targetModelId: "new",
    payloadCollisionResolution: "replace-target",
  });
  assert.equal(replacePreview.type, "preview");
  if (replacePreview.type !== "preview") return;
  assert.equal((await actions.commitModelIdentityAction(replacePreview.token)).type, "success");
  assert.equal(lookupModelPayload(readPayload(agentDir), "local", "new"), undefined);

  // Model copy reuse: target model id free natively, private payload-only collision preserved.
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("src")],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "dst", { keep: true }));
  const reusePreview = await actions.previewModelIdentityAction({
    kind: "copy",
    providerId: "local",
    modelId: "src",
    targetModelId: "dst",
    payloadCollisionResolution: "reuse-target",
  });
  assert.equal(reusePreview.type, "preview");
  if (reusePreview.type !== "preview") return;
  assert.equal((await actions.commitModelIdentityAction(reusePreview.token)).type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "dst"), { keep: true });
  assert.equal(lookupModelPayload(readPayload(agentDir), "local", "src"), undefined);

  // createModel replace with no explicit payload clears target.
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "fresh", { keep: true }));
  const created = await actions.createModel("local", model("fresh"), {
    payloadCollisionResolution: "replace-target",
  });
  assert.equal(created.type, "success");
  assert.equal(lookupModelPayload(readPayload(agentDir), "local", "fresh"), undefined);
}));

test("bound previews expire by scheduled TTL without later API call", async () => withAgentDir(async (agentDir) => {
  seedBasic(agentDir);
  let clock = 1_000_000;
  type Queued = { at: number; fn: () => void };
  const queue: Queued[] = [];
  const actions = new ModelConfigActions({
    agentDir,
    now: () => clock,
    previewTtlMs: 100,
    maxPreviews: 2,
    schedule: (fn, delayMs) => {
      const entry = { at: clock + delayMs, fn };
      queue.push(entry);
      return { id: entry };
    },
    cancel: (handle) => {
      const idx = queue.findIndex((entry) => entry === handle.id);
      if (idx >= 0) queue.splice(idx, 1);
    },
  });

  const p1 = await actions.previewModelIdentityAction({
    kind: "rename", providerId: "local", modelId: "one", targetModelId: "a",
  });
  assert.equal(p1.type, "preview");
  if (p1.type !== "preview") return;
  clock += 50;
  const p2 = await actions.previewModelIdentityAction({
    kind: "copy", providerId: "local", modelId: "one", targetModelId: "b",
  });
  assert.equal(p2.type, "preview");
  if (p2.type !== "preview") return;
  clock += 50;
  const p3 = await actions.previewModelIdentityAction({
    kind: "delete", providerId: "local", modelId: "one",
  });
  assert.equal(p3.type, "preview");
  if (p3.type !== "preview") return;
  assert.ok(actions.boundPreviewCount() <= 2);

  // Fire scheduled expiry callbacks without further action-layer API calls.
  clock += 200;
  while (queue.length > 0) {
    const due = queue.filter((entry) => entry.at <= clock);
    if (due.length === 0) break;
    for (const entry of due) {
      const idx = queue.indexOf(entry);
      if (idx >= 0) queue.splice(idx, 1);
      entry.fn();
    }
  }
  assert.equal(actions.boundPreviewCount(), 0);
  const expired = await actions.commitModelIdentityAction(p3.token);
  assert.equal(expired.type, "stale-target");
  assertDiagnosticSecretFree(expired);

  const p4 = await actions.previewModelIdentityAction({
    kind: "rename", providerId: "local", modelId: "one", targetModelId: "c",
  });
  assert.equal(p4.type, "preview");
  if (p4.type !== "preview") return;
  actions.discardIdentityPreview(p4.token);
  assert.equal(actions.boundPreviewCount(), 0);
  const discarded = await actions.commitModelIdentityAction(p4.token);
  assert.equal(discarded.type, "stale-target");
  assertDiagnosticSecretFree(discarded);

  // Terminal commit consumes token even when coordinator throws.
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("one")],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());
  const throwing = new ModelConfigActions({
    agentDir,
    now: () => clock,
    previewTtlMs: 10_000,
    schedule: (fn, delayMs) => {
      const entry = { at: clock + delayMs, fn };
      queue.push(entry);
      return { id: entry };
    },
    cancel: (handle) => {
      const idx = queue.findIndex((entry) => entry === handle.id);
      if (idx >= 0) queue.splice(idx, 1);
    },
    commitMutation: async () => {
      throw new Error("injected commit throw");
    },
  });
  const p5 = await throwing.previewModelIdentityAction({
    kind: "rename", providerId: "local", modelId: "one", targetModelId: "two",
  });
  assert.equal(p5.type, "preview");
  if (p5.type !== "preview") return;
  assert.equal(throwing.boundPreviewCount(), 1);
  await assert.rejects(() => throwing.commitModelIdentityAction(p5.token));
  assert.equal(throwing.boundPreviewCount(), 0);
  assert.equal((await throwing.commitModelIdentityAction(p5.token)).type, "stale-target");

  // Successful commit also consumes.
  const p6 = await actions.previewModelIdentityAction({
    kind: "rename", providerId: "local", modelId: "one", targetModelId: "two",
  });
  assert.equal(p6.type, "preview");
  if (p6.type !== "preview") return;
  assert.equal((await actions.commitModelIdentityAction(p6.token)).type, "success");
  assert.equal((await actions.commitModelIdentityAction(p6.token)).type, "stale-target");
  assert.equal(actions.boundPreviewCount(), 0);
}));

test("malformed legacy rows never vanish without explicit discard resolution", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("old", { extraPayload: { not: "array" } })],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "old", { private: true }));
  const beforeNative = fs.readFileSync(getModelsPath(agentDir));
  const beforePayload = fs.readFileSync(getPayloadConfigPath(agentDir));

  // Private present still rejects without discard.
  const rename = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "old",
    targetModelId: "new",
  });
  assert.equal(rename.type, "validation-error");
  assertDiagnosticSecretFree(rename);
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(beforeNative), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(beforePayload), true);
  assert.equal(Object.hasOwn(readNative(agentDir).providers.local!.models![0]!, "extraPayload"), true);

  const patch = await actions.patchModel("local", "old", { name: "x" }, {
    fieldBaselines: { name: undefined },
    payload: { private: true },
  });
  assert.equal(patch.type, "validation-error");
  assert.equal(Object.hasOwn(readNative(agentDir).providers.local!.models![0]!, "extraPayload"), true);

  // Explicit discard on preview/commit succeeds and strips.
  const discardPreview = await actions.previewModelIdentityAction({
    kind: "rename",
    providerId: "local",
    modelId: "old",
    targetModelId: "new",
    legacyDiscardResolution: "discard-malformed-legacy",
  });
  assert.equal(discardPreview.type, "preview");
  if (discardPreview.type !== "preview") return;
  assert.equal((await actions.commitModelIdentityAction(discardPreview.token)).type, "success");
  assert.equal(Object.hasOwn(readNative(agentDir).providers.local!.models![0]!, "extraPayload"), false);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "new"), { private: true });

  // Provider rename without discard preserves malformed bytes.
  writeNative(agentDir, {
    providers: {
      source: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("m", { extraPayload: [{ key: "x", type: "json", value: "{bad" }] })],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());
  const providerBlocked = await actions.previewProviderIdentityAction({
    kind: "copy",
    providerId: "source",
    targetProviderId: "dest",
  });
  assert.equal(providerBlocked.type, "validation-error");
  assert.equal(Object.hasOwn(readNative(agentDir).providers.source!.models![0]!, "extraPayload"), true);

  const providerOk = await actions.previewProviderIdentityAction({
    kind: "copy",
    providerId: "source",
    targetProviderId: "dest",
    legacyDiscardResolution: "discard-malformed-legacy",
  });
  assert.equal(providerOk.type, "preview");
  if (providerOk.type !== "preview") return;
  assert.equal((await actions.commitProviderIdentityAction(providerOk.token)).type, "success");
  assert.equal(Object.hasOwn(readNative(agentDir).providers.dest!.models![0]!, "extraPayload"), false);
}));

function setOwnLegacy(payload: ReturnType<typeof emptyPayloadDocument>, key: string, value: Record<string, unknown>): void {
  Object.defineProperty(payload.extraPayloads, key, {
    value: structuredClone(value),
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

test("createProvider and createModel migrate valid legacy rows with collision resolution", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, { providers: {} });
  writePayload(agentDir, emptyPayloadDocument());

  // No collision: migrate valid legacy.
  const created = await actions.createProvider("p", {
    baseUrl: "http://localhost",
    api: "openai-completions",
    models: [model("m1", { extraPayload: legacyRows({ temp: { type: "string", value: "hot" } }) })],
  });
  assert.equal(created.type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "p", "m1"), { temp: "hot" });
  assert.equal(Object.hasOwn(readNative(agentDir).providers.p!.models![0]!, "extraPayload"), false);

  // Collision + reuse: preserve target, strip native.
  writeNative(agentDir, { providers: {} });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "p", "m1", { keep: true }));
  const reused = await actions.createProvider("p", {
    baseUrl: "http://localhost",
    api: "openai-completions",
    models: [model("m1", { extraPayload: legacyRows({ temp: { type: "string", value: "hot" } }) })],
  }, { payloadCollisionResolution: "reuse-target" });
  assert.equal(reused.type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "p", "m1"), { keep: true });

  // Collision + replace: write legacy.
  writeNative(agentDir, { providers: {} });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "p", "m1", { keep: true }));
  const replaced = await actions.createProvider("p", {
    baseUrl: "http://localhost",
    api: "openai-completions",
    models: [model("m1", { extraPayload: legacyRows({ temp: { type: "string", value: "hot" } }) })],
  }, { payloadCollisionResolution: "replace-target" });
  assert.equal(replaced.type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "p", "m1"), { temp: "hot" });

  // createModel replace with valid legacy overwrites target.
  writeNative(agentDir, {
    providers: {
      local: { baseUrl: "http://localhost", api: "openai-completions", models: [] },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "n", { keep: true }));
  const modelCreated = await actions.createModel(
    "local",
    model("n", { extraPayload: legacyRows({ a: { type: "bool", value: "true" } }) }),
    { payloadCollisionResolution: "replace-target" },
  );
  assert.equal(modelCreated.type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "n"), { a: true });
  assert.equal(Object.hasOwn(readNative(agentDir).providers.local!.models![0]!, "extraPayload"), false);

  // Malformed create without discard is zero-write.
  writeNative(agentDir, { providers: {} });
  const before = fs.readFileSync(getModelsPath(agentDir));
  const blocked = await actions.createProvider("bad", {
    baseUrl: "http://localhost",
    api: "openai-completions",
    models: [model("m", { extraPayload: { not: "rows" } })],
  });
  assert.equal(blocked.type, "validation-error");
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(before), true);
}));

test("legacy key provider/ enumerates as empty model id and participates in identity ops", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      source: { baseUrl: "http://localhost", api: "openai-completions", models: [model("n")] },
    },
  });
  const payload = emptyPayloadDocument();
  setOwnLegacy(payload, "source/", { empty: true });
  setOwnLegacy(payload, "source/a/b", { inert: true });
  writePayload(agentDir, payload);

  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "source", ""), { empty: true });

  const preview = await actions.previewProviderIdentityAction({
    kind: "rename",
    providerId: "source",
    targetProviderId: "dest",
  });
  assert.equal(preview.type, "preview");
  if (preview.type !== "preview") return;
  assert.deepEqual(preview.affectedIdentities, [
    ["source", ""],
    ["source", "n"],
    ["dest", ""],
    ["dest", "n"],
  ]);
  assert.equal((await actions.commitProviderIdentityAction(preview.token)).type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "dest", ""), { empty: true });
  assert.equal(lookupModelPayload(readPayload(agentDir), "source", ""), undefined);
  assert.equal(Object.hasOwn(readPayload(agentDir).extraPayloads, "source/a/b"), true);

  // Delete discloses and removes empty-id identity.
  writeNative(agentDir, {
    providers: {
      p: { baseUrl: "http://localhost", api: "openai-completions", models: [] },
    },
  });
  const delPayload = emptyPayloadDocument();
  setOwnLegacy(delPayload, "p/", { gone: true });
  writePayload(agentDir, delPayload);
  const delPreview = await actions.previewProviderIdentityAction({ kind: "delete", providerId: "p" });
  assert.equal(delPreview.type, "preview");
  if (delPreview.type !== "preview") return;
  assert.deepEqual(delPreview.affectedIdentities, [["p", ""]]);
  assert.equal((await actions.commitProviderIdentityAction(delPreview.token)).type, "success");
  assert.equal(Object.keys(readPayload(agentDir).extraPayloads).length, 0);
}));


test("patchProvider models migrates valid legacy, preserves removed payloads, and requires discard", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [
          model("keep", { extraPayload: legacyRows({ k: { type: "string", value: "v" } }) }),
          model("drop", { extraPayload: legacyRows({ d: { type: "bool", value: "true" } }) }),
          model("bad", { extraPayload: { not: "rows" } }),
        ],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "drop", { privateDrop: true }));
  const beforeNative = fs.readFileSync(getModelsPath(agentDir));
  const beforePayload = fs.readFileSync(getPayloadConfigPath(agentDir));

  const blocked = await actions.patchProvider("local", {
    models: [model("keep"), model("newonly")],
  });
  assert.equal(blocked.type, "validation-error");
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(beforeNative), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(beforePayload), true);

  // Valid migration + payload-only collision + removed payload preservation.
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [
          model("keep", { extraPayload: legacyRows({ k: { type: "string", value: "v" } }) }),
          model("drop", { extraPayload: legacyRows({ d: { type: "bool", value: "true" } }) }),
        ],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(
    setPayloadDocumentValue(emptyPayloadDocument(), "local", "fresh", { only: true }),
    "local",
    "drop",
    { privateDrop: true },
  ));

  const collision = await actions.patchProvider("local", {
    models: [model("keep"), model("fresh")],
  });
  assert.equal(collision.type, "payload-collision");

  const replaced = await actions.patchProvider("local", {
    models: [
      model("keep", { extraPayload: legacyRows({ k: { type: "string", value: "v" } }) }),
      model("fresh"),
    ],
  }, { payloadCollisionResolution: "reuse-target" });
  assert.equal(replaced.type, "success");
  assert.equal(Object.hasOwn(readNative(agentDir).providers.local!.models!.find((m) => m.id === "keep")!, "extraPayload"), false);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "keep"), { k: "v" });
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "fresh"), { only: true });
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "drop"), { privateDrop: true });
}));

test("patchModel auto-migrates valid legacy with private/explicit precedence", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("one", { name: "Old", extraPayload: legacyRows({ t: { type: "string", value: "hot" } }) })],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());

  const named = await actions.patchModel("local", "one", { name: "New" }, {
    fieldBaselines: { name: "Old" },
  });
  assert.equal(named.type, "success");
  assert.equal(readNative(agentDir).providers.local!.models![0]!.name, "New");
  assert.equal(Object.hasOwn(readNative(agentDir).providers.local!.models![0]!, "extraPayload"), false);
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "one"), { t: "hot" });

  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("one", { extraPayload: legacyRows({ t: { type: "string", value: "hot" } }) })],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "one", { private: true }));
  const priv = await actions.patchModel("local", "one", { name: "N" }, { fieldBaselines: { name: undefined } });
  assert.equal(priv.type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "one"), { private: true });

  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("one", { extraPayload: legacyRows({ t: { type: "string", value: "hot" } }) })],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "one", { private: true }));
  const explicit = await actions.patchModel("local", "one", { name: "E" }, {
    fieldBaselines: { name: undefined },
    payload: { explicit: 1 },
  });
  assert.equal(explicit.type, "success");
  assert.deepEqual(lookupModelPayload(readPayload(agentDir), "local", "one"), { explicit: 1 });

  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("one", { extraPayload: legacyRows({ t: { type: "string", value: "hot" } }) })],
      },
    },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "one", { private: true }));
  const cleared = await actions.patchModel("local", "one", { name: "C" }, {
    fieldBaselines: { name: undefined },
    payload: null,
  });
  assert.equal(cleared.type, "success");
  assert.equal(lookupModelPayload(readPayload(agentDir), "local", "one"), undefined);

  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("one", { extraPayload: legacyRows({ t: { type: "string", value: "hot" } }) })],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());
  const lockActions = new ModelConfigActions({
    agentDir,
    commitMutation: async () => ({ type: "busy" }),
  });
  const beforeNative = fs.readFileSync(getModelsPath(agentDir));
  const beforePayload = fs.readFileSync(getPayloadConfigPath(agentDir));
  const busy = await lockActions.patchModel("local", "one", { name: "X" }, { fieldBaselines: { name: undefined } });
  assert.equal(busy.type, "lock-busy");
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(beforeNative), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(beforePayload), true);
  assert.equal(Object.hasOwn(readNative(agentDir).providers.local!.models![0]!, "extraPayload"), true);
}));

test("provider delete requires explicit discard for malformed legacy", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("one", { extraPayload: { not: "rows" } })],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());
  const before = fs.readFileSync(getModelsPath(agentDir));
  const blocked = await actions.previewProviderIdentityAction({ kind: "delete", providerId: "local" });
  assert.equal(blocked.type, "validation-error");
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(before), true);
  const ok = await actions.previewProviderIdentityAction({
    kind: "delete",
    providerId: "local",
    legacyDiscardResolution: "discard-malformed-legacy",
  });
  assert.equal(ok.type, "preview");
  if (ok.type !== "preview") return;
  assert.equal((await actions.commitProviderIdentityAction(ok.token)).type, "success");
  assert.equal(Object.hasOwn(readNative(agentDir).providers, "local"), false);
}));
