import assert from "node:assert/strict";
import test from "node:test";

import {
  collectApiKeyAction,
  collectNonNegativeRate,
  collectOptionalString,
  collectPositiveInteger,
  collectRequiredString,
  editCompatDraft,
  editCostDraft,
  editPayloadDraft,
  editStringMapDraft,
  editThinkingMapDraft,
  formatApiKeyReference,
  formatNestedCount,
  formatSettingValue,
  maskApiKey,
} from "../field-editors.ts";
import { createScriptedUi, assertRecordedUiDoesNotContain } from "./helpers/scripted-ui.ts";

test("formats absent, inherited, false, zero, strings, and nested counts without truthiness shortcuts", () => {
  assert.equal(formatSettingValue(undefined), "(未设置)");
  assert.equal(formatSettingValue(undefined, "inherited"), "(继承)");
  assert.equal(formatSettingValue(false), "false");
  assert.equal(formatSettingValue(0), "0");
  assert.equal(formatSettingValue(""), "");
  assert.equal(formatNestedCount(undefined, "项"), "(未设置)");
  assert.equal(formatNestedCount({}, "项"), "0 项");
  assert.equal(formatNestedCount({ a: 1, b: 2 }, "项"), "2 项");
  assert.equal(formatNestedCount([1, 2, 3], "项"), "3 项");
});

test("masks literal API keys while leaving environment and command references visible", () => {
  assert.equal(maskApiKey("short"), "*****");
  assert.equal(maskApiKey("literal-value-1234"), "************1234");
  assert.equal(formatApiKeyReference("$MODEL_API_KEY"), "$MODEL_API_KEY");
  assert.equal(formatApiKeyReference("!credential read model"), "!credential read model");
  assert.equal(formatApiKeyReference(undefined), "(未设置)");
});

test("scalar collectors return explicit cancel, clear, and validated value outcomes", async () => {
  const optional = createScriptedUi({ selects: ["输入值"], inputs: [" ", " value "] });
  assert.deepEqual(await collectOptionalString(optional.ctx, "可选值"), { status: "value", value: "value" });
  assert.ok(optional.calls.some((call) => call.kind === "notify"));

  const clear = createScriptedUi({ selects: ["清除值"] });
  assert.deepEqual(await collectOptionalString(clear.ctx, "可选值"), { status: "clear" });

  const required = createScriptedUi({ inputs: ["", "required"] });
  assert.deepEqual(await collectRequiredString(required.ctx, "必填值"), { status: "value", value: "required" });

  const cancelled = createScriptedUi({ inputs: [undefined] });
  assert.deepEqual(await collectRequiredString(cancelled.ctx, "必填值"), { status: "cancel" });
});

test("numeric collectors reject invalid values and return typed numbers", async () => {
  const integer = createScriptedUi({ inputs: ["0", "2.5", "12"] });
  assert.deepEqual(await collectPositiveInteger(integer.ctx, "令牌数量"), { status: "value", value: 12 });
  assert.equal(integer.calls.filter((call) => call.kind === "notify").length, 2);

  const rate = createScriptedUi({ inputs: ["", " \t ", "-1", "Infinity", "0"] });
  assert.deepEqual(await collectNonNegativeRate(rate.ctx, "费率"), { status: "value", value: 0 });
  assert.equal(rate.calls.filter((call) => call.kind === "notify").length, 4);
});

test("API-key replacement never exposes the stored literal to any UI argument", async () => {
  const storedFixtureValue = "stored-fixture-value-4321";
  const scripted = createScriptedUi({ selects: ["替换"], inputs: ["new-entry-value"] });
  assert.deepEqual(await collectApiKeyAction(scripted.ctx, storedFixtureValue), {
    status: "replace",
    value: "new-entry-value",
  });
  assertRecordedUiDoesNotContain(scripted.calls, storedFixtureValue);
  const input = scripted.calls.find((call) => call.kind === "input");
  assert.ok(input && input.kind === "input");
  assert.equal(input.placeholder, "输入新的 API Key");
  assert.ok(scripted.calls.some((call) => call.kind === "notify" && call.level === "warning"));
});

