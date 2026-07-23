import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelCategories,
  buildModelOverrideCategories,
  createModelAndOpen,
  editModelOverrideEntryDraft,
  runModelEditor,
} from "../model-editor.ts";
import type { SettingsPanelResult } from "../settings-panel.ts";

function catalog(categories: ReturnType<typeof buildModelCategories>): Array<[string, string[]]> {
  return categories.map((category) => [category.id, category.fields.map((field) => field.id)]);
}

test("Model catalog uses the exact stable category and field IDs", () => {
  assert.deepEqual(catalog(buildModelCategories({
    id: "example",
    reasoning: false,
    input: ["text"],
    contextWindow: 0,
    maxTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }, undefined)), [
    ["general", ["id", "name"]],
    ["endpoint", ["api", "baseUrl", "headers"]],
    ["capability", ["reasoning", "input", "contextWindow", "maxTokens"]],
    ["thinking", ["thinkingLevelMap"]],
    ["cost", ["input", "output", "cacheRead", "cacheWrite", "tiers"]],
    ["compatibility", ["compat"]],
    ["payload", ["payload"]],
    ["actions", ["copy", "delete"]],
  ]);
});

test("Model descriptors preserve false, zero, absent, nested counts, and Thinking Map state", () => {
  const inactive = buildModelCategories({
    id: "example",
    reasoning: false,
    input: ["text"],
    contextWindow: 0,
    maxTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] },
    thinkingLevelMap: { max: "provider-max" },
  }, { count: 0 });
  const fields = new Map(inactive.flatMap((category) => category.fields.map((field) => [field.id, field])));
  assert.equal(fields.get("reasoning")?.displayValue, "false");
  assert.equal(fields.get("contextWindow")?.displayValue, "0");
  assert.equal(fields.get("cacheWrite")?.displayValue, "0");
  assert.equal(fields.get("thinkingLevelMap")?.warning, "Reasoning 已关闭；Thinking Map 会保留但当前不生效");
  assert.equal(fields.get("payload")?.displayValue, "0 项");

  const active = buildModelCategories({ id: "example", reasoning: true, thinkingLevelMap: { max: "provider-max" } }, undefined);
  assert.equal(active.find((category) => category.id === "thinking")?.fields[0]?.warning, undefined);
});

test("Override draft requires explicit previewed cleanup and preserves cancel bytes", async () => {
  const original = { api: "forbidden", cost: { input: 1, futureNested: { keep: true } } } as any;
  const panels = [
    { type: "back", state: { categoryId: "general", fieldId: "name", focusedPane: "fields", categoryScrollOffset: 0, fieldScrollOffset: 0, narrowScreen: "fields" } },
    { type: "back", state: { categoryId: "general", fieldId: "name", focusedPane: "fields", categoryScrollOffset: 0, fieldScrollOffset: 0, narrowScreen: "fields" } },
  ];
  const notifications: string[] = [];
  let menuCalls = 0;
  const ctx = {
    ui: {
      select: async (_title: string, options: string[]) => {
        if (!options.includes("查看不支持字段")) return undefined;
        menuCalls += 1;
        return menuCalls === 1 ? "查看不支持字段" : "取消并保留原值";
      },
      input: async () => undefined,
      editor: async () => undefined,
      notify: (message: string) => notifications.push(message),
    },
  } as any;
  const first = await (await import("../model-editor.ts")).editModelOverrideEntryDraft(ctx, "target", original, {
    openPanel: async () => panels.shift() as any,
  });
  assert.equal(first.status, "discard");
  if (first.status === "discard") assert.deepEqual(first.value, original);
  assert.ok(notifications.some((message) => message.includes("不支持")));
});

