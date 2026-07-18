import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ModelConfigActions } from "../config-actions.ts";
import {
  fetchEndpointModels,
  mergeDiscoveredModels,
  normalizeEndpointModels,
  replaceDiscoveredModels,
  type EndpointDiscoverySuccess,
  type EndpointFetch,
} from "../endpoint-models.ts";
import { getModelsPath } from "../config.ts";
import {
  commitCoordinatedMutation,
  type CommitResult,
  type MutationRequest,
  type PayloadCoordinatorOptions,
} from "../payload-coordinator.ts";
import {
  emptyPayloadDocument,
  getPayloadConfigPath,
  lookupModelPayload,
  parsePayloadDocument,
  serializePayloadDocument,
  setPayloadDocumentValue,
  type PayloadConfig,
} from "../payload-config.ts";
import type { ModelConfig, ModelsConfig, ProviderConfig } from "../types.ts";

function response(body: unknown, status = 200): Awaited<ReturnType<EndpointFetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function discovery(raw: unknown, source = "http://service.test/v1/models"): EndpointDiscoverySuccess {
  const normalized = normalizeEndpointModels(raw);
  assert.equal(normalized.supported, true);
  assert.ok(normalized.models.length > 0);
  return { type: "success", source, ...normalized };
}

function writeNative(agentDir: string, config: ModelsConfig): void {
  fs.writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function readNative(agentDir: string): ModelsConfig {
  return JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")) as ModelsConfig;
}

function writePayload(agentDir: string, payload: PayloadConfig): void {
  fs.writeFileSync(path.join(agentDir, "model-config-payloads.json"), serializePayloadDocument(payload), { mode: 0o600 });
}

function readPayload(agentDir: string): PayloadConfig {
  const filePath = path.join(agentDir, "model-config-payloads.json");
  return fs.existsSync(filePath) ? parsePayloadDocument(fs.readFileSync(filePath), filePath) : emptyPayloadDocument();
}

async function withAgentDir(run: (agentDir: string, actions: ModelConfigActions) => Promise<void>): Promise<void> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-endpoint-models-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await run(agentDir, new ModelConfigActions({ agentDir }));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

const provider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  baseUrl: " http://service.test/api/// ",
  apiKey: "configured-key",
  api: "openai-completions",
  models: [],
  ...overrides,
});

const handEdited = (id: string): ModelConfig => ({
  id,
  name: "Hand edited",
  reasoning: true,
  headers: { "X-Keep": "yes" },
  future: { keep: true },
});

test("fetch probes trimmed models URLs, falls through failures, and accepts supported response shapes", async () => {
  const calls: Array<{ url: string; authorization?: string; signal?: AbortSignal }> = [];
  const bodies = [
    [response(null, 503), response([{ id: "array" }])],
    [response({ data: [{ id: "data" }] })],
    [response({ models: [{ id: "models" }] })],
  ];
  let timeoutMs = 0;

  for (const queue of bodies) {
    const result = await fetchEndpointModels(provider(), {
      fetch: async (url, init) => {
        calls.push({ url, authorization: init.headers.Authorization, signal: init.signal });
        return queue.shift()!;
      },
      timeoutSignal: (ms) => {
        timeoutMs = ms;
        return AbortSignal.abort();
      },
      getEnv: () => undefined,
    });
    assert.equal(result.type, "success");
  }

  assert.equal(timeoutMs, 15_000);
  assert.deepEqual(calls.map((call) => call.url), [
    "http://service.test/api/models",
    "http://service.test/api/v1/models",
    "http://service.test/api/models",
    "http://service.test/api/models",
  ]);
  assert.ok(calls.every((call) => call.authorization === "Bearer configured-key"));
});

test("fetch strips URL userinfo from the public source summary", async () => {
  const result = await fetchEndpointModels(provider({
    baseUrl: "https://account:credential@service.test/api",
  }), {
    fetch: async () => response([{ id: "one" }]),
    timeoutSignal: () => AbortSignal.abort(),
    getEnv: () => undefined,
  });
  assert.equal(result.type, "success");
  if (result.type === "success") assert.equal(result.source, "https://service.test/api/models");
});