test("API-key Keep, Clear, and cancellation are explicit outcomes", async () => {
  const keep = createScriptedUi({ selects: ["保留"] });
  assert.deepEqual(await collectApiKeyAction(keep.ctx, "fixture-current"), { status: "keep" });
  const clear = createScriptedUi({ selects: ["清除"] });
  assert.deepEqual(await collectApiKeyAction(clear.ctx, "fixture-current"), { status: "clear" });
  const cancel = createScriptedUi({ selects: [undefined] });
  assert.deepEqual(await collectApiKeyAction(cancel.ctx, "fixture-current"), { status: "cancel" });
});

test("string-map draft saves selected changes, rejects duplicates, and preserves other entries", async () => {
  const existing = { Known: "old", Future: "keep" };
  const scripted = createScriptedUi({
    selects: ["Known = string", "编辑值", "新增条目", "保存并返回"],
    inputs: ["new", "Known"],
  });
  const result = await editStringMapDraft(scripted.ctx, "请求头", existing);
  assert.deepEqual(result, { status: "save", value: { Known: "new", Future: "keep" } });
  assert.deepEqual(existing, { Known: "old", Future: "keep" });
  assert.ok(scripted.calls.some((call) => call.kind === "notify"));
});

test("discard abandons an isolated string-map draft", async () => {
  const existing = { Known: "old", Future: "keep" };
  const scripted = createScriptedUi({
    selects: ["Known = string", "编辑值", "放弃更改"],
    inputs: ["new"],
  });
  assert.deepEqual(await editStringMapDraft(scripted.ctx, "请求头", existing), { status: "discard" });
  assert.deepEqual(existing, { Known: "old", Future: "keep" });
});

test("compat draft patches known fields and preserves future keys at nested levels", async () => {
  const existing = {
    supportsStore: false,
    openRouterRouting: { only: ["old"], futureNested: { retain: true } },
    futureRoot: { retain: true },
  };
  const scripted = createScriptedUi({
    selects: [
      "[false] supportsStore",
      "true",
      "[对象] openRouterRouting",
      "编辑 JSON 对象",
      "保存并返回",
    ],
    editors: ['{"only":["new"]}'],
  });
  const result = await editCompatDraft(scripted.ctx, "兼容性", existing);
  assert.deepEqual(result, {
    status: "save",
    value: {
      supportsStore: true,
      openRouterRouting: { only: ["new"], futureNested: { retain: true } },
      futureRoot: { retain: true },
    },
  });
  assert.deepEqual(existing.openRouterRouting.only, ["old"]);
});

test("thinking-map draft covers max, warns when inactive, and preserves unknown data", async () => {
  const existing = { off: null, max: "provider-max", futureLevel: { retain: true } };
  const scripted = createScriptedUi({
    selects: ["max = provider-max", "设置映射值", "保存并返回"],
    inputs: ["mapped-max"],
  });
  const result = await editThinkingMapDraft(scripted.ctx, "思考级别映射", existing, false);
  assert.deepEqual(result, {
    status: "save",
    value: { off: null, max: "mapped-max", futureLevel: { retain: true } },
  });
  const menu = scripted.calls.find((call) => call.kind === "select");
  assert.ok(menu && menu.kind === "select");
  assert.ok(menu.options.some((option) => option.startsWith("off =")));
  assert.ok(menu.options.some((option) => option.startsWith("max =")));
  assert.match(menu.title, /reasoning 为 false 时未启用/);
});