test("Override catalog exposes only the approved restricted surface", () => {
  const categories = buildModelOverrideCategories("target", {
    name: "Target",
    future: { keep: true },
    cost: { input: 0, futureNested: true },
  });
  assert.deepEqual(categories.map((category) => [category.id, category.fields.map((field) => field.id)]), [
    ["general", ["targetId", "name"]],
    ["capability", ["reasoning", "input", "contextWindow", "maxTokens"]],
    ["thinking", ["thinkingLevelMap"]],
    ["cost", ["input", "output", "cacheRead", "cacheWrite", "tiers"]],
    ["headers", ["headers"]],
    ["compatibility", ["compat"]],
  ]);
  const ids = categories.flatMap((category) => category.fields.map((field) => field.id));
  for (const forbidden of ["id", "api", "baseUrl", "payload"]) assert.equal(ids.includes(forbidden), false);
});

function panelResult(type: SettingsPanelResult["type"], categoryId = "general", fieldId = "id"): SettingsPanelResult {
  return {
    type: type as any,
    categoryId,
    fieldId,
    state: {
      categoryId,
      fieldId,
      focusedPane: "fields",
      categoryScrollOffset: 0,
      fieldScrollOffset: 0,
      narrowScreen: "fields",
    },
  } as SettingsPanelResult;
}

function modelSnapshot(model: Record<string, unknown>): any {
  return {
    type: "snapshot",
    native: { providers: { local: { models: [model] } } },
    payload: { version: 1, extraPayloads: {} },
    nativeHash: "native",
    payloadHash: "payload",
  };
}

test("Built-in Provider Add Model is allowed without Provider-level API", async () => {
  const provider: Record<string, unknown> = { models: [] };
  let createCalls = 0;
  let panelCalls = 0;
  const actions = {
    readEditorSnapshot: () => ({
      type: "snapshot",
      native: { providers: { openai: provider } },
      payload: { version: 1, extraPayloads: {} },
      nativeHash: "native",
      payloadHash: "payload",
    }),
    createModel: async (_providerId: string, model: Record<string, unknown>) => {
      createCalls += 1;
      provider.models = [model];
      return { type: "success" };
    },
  } as any;
  const ctx = {
    ui: {
      input: async () => "created",
      notify() {},
    },
  } as any;
  const created = await createModelAndOpen(ctx, "openai", {
    actions,
    openPanel: async () => {
      panelCalls += 1;
      return panelResult("back");
    },
  });
  assert.equal(created, "created");
  assert.equal(createCalls, 1);
  assert.equal(panelCalls, 1);
  assert.equal((provider.models as Array<Record<string, unknown>>)[0]!.id, "created");
});

test("Model search restores the selected field and panel state", async () => {
  const model = { id: "one", future: { keep: true } };
  const states: Array<Record<string, unknown>> = [];
  const panels = [panelResult("search"), panelResult("back", "capability", "maxTokens")];
  const actions = { readEditorSnapshot: () => modelSnapshot(model) } as any;
  await runModelEditor({ ui: { notify() {} } } as any, "local", "one", {
    actions,
    search: async () => "capability:maxTokens",
    openPanel: async (_ctx, _model, state) => {
      states.push({ ...state });
      return panels.shift()!;
    },
  });
  assert.equal(states[1]!.categoryId, "capability");
  assert.equal(states[1]!.fieldId, "maxTokens");
  assert.equal(states[1]!.focusedPane, "fields");
});

test("Model nested conflict retains the draft and original optimistic baseline", async () => {
  const model = { id: "one", headers: { Existing: "yes" }, future: { keep: true } };
  const calls: Array<{ baseline: unknown; next: unknown }> = [];
  const actions = {
    readEditorSnapshot: () => modelSnapshot(model),
    saveModelSubtree: async (_providerId: string, _modelId: string, _key: string, baseline: unknown, next: unknown) => {
      calls.push({ baseline, next });
      return calls.length === 1
        ? { type: "subtree-conflict", path: "headers", nativeHash: "n", payloadHash: "p" }
        : { type: "success" };
    },
  } as any;
  const panels = [
    panelResult("open-section", "endpoint", "headers"),
    panelResult("open-section", "endpoint", "headers"),
    panelResult("back"),
  ];
  const selects = ["新增条目", "保存并返回", "保存并返回"];
  const inputs = ["X-Test", "draft"];
  const ctx = {
    ui: {
      select: async () => selects.shift(),
      input: async () => inputs.shift(),
      notify() {},
    },
  } as any;
  await runModelEditor(ctx, "local", "one", { actions, openPanel: async () => panels.shift()! });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.baseline, { Existing: "yes" });
  assert.deepEqual(calls[1]!.baseline, { Existing: "yes" });
  assert.deepEqual(calls[1]!.next, { Existing: "yes", "X-Test": "draft" });
});