test("fetch resolves environment references, passes command references literally, and omits only empty or ollama authorization", async () => {
  const seen: Array<string | undefined> = [];
  const run = async (apiKey: string, envValue?: string): Promise<void> => {
    const result = await fetchEndpointModels(provider({ apiKey }), {
      fetch: async (_url, init) => {
        seen.push(init.headers.Authorization);
        return response([{ id: "one" }]);
      },
      timeoutSignal: () => AbortSignal.abort(),
      getEnv: (name) => name === "MODEL_KEY" ? envValue : undefined,
    });
    assert.equal(result.type, "success");
  };

  await run("$MODEL_KEY", "environment-key");
  await run("$MODEL_KEY");
  await run("!print-key");
  await run("ollama");
  await run("literal-key");

  assert.deepEqual(seen, [
    "Bearer environment-key",
    undefined,
    "Bearer !print-key",
    undefined,
    "Bearer literal-key",
  ]);
});

test("fetch rejects missing configuration and returns bounded non-secret failure diagnostics", async () => {
  let calls = 0;
  const deps = {
    fetch: async () => {
      calls += 1;
      throw new Error("private upstream detail that must not escape");
    },
    timeoutSignal: () => AbortSignal.abort(),
    getEnv: () => undefined,
  };

  assert.deepEqual(await fetchEndpointModels(provider({ baseUrl: "   " }), deps), {
    type: "failure", reason: "missing-base-url", diagnostics: [],
  });
  assert.deepEqual(await fetchEndpointModels(provider({ apiKey: "" }), deps), {
    type: "failure", reason: "missing-api-key", diagnostics: [],
  });

  const failed = await fetchEndpointModels(provider(), deps);
  assert.equal(failed.type, "failure");
  if (failed.type !== "failure") return;
  assert.equal(failed.reason, "request-failed");
  assert.equal(failed.diagnostics.length, 2);
  assert.equal(JSON.stringify(failed).includes("private upstream detail"), false);
  assert.equal(calls, 2);
});

test("fetch treats parse, unsupported, empty, and all-invalid payloads as no-result failures with fallback", async () => {
  const cases: Array<{ first: Awaited<ReturnType<EndpointFetch>>; second: Awaited<ReturnType<EndpointFetch>>; reason: string }> = [
    {
      first: { ok: true, status: 200, json: async () => { throw new Error("parse detail"); } },
      second: response({ nope: [] }),
      reason: "unsupported-shape",
    },
    { first: response([]), second: response({ data: [] }), reason: "empty" },
    { first: response([null, 7, { id: " " }]), second: response({ models: [{ name: "" }] }), reason: "all-invalid" },
  ];

  for (const item of cases) {
    const queue = [item.first, item.second];
    const result = await fetchEndpointModels(provider(), {
      fetch: async () => queue.shift()!,
      timeoutSignal: () => AbortSignal.abort(),
      getEnv: () => undefined,
    });
    assert.equal(result.type, "failure");
    if (result.type === "failure") assert.equal(result.reason, item.reason);
  }
});

test("fetch classifies terminal timeout, HTTP, and parse failures without exposing thrown details", async () => {
  const cases: Array<{
    reason: "timeout" | "http-error" | "parse-error";
    fetch: EndpointFetch;
  }> = [
    {
      reason: "timeout",
      fetch: async () => {
        const error = new Error("timeout transport detail");
        error.name = "AbortError";
        throw error;
      },
    },
    { reason: "http-error", fetch: async () => response(null, 429) },
    {
      reason: "parse-error",
      fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error("parse transport detail"); } }),
    },
  ];

  for (const item of cases) {
    const result = await fetchEndpointModels(provider(), {
      fetch: item.fetch,
      timeoutSignal: () => AbortSignal.abort(),
      getEnv: () => undefined,
    });
    assert.equal(result.type, "failure");
    if (result.type !== "failure") continue;
    assert.equal(result.reason, item.reason);
    assert.equal(result.diagnostics.length, 2);
    assert.equal(JSON.stringify(result).includes("transport detail"), false);
  }
});

test("normalization trims, falls back to name, keeps first duplicates, counts skips, and invents no fields", () => {
  const result = normalizeEndpointModels({ data: [
    { id: " alpha ", name: " Alpha display ", cost: 99, contextWindow: 4 },
    { id: " ", name: " beta " },
    { id: "alpha", name: "later" },
    { id: 3, name: "gamma" },
    null,
    "bad",
    { id: "", name: "" },
  ] });

  assert.equal(result.supported, true);
  assert.equal(result.receivedCount, 7);
  assert.equal(result.validCount, 3);
  assert.equal(result.skippedCount, 3);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.models, [
    { id: "alpha", name: "Alpha display" },
    { id: "beta", name: "beta" },
    { id: "gamma", name: "gamma" },
  ]);
  assert.ok(result.idSummary.ids.length <= 10);
  assert.ok(result.idSummary.ids.every((id) => id.length <= 80));
});

