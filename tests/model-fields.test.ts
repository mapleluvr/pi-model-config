import assert from "node:assert/strict";
import test from "node:test";

import {
  deepCloneJson,
  deepEqualJson,
  mergeModelConfig,
  mergeProviderConfig,
  readModelSubtree,
  readProviderSubtree,
  replaceCostTiers,
  validateCostTier,
  writeModelSubtree,
  writeProviderSubtree,
} from "../model-fields.ts";

test("provider merge changes managed values while retaining headers, modelOverrides, and unknown values", () => {
  const result = mergeProviderConfig({
    name: "Old", baseUrl: "https://old", headers: { "X-Keep": "1" },
    modelOverrides: { "known/model": { maxTokens: 99 } }, nativeFlag: true,
  }, { name: "New", baseUrl: "https://new", api: "openai-completions" });
  assert.deepEqual(result, {
    name: "New", baseUrl: "https://new", api: "openai-completions",
    headers: { "X-Keep": "1" }, modelOverrides: { "known/model": { maxTokens: 99 } }, nativeFlag: true,
  });
});

test("model merge retains native values, thinking max, compat, and existing cost tiers", () => {
  const result = mergeModelConfig({
    id: "old", api: "openai-completions", baseUrl: "https://host", headers: { "X-Keep": "1" },
    thinkingLevelMap: { max: "max" }, compat: { supportsTemperature: true },
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, tiers: [{ inputTokensAbove: 1000, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }] },
  }, { id: "new", name: "New" });
  assert.equal(result.id, "new");
  assert.deepEqual(result.thinkingLevelMap, { max: "max" });
  assert.deepEqual(result.cost?.tiers, [{ inputTokensAbove: 1000, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }]);
  assert.deepEqual(result.headers, { "X-Keep": "1" });
  assert.deepEqual(result.compat, { supportsTemperature: true });
});

test("model merge retains omitted or undefined native fields and clears explicit null fields", () => {
  const existing = { id: "model", headers: { "X-Keep": "1" }, nativeFlag: true };
  assert.deepEqual(mergeModelConfig(existing, {}), existing);
  assert.deepEqual(mergeModelConfig(existing, { nativeFlag: undefined }), existing);
  assert.deepEqual(mergeModelConfig(existing, { nativeFlag: null }), {
    id: "model", headers: { "X-Keep": "1" },
  });
});

test("only explicit null clears a native field", () => {
  const retained = mergeModelConfig({ id: "model", headers: { "X-Keep": "yes" } }, { id: "model", name: "Renamed" });
  assert.deepEqual(retained.headers, { "X-Keep": "yes" });
  const cleared = mergeModelConfig(retained, { headers: null });
  assert.equal(cleared.headers, undefined);
});

test("cost tiers require a positive integer threshold and non-negative finite rates", () => {
  assert.deepEqual(validateCostTier({ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }), {
    inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5,
  });
  assert.equal(validateCostTier({ inputTokensAbove: 0, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }), undefined);
  assert.equal(validateCostTier({ inputTokensAbove: 100.5, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }), undefined);
  assert.equal(validateCostTier({ inputTokensAbove: 100, input: -1, output: 1, cacheRead: 1, cacheWrite: 1 }), undefined);
  assert.equal(validateCostTier({ inputTokensAbove: 100, input: Number.NaN, output: 1, cacheRead: 1, cacheWrite: 1 }), undefined);
  assert.equal(validateCostTier({ inputTokensAbove: 100, input: 1, output: Infinity, cacheRead: 1, cacheWrite: 1 }), undefined);
});

test("replaces only tiers while retaining base cost rates", () => {
  assert.deepEqual(replaceCostTiers({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, [
    { inputTokensAbove: 100, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
  ]), {
    input: 1, output: 2, cacheRead: 3, cacheWrite: 4,
    tiers: [{ inputTokensAbove: 100, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }],
  });
});

test("clears existing cost tiers when replacement is empty", () => {
  assert.deepEqual(replaceCostTiers({
    input: 1, output: 2, cacheRead: 3, cacheWrite: 4,
    tiers: [{ inputTokensAbove: 100, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }],
  }, []), {
    input: 1, output: 2, cacheRead: 3, cacheWrite: 4,
  });
});

test("deep clone and equality helpers preserve false/zero and isolate mutations", () => {
  const original = { enabled: false, count: 0, nested: { keep: true } };
  const clone = deepCloneJson(original);
  clone.nested.keep = false;
  assert.equal(original.nested.keep, true);
  assert.equal(deepEqualJson({ a: false, b: 0 }, { a: false, b: 0 }), true);
  assert.equal(deepEqualJson({ a: false }, { a: true }), false);
});

test("provider and model subtree helpers clone exact objects", () => {
  const provider = { headers: { "X-Keep": "1" }, compat: { supportsTemperature: false } };
  const headers = readProviderSubtree(provider, "headers");
  assert.deepEqual(headers, { "X-Keep": "1" });
  (headers as Record<string, string>)["X-Keep"] = "mutated";
  assert.equal(provider.headers["X-Keep"], "1");
  const nextProvider = writeProviderSubtree(provider, "headers", { "X-New": "2" });
  assert.deepEqual(nextProvider.headers, { "X-New": "2" });
  assert.deepEqual(provider.headers, { "X-Keep": "1" });

  const model = { id: "m", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const cost = readModelSubtree(model, "cost");
  assert.deepEqual(cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const nextModel = writeModelSubtree(model, "cost", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.deepEqual(nextModel.cost, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
});
