import test from "node:test";
import assert from "node:assert/strict";
import {
  buildModelCategories,
  buildModelOverrideCategories,
  editModelOverrideEntryDraft,
} from "../model-editor.ts";
import {
  readModelSubtree,
  writeModelSubtree,
} from "../model-fields.ts";
import { collectPositiveFiniteNumber } from "../field-editors.ts";
import { stripDeprecatedCompatKeys } from "../compat-settings.ts";
import type { ModelConfig, ModelOverrideConfig } from "../types.ts";

test("Model Editor 1.1.0: buildModelCategories displays new fields", () => {
  const model: ModelConfig = {
    id: "gpt-5",
    inputLimits: { maxRequestBytes: 10485760 },
    promptCache: { short: 300, long: 3600 },
    samplingParamsByThinkingLevel: { high: { temperature: 0.7 } },
  };
  const categories = buildModelCategories(model);
  const cap = categories.find((c) => c.id === "capability");
  assert.ok(cap);
  assert.ok(cap!.fields.some((f) => f.id === "inputLimits" && f.displayValue === "1 项"));
  assert.ok(cap!.fields.some((f) => f.id === "promptCache" && f.displayValue === "2 项"));

  const thinking = categories.find((c) => c.id === "thinking");
  assert.ok(thinking);
  assert.ok(thinking!.fields.some((f) => f.id === "samplingParamsByThinkingLevel" && f.displayValue === "1 档"));
});

test("Model Editor 1.1.0: buildModelOverrideCategories displays new fields", () => {
  const override: ModelOverrideConfig = {
    inputLimits: { maxRequestBytes: 5242880 },
    promptCache: { short: 600 },
    samplingParamsByThinkingLevel: { low: { top_p: 0.8 } },
  };
  const categories = buildModelOverrideCategories("gpt-5", override);
  const cap = categories.find((c) => c.id === "capability");
  assert.ok(cap);
  assert.ok(cap!.fields.some((f) => f.id === "inputLimits" && f.displayValue === "1 项"));
  assert.ok(cap!.fields.some((f) => f.id === "promptCache" && f.displayValue === "1 项"));

  const thinking = categories.find((c) => c.id === "thinking");
  assert.ok(thinking);
  assert.ok(thinking!.fields.some((f) => f.id === "samplingParamsByThinkingLevel" && f.displayValue === "1 档"));
});

test("Model Editor 1.1.0: new 1.1.0 fields are NOT flagged as unsupported override paths", async () => {
  const overrideWithNewFields: ModelOverrideConfig = {
    name: "Custom Name",
    inputLimits: { maxRequestBytes: 10485760 },
    promptCache: { short: 300, long: 3600 },
    samplingParamsByThinkingLevel: { high: { temperature: 0.7 } },
  };

  const panels = [
    { type: "back", state: { categoryId: "general", fieldId: "name", focusedPane: "fields", categoryScrollOffset: 0, fieldScrollOffset: 0, narrowScreen: "fields" } },
  ];
  const ctx = {
    ui: {
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => {},
    },
  } as any;

  const result = await editModelOverrideEntryDraft(ctx, "target", overrideWithNewFields, {
    openPanel: async () => panels.shift() as any,
  });

  assert.equal(result.status, "save");
  assert.deepEqual(result.unsupportedPaths, []);
  assert.deepEqual(result.value.inputLimits, { maxRequestBytes: 10485760 });
  assert.deepEqual(result.value.promptCache, { short: 300, long: 3600 });
  assert.deepEqual(result.value.samplingParamsByThinkingLevel, { high: { temperature: 0.7 } });
});

test("Model Fields 1.1.0: readModelSubtree and writeModelSubtree support new subtrees", () => {
  let model: ModelConfig = { id: "test-model" };

  // inputLimits
  model = writeModelSubtree(model, "inputLimits", { maxRequestBytes: 2048 });
  assert.deepEqual(readModelSubtree(model, "inputLimits"), { maxRequestBytes: 2048 });

  // promptCache
  model = writeModelSubtree(model, "promptCache", { short: 100 });
  assert.deepEqual(readModelSubtree(model, "promptCache"), { short: 100 });

  // samplingParamsByThinkingLevel
  model = writeModelSubtree(model, "samplingParamsByThinkingLevel", { high: { temp: 0.5 } });
  assert.deepEqual(readModelSubtree(model, "samplingParamsByThinkingLevel"), { high: { temp: 0.5 } });

  // clearing
  model = writeModelSubtree(model, "promptCache", null);
  assert.equal(readModelSubtree(model, "promptCache"), undefined);
  assert.equal("promptCache" in model, false);
});

test("Compat 1.1.0: stripDeprecatedCompatKeys deletes deferredToolsMode and supportsToolReferences cleanly", () => {
  const dirtyCompat = {
    deferredToolsMode: "kimi",
    supportsToolReferences: true,
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
    allowedFallbackModels: [{ provider: "p", model: "m", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    unknownExtension: { keep: true },
  };
  const clean = stripDeprecatedCompatKeys(dirtyCompat);
  assert.equal("deferredToolsMode" in clean, false);
  assert.equal("supportsToolReferences" in clean, false);
  assert.equal(clean.supportsMidConvoSystemMessages, true);
  assert.equal(clean.supportsMidConvoToolChanges, true);
  assert.deepEqual(clean.unknownExtension, { keep: true });
});

test("Field Editors 1.1.0: collectPositiveFiniteNumber supports positive floats (P2-8)", async () => {
  const inputs = ["invalid", "-5", "0", "0.5"];
  const errors: string[] = [];
  const ctx = {
    ui: {
      input: async () => inputs.shift(),
      notify: (msg: string) => errors.push(msg),
    },
  } as any;

  const res = await collectPositiveFiniteNumber(ctx, "测试 Prompt Cache");
  assert.equal(res.status, "value");
  assert.equal(res.value, 0.5);
  assert.equal(errors.length, 3);
});