test("normalization distinguishes unsupported, empty, and all-invalid arrays", () => {
  assert.equal(normalizeEndpointModels({ data: "no" }).supported, false);
  const empty = normalizeEndpointModels({ models: [] });
  assert.equal(empty.supported, true);
  assert.equal(empty.receivedCount, 0);
  const invalid = normalizeEndpointModels([{}, null]);
  assert.equal(invalid.supported, true);
  assert.equal(invalid.receivedCount, 2);
  assert.equal(invalid.models.length, 0);
  assert.equal(invalid.skippedCount, 2);
});

test("merge and replace preserve full same-ID objects and add each discovered ID once", () => {
  const existing = [handEdited("same"), { id: "removed", name: "Removed" }];
  const discovered = [{ id: "same", name: "Endpoint name" }, { id: "new" }, { id: "new", name: "duplicate" }];

  const merged = mergeDiscoveredModels(existing, discovered);
  assert.equal(merged[0], existing[0]);
  assert.deepEqual(merged.map((entry) => entry.id), ["same", "removed", "new"]);
  assert.equal(merged.filter((entry) => entry.id === "new").length, 1);

  const replaced = replaceDiscoveredModels(existing, discovered);
  assert.equal(replaced[0], existing[0]);
  assert.deepEqual(replaced.map((entry) => entry.id), ["same", "new"]);
  assert.equal(replaced.filter((entry) => entry.id === "new").length, 1);
});

test("endpoint Merge previews bounded details and commits without overwriting hand edits", async () => withAgentDir(async (agentDir, actions) => {
  const existing = handEdited("same");
  writeNative(agentDir, {
    providers: { local: { baseUrl: "http://service.test", api: "openai-completions", models: [existing] } },
  });
  writePayload(agentDir, emptyPayloadDocument());

  const preview = await actions.previewEndpointChange({
    providerId: "local",
    mode: "merge",
    discovery: discovery([{ id: "same", name: "Remote" }, { id: "new" }]),
  });
  assert.equal(preview.type, "endpoint-preview");
  if (preview.type !== "endpoint-preview") return;
  assert.equal(preview.descriptor.source, "http://service.test/v1/models");
  assert.equal(preview.descriptor.validCount, 2);
  assert.deepEqual(preview.descriptor.introduced.ids, ["new"]);
  assert.deepEqual(preview.descriptor.removed.ids, []);
  assert.deepEqual(preview.descriptor.collisions, []);
  assert.ok(preview.descriptor.idSummary.ids.length <= 10);
  assert.equal(Object.hasOwn(preview as object, "discovery"), false);
  assert.equal(Object.hasOwn(preview.descriptor as object, "models"), false);

  assert.equal((await actions.commitEndpointChange(preview.token)).type, "success");
  const saved = readNative(agentDir).providers.local!.models!;
  assert.deepEqual(saved[0], existing);
  assert.deepEqual(saved[1], { id: "new" });
}));

test("endpoint Replace removes only removed-model payloads and requires explicit introduced collision disposition", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://service.test",
        api: "openai-completions",
        models: [handEdited("same"), { id: "removed" }],
      },
      other: { baseUrl: "http://other.test", api: "openai-completions", models: [{ id: "untouched" }] },
    },
  });
  let payload = setPayloadDocumentValue(emptyPayloadDocument(), "local", "removed", { keep: "no" });
  payload = setPayloadDocumentValue(payload, "local", "new", { keep: "yes" });
  payload = setPayloadDocumentValue(payload, "local", "payload-only", { keep: "always" });
  payload = setPayloadDocumentValue(payload, "other", "untouched", { keep: "other" });
  writePayload(agentDir, payload);

  const preview = await actions.previewEndpointChange({
    providerId: "local",
    mode: "replace",
    discovery: discovery([{ id: "same", name: "Remote" }, { id: "new" }]),
  });
  assert.equal(preview.type, "endpoint-preview");
  if (preview.type !== "endpoint-preview") return;
  assert.deepEqual(preview.descriptor.introduced.ids, ["new"]);
  assert.deepEqual(preview.descriptor.removed.ids, ["removed"]);
  assert.deepEqual(preview.descriptor.collisions, [["local", "new"]]);

  const unresolved = await actions.commitEndpointChange(preview.token);
  assert.equal(unresolved.type, "payload-collision");
  assert.deepEqual(readNative(agentDir).providers.local!.models!.map((entry) => entry.id), ["same", "removed"]);

  const retry = await actions.previewEndpointChange({
    providerId: "local",
    mode: "replace",
    discovery: discovery([{ id: "same" }, { id: "new" }]),
  });
  assert.equal(retry.type, "endpoint-preview");
  if (retry.type !== "endpoint-preview") return;
  assert.equal((await actions.commitEndpointChange(retry.token, { payloadCollisionResolution: "reuse-target" })).type, "success");

  const saved = readNative(agentDir).providers.local!.models!;
  assert.deepEqual(saved.map((entry) => entry.id), ["same", "new"]);
  assert.equal(saved[0]!.name, "Hand edited");
  const savedPayload = readPayload(agentDir);
  assert.equal(lookupModelPayload(savedPayload, "local", "removed"), undefined);
  assert.deepEqual(lookupModelPayload(savedPayload, "local", "new"), { keep: "yes" });
  assert.deepEqual(lookupModelPayload(savedPayload, "local", "payload-only"), { keep: "always" });
  assert.deepEqual(lookupModelPayload(savedPayload, "other", "untouched"), { keep: "other" });
}));

