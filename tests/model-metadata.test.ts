import assert from "node:assert/strict";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { loadModelMetadataCatalog, normalizeModelMetadataCatalog, buildModelMetadataPatch } from "../model-metadata.ts";

const model = {
  id: "gpt-6-astra", name: "GPT-6 Astra", type: "chat", provider: "openai",
  api: "openai-responses", baseUrl: "https://api.openai.com/v1",
  reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 128000,
  cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
  thinkingLevelMap: { low: null, high: "high" },
};
const body = JSON.stringify({ openai: { [model.id]: model } });

test("catalog projection keeps provider variants, zero/false/null-map values and rejects invalid/non-chat entries", () => {
  const entries = normalizeModelMetadataCatalog({
    openai: {
      [model.id]: { ...model, headers: { Authorization: "do-not-copy" }, unknown: true },
      bad: { ...model, id: "bad", maxTokens: -1 },
      classifier: { ...model, id: "classifier", type: "classifier" },
      wrongIdentity: { ...model, id: "different" },
      wrongProvider: { ...model, id: "wrongProvider", provider: "another" },
      incomplete: { id: "incomplete", name: "Partial", api: "openai-responses", provider: "openai" },
    },
    azure: { [model.id]: { ...model, provider: "azure" } },
  });
  assert.deepEqual(entries.map(entry => [entry.provider, entry.model.id]), [
    ["openai", "gpt-6-astra"], ["azure", "gpt-6-astra"],
  ]);
  assert.equal(entries[0]!.model.reasoning, false);
  assert.equal(entries[0]!.model.cost!.input, 0);
  assert.equal(entries[0]!.model.thinkingLevelMap!.low, null);
  for (const key of ["api", "provider", "baseUrl", "headers", "unknown", "type"]) {
    assert.equal(Object.hasOwn(entries[0]!.model, key), false);
  }
  assert.throws(() => normalizeModelMetadataCatalog([]), /格式/);
});

test("metadata patch replaces nested metadata rather than mixing templates and snapshots baselines", () => {
  const target = { id: "alias", compat: { supportsStore: true }, promptCache: { short: 300 }, custom: "keep" };
  const source = { id: "gpt-6-astra", reasoning: false, compat: { supportsTemperature: false } };
  const { patch, fieldBaselines, changes } = buildModelMetadataPatch(target, source);
  assert.deepEqual(patch, { reasoning: false, promptCache: null, compat: { supportsTemperature: false } });
  target.compat.supportsStore = false;
  source.compat.supportsTemperature = true;
  assert.deepEqual(patch.compat, { supportsTemperature: false });
  assert.deepEqual(fieldBaselines.compat, { supportsStore: true });
  assert.equal(Object.hasOwn(fieldBaselines, "name"), true);
  assert.equal(fieldBaselines.name, undefined);
  assert.ok(changes.some(change => /promptCache.*清除/.test(change)));
});

test("catalog requests the host version without Provider credentials and reads chunked JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(url), `https://pi.dev/api/models?pi-version=${VERSION}`);
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    assert.equal(init?.credentials, "omit");
    assert.ok(init?.signal instanceof AbortSignal);
    const bytes = new TextEncoder().encode(body);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 71));
        controller.enqueue(bytes.slice(71));
        controller.close();
      },
    }));
  });
  const entries = await loadModelMetadataCatalog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.provider, "openai");
  assert.equal(entries[0]!.model.maxTokens, 128000);
});

test("preview includes the end of nested metadata such as cost tiers", () => {
  const { changes } = buildModelMetadataPatch({ id: "alias" }, {
    id: model.id, cost: { ...model.cost, tiers: [
      { inputTokensAbove: 128000, input: 3, output: 12, cacheRead: 0.3, cacheWrite: 0 },
      { inputTokensAbove: 512000, input: 6, output: 24, cacheRead: 0.6, cacheWrite: 0.9 },
    ] },
  });
  assert.ok(changes.some(change => change.includes('"cacheWrite":0.9')));
});

for (const kind of ["http", "json", "empty", "shape"] as const) {
  test(`catalog ${kind} failure is explicit rather than becoming an empty selectable template`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      if (kind === "http") return new Response("unavailable", { status: 503 });
      if (kind === "json") return new Response("not json");
      return new Response(kind === "empty" ? "{}" : "[]");
    });
    await assert.rejects(loadModelMetadataCatalog(), /pi\.dev/);
  });
}

for (const declared of [true, false]) {
  test(`catalog size limit rejects ${declared ? "declared" : "streamed"} oversized responses before parsing`, async (t) => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (!declared) controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1).fill(32));
        controller.enqueue(new TextEncoder().encode(body));
      },
      cancel() { cancelled = true; },
    });
    t.mock.method(globalThis, "fetch", async () => new Response(stream, {
      headers: declared ? { "content-length": String(8 * 1024 * 1024 + 1) } : {},
    }));
    // A bounded wait also catches an unbounded .json() on a body that never ends.
    await assert.rejects(Promise.race([
      loadModelMetadataCatalog(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("unbounded body read")), 500)),
    ]), /过大/);
    assert.equal(cancelled, true);
  });
}