test("cost draft edits all known tier values and preserves root and retained-tier unknown keys", async () => {
  const existing = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    futureRoot: { retain: true },
    tiers: [
      { inputTokensAbove: 100, input: 5, output: 6, cacheRead: 7, cacheWrite: 8, futureTier: { retain: true } },
      { inputTokensAbove: 1000, input: 9, output: 10, cacheRead: 11, cacheWrite: 12, other: true },
    ],
  };
  const scripted = createScriptedUi({
    selects: [
      "input = 1",
      "成本分层 (2)",
      "第 1 层: 高于 100",
      "编辑分层",
      "返回成本",
      "保存并返回",
    ],
    inputs: ["", "0.5", "200", " ", "15", "16", "17", "18"],
  });
  const result = await editCostDraft(scripted.ctx, "成本", existing);
  assert.equal(result.status, "save");
  if (result.status !== "save") return;
  assert.equal(result.value.input, 0.5);
  assert.deepEqual(result.value.futureRoot, { retain: true });
  assert.deepEqual((result.value.tiers as any[])[0], {
    inputTokensAbove: 200,
    input: 15,
    output: 16,
    cacheRead: 17,
    cacheWrite: 18,
    futureTier: { retain: true },
  });
  assert.deepEqual((result.value.tiers as any[])[1].other, true);
  assert.deepEqual(existing.tiers[0]?.futureTier, { retain: true });
  assert.equal(scripted.calls.filter((call) => call.kind === "notify").length, 2);
});

test("cost draft performs explicit numeric validation without losing the draft", async () => {
  const scripted = createScriptedUi({
    selects: ["input = 1", "保存并返回"],
    inputs: [" \t", "invalid", "-1", "2.5"],
  });
  const result = await editCostDraft(scripted.ctx, "成本", {
    input: 1, output: 2, cacheRead: 3, cacheWrite: 4,
  });
  assert.equal(result.status, "save");
  if (result.status === "save") assert.equal(result.value.input, 2.5);
  assert.equal(scripted.calls.filter((call) => call.kind === "notify").length, 3);
});

test("payload draft validates JSON, patches one key, and preserves untouched nested values", async () => {
  const existing = { known: "old", future: { deep: { retain: true } } };
  const scripted = createScriptedUi({
    selects: [
      "[string] known",
      "编辑值",
      "新增条目",
      "JSON",
      "保存并返回",
    ],
    inputs: ["new", "added"],
    editors: ["not-json", '{"nested":0}'],
  });
  const result = await editPayloadDraft(scripted.ctx, "Payload 参数", existing);
  assert.deepEqual(result, {
    status: "save",
    value: { known: "new", future: { deep: { retain: true } }, added: { nested: 0 } },
  });
  assert.deepEqual(existing, { known: "old", future: { deep: { retain: true } } });
  assert.ok(scripted.calls.some((call) => call.kind === "notify" && call.level === "error"));
});

test("payload draft accepts and preserves an exact empty string value", async () => {
  const scripted = createScriptedUi({
    selects: ["新增条目", "string", "新增条目", "string", "保存并返回"],
    inputs: ["empty", "", "spaced", "  value  "],
  });
  assert.deepEqual(await editPayloadDraft(scripted.ctx, "Payload 参数", undefined), {
    status: "save",
    value: { empty: "", spaced: "  value  " },
  });
  assert.equal(scripted.calls.filter((call) => call.kind === "notify").length, 0);
});

test("Escape from every nested editor is discard", async () => {
  for (const edit of [
    (ctx: any) => editStringMapDraft(ctx, "请求头", { a: "b" }),
    (ctx: any) => editCompatDraft(ctx, "兼容性", { future: true }),
    (ctx: any) => editThinkingMapDraft(ctx, "思考映射", { max: "max" }, true),
    (ctx: any) => editCostDraft(ctx, "成本", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    (ctx: any) => editPayloadDraft(ctx, "Payload 参数", { future: true }),
  ]) {
    const scripted = createScriptedUi({ selects: [undefined] });
    assert.deepEqual(await edit(scripted.ctx), { status: "discard" });
  }
});