test("endpoint collision replace-target removes the pre-existing target payload", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: { local: { baseUrl: "http://service.test", api: "openai-completions", models: [] } },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "new", { remove: true }));
  const preview = await actions.previewEndpointChange({
    providerId: "local",
    mode: "merge",
    discovery: discovery([{ id: "new" }]),
  });
  assert.equal(preview.type, "endpoint-preview");
  if (preview.type !== "endpoint-preview") return;
  const result = await actions.commitEndpointChange(preview.token, { payloadCollisionResolution: "replace-target" });
  assert.equal(result.type, "success");
  assert.equal(lookupModelPayload(readPayload(agentDir), "local", "new"), undefined);
}));

test("discarding an endpoint preview is a zero-write Cancel and consumes its token", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: { local: { baseUrl: "http://service.test", api: "openai-completions", models: [{ id: "old" }] } },
  });
  writePayload(agentDir, emptyPayloadDocument());
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  const payloadBefore = fs.readFileSync(getPayloadConfigPath(agentDir));
  const preview = await actions.previewEndpointChange({
    providerId: "local", mode: "replace", discovery: discovery([{ id: "new" }]),
  });
  assert.equal(preview.type, "endpoint-preview");
  if (preview.type !== "endpoint-preview") return;
  actions.discardIdentityPreview(preview.token);
  assert.equal((await actions.commitEndpointChange(preview.token)).type, "stale-target");
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
}));

test("endpoint confirmation drift returns a refreshed sanitized preview and performs no commit write", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: { local: { baseUrl: "http://service.test", api: "openai-completions", models: [{ id: "old" }] } },
  });
  writePayload(agentDir, emptyPayloadDocument());
  const preview = await actions.previewEndpointChange({
    providerId: "local", mode: "replace", discovery: discovery([{ id: "new" }]),
  });
  assert.equal(preview.type, "endpoint-preview");
  if (preview.type !== "endpoint-preview") return;

  writeNative(agentDir, {
    providers: { local: { baseUrl: "http://service.test", api: "openai-completions", models: [{ id: "external" }] } },
  });
  const externalBytes = fs.readFileSync(getModelsPath(agentDir));
  const stale = await actions.commitEndpointChange(preview.token);
  assert.equal(stale.type, "stale-target");
  if (stale.type !== "stale-target") return;
  assert.equal(stale.path, "endpoint-preview");
  assert.ok(stale.endpointPreview);
  assert.deepEqual(stale.endpointPreview!.introduced.ids, ["new"]);
  assert.deepEqual(stale.endpointPreview!.removed.ids, ["external"]);
  assert.equal(Object.hasOwn(stale.endpointPreview as object, "models"), false);
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(externalBytes), true);
  actions.discardIdentityPreview(stale.endpointPreview!.token);
}));

test("endpoint confirmation detects payload hash drift even when collision identities are unchanged", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: { local: { baseUrl: "http://service.test", api: "openai-completions", models: [] } },
  });
  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "new", { revision: 1 }));
  const preview = await actions.previewEndpointChange({
    providerId: "local", mode: "merge", discovery: discovery([{ id: "new" }]),
  });
  assert.equal(preview.type, "endpoint-preview");
  if (preview.type !== "endpoint-preview") return;

  writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "new", { revision: 2 }));
  const stale = await actions.commitEndpointChange(preview.token, { payloadCollisionResolution: "reuse-target" });
  assert.equal(stale.type, "stale-target");
  if (stale.type !== "stale-target") return;
  assert.deepEqual(stale.endpointPreview?.collisions, [["local", "new"]]);
  assert.deepEqual(readNative(agentDir).providers.local!.models, []);
  if (stale.endpointPreview) actions.discardIdentityPreview(stale.endpointPreview.token);
}));

