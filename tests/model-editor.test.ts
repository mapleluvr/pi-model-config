import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelCategories,
  buildModelOverrideCategories,
} from "../model-editor.ts";

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