test("Native optional Model fields can all be restored to absence without touching unknown fields", async () => {
  const model: Record<string, unknown> = {
    id: "one",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 4096,
    maxTokens: 1024,
    future: { keep: true },
  };
  const actions = {
    readEditorSnapshot: () => modelSnapshot(model),
    patchModel: async (_providerId: string, _modelId: string, patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete model[key];
        else model[key] = value;
      }
      return { type: "success" };
    },
  } as any;
  const panels = [
    panelResult("edit-field", "capability", "reasoning"),
    panelResult("edit-field", "capability", "input"),
    panelResult("edit-field", "capability", "contextWindow"),
    panelResult("edit-field", "capability", "maxTokens"),
    panelResult("back"),
  ];
  const selects = ["使用默认值", "使用默认值", "使用默认值", "使用默认值"];
  const ctx = { ui: { select: async () => selects.shift(), notify() {} } } as any;
  await runModelEditor(ctx, "local", "one", {
    actions,
    openPanel: async () => panels.shift()!,
    multiSelect: async () => { throw new Error("default input must not open explicit selection"); },
  });
  for (const key of ["reasoning", "input", "contextWindow", "maxTokens"]) {
    assert.equal(Object.hasOwn(model, key), false, `${key} should be absent`);
  }
  assert.deepEqual(model.future, { keep: true });
  assert.deepEqual(selects, []);
});

for (const fieldId of ["input", "tiers"] as const) {
  test(`Native Cost can be cleared as a whole from ${fieldId}`, async () => {
    const model: Record<string, unknown> = {
      id: "one",
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, futureNested: { keep: true } },
      future: { keep: true },
    };
    const calls: Array<{ baseline: unknown; next: unknown }> = [];
    const actions = {
      readEditorSnapshot: () => modelSnapshot(model),
      saveModelSubtree: async (_providerId: string, _modelId: string, key: string, baseline: unknown, next: unknown) => {
        calls.push({ baseline, next });
        if (key === "cost" && (next === null || next === undefined)) delete model.cost;
        return { type: "success" };
      },
    } as any;
    const panels = [panelResult(fieldId === "tiers" ? "open-section" : "edit-field", "cost", fieldId), panelResult("back")];
    const selects = ["清除整个 Cost（使用默认值）"];
    const ctx = { ui: { select: async () => selects.shift(), notify() {} } } as any;
    await runModelEditor(ctx, "local", "one", { actions, openPanel: async () => panels.shift()! });
    assert.equal(Object.hasOwn(model, "cost"), false);
    assert.deepEqual(calls, [{
      baseline: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, futureNested: { keep: true } },
      next: null,
    }]);
    assert.deepEqual(model.future, { keep: true });
  });
}

test("Override Thinking Map warning follows the edited override draft only", async () => {
  const seenWarnings: Array<string | undefined> = [];
  const panels = [
    panelResult("edit-field", "capability", "reasoning"),
    panelResult("back", "thinking", "thinkingLevelMap"),
  ];
  const ctx = { ui: { select: async () => "false", notify() {} } } as any;
  const result = await editModelOverrideEntryDraft(ctx, "target", {
    reasoning: true,
    thinkingLevelMap: { high: "provider-high" },
  }, {
    openPanel: async (_ctx, panel) => {
      const field = panel.categories.find((category) => category.id === "thinking")?.fields[0];
      seenWarnings.push(field?.warning);
      return panels.shift()!;
    },
  });
  assert.equal(result.status, "save");
  assert.deepEqual(seenWarnings, [undefined, "Reasoning 已关闭；Thinking Map 会保留但当前不生效"]);
  if (result.status === "save") assert.deepEqual(result.value.thinkingLevelMap, { high: "provider-high" });
});