test("endpoint Replace requires explicit discard before removing malformed legacy rows", async () => withAgentDir(async (agentDir, actions) => {
  writeNative(agentDir, {
    providers: {
      local: {
        baseUrl: "http://service.test",
        api: "openai-completions",
        models: [{ id: "old", extraPayload: { not: "legacy rows" } }],
      },
    },
  });
  writePayload(agentDir, emptyPayloadDocument());
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  const request = { providerId: "local", mode: "replace" as const, discovery: discovery([{ id: "new" }]) };
  const blockedPreview = await actions.previewEndpointChange(request);
  assert.equal(blockedPreview.type, "endpoint-preview");
  if (blockedPreview.type !== "endpoint-preview") return;
  assert.deepEqual(blockedPreview.descriptor.malformedIdentities, [["local", "old"]]);
  assert.equal((await actions.commitEndpointChange(blockedPreview.token)).type, "validation-error");
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);

  const confirmedPreview = await actions.previewEndpointChange(request);
  assert.equal(confirmedPreview.type, "endpoint-preview");
  if (confirmedPreview.type !== "endpoint-preview") return;
  const committed = await actions.commitEndpointChange(confirmedPreview.token, {
    legacyDiscardResolution: "discard-malformed-legacy",
  });
  assert.equal(committed.type, "success");
  assert.deepEqual(readNative(agentDir).providers.local!.models, [{ id: "new" }]);
}));

test("endpoint commits preserve distinct lock outcomes and write neither artifact", async () => withAgentDir(async (agentDir) => {
  writeNative(agentDir, {
    providers: { local: { baseUrl: "http://service.test", api: "openai-completions", models: [] } },
  });
  writePayload(agentDir, emptyPayloadDocument());
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  const payloadBefore = fs.readFileSync(getPayloadConfigPath(agentDir));

  for (const lockType of ["busy", "collision", "unsupported"] as const) {
    const actions = new ModelConfigActions({ agentDir, commitMutation: async () => ({ type: lockType }) });
    const preview = await actions.previewEndpointChange({
      providerId: "local", mode: "merge", discovery: discovery([{ id: lockType }]),
    });
    assert.equal(preview.type, "endpoint-preview");
    if (preview.type !== "endpoint-preview") continue;
    const result = await actions.commitEndpointChange(preview.token);
    assert.equal(result.type, `lock-${lockType}`);
    assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
    assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
  }
}));

test("endpoint Replace remains crash-coherent at every coordinator boundary", async () => withAgentDir(async (agentDir) => {
  for (const failAt of ["journal", "native", "payload", "journal-removed"] as const) {
    writeNative(agentDir, {
      providers: { local: { baseUrl: "http://service.test", api: "openai-completions", models: [{ id: "old" }] } },
    });
    writePayload(agentDir, setPayloadDocumentValue(emptyPayloadDocument(), "local", "old", { remove: true }));
    const journalPath = path.join(agentDir, "model-config-transaction.json");
    if (fs.existsSync(journalPath)) fs.rmSync(journalPath);

    const actions = new ModelConfigActions({
      agentDir,
      commitMutation: async (request: MutationRequest, options?: PayloadCoordinatorOptions): Promise<CommitResult> => {
        return commitCoordinatedMutation({
          ...request,
          onBoundary(boundary) {
            if (boundary === failAt) throw new Error(`fault:${boundary}`);
          },
        }, options);
      },
    });
    const preview = await actions.previewEndpointChange({
      providerId: "local", mode: "replace", discovery: discovery([{ id: "new" }]),
    });
    assert.equal(preview.type, "endpoint-preview");
    if (preview.type !== "endpoint-preview") continue;
    await assert.rejects(actions.commitEndpointChange(preview.token), new RegExp(`fault:${failAt}`));

    const recovery = new ModelConfigActions({ agentDir }).readEditorSnapshot();
    if (failAt === "journal-removed") {
      assert.equal(recovery.type, "snapshot");
      assert.deepEqual(readNative(agentDir).providers.local!.models!.map((entry) => entry.id), ["new"]);
      assert.equal(lookupModelPayload(readPayload(agentDir), "local", "old"), undefined);
    } else {
      assert.deepEqual(recovery, { type: "recovery-required" });
    }
  }
}));
