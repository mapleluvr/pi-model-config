import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  COMPAT_BOOLEAN_FIELDS,
  COMPAT_JSON_OBJECT_FIELDS,
  THINKING_FORMATS,
  applyCompatBooleanChoice,
  applyCompatObjectChoice,
  applyCompatObjectPatch,
} from "./compat-settings.ts";
import { deepCloneJson, getThinkingMapWarning } from "./model-fields.ts";
import {
  deleteOwnKey,
  getOwnValue,
  hasOwnKey,
  setOwnValue,
  stringifyOwnJsonData,
} from "./own-keys.ts";
import { THINKING_LEVELS } from "./types.ts";

export type ScalarCollectionResult<T> =
  | { status: "cancel" }
  | { status: "clear" }
  | { status: "value"; value: T };

export type RequiredCollectionResult<T> =
  | { status: "cancel" }
  | { status: "value"; value: T };

export type ApiKeyActionResult =
  | { status: "cancel" }
  | { status: "keep" }
  | { status: "clear" }
  | { status: "replace"; value: string };

export type DraftEditorResult<T> =
  | { status: "save"; value: T }
  | { status: "discard" };

export interface FieldEditorUiContext {
  ui: Pick<ExtensionCommandContext["ui"], "select" | "input" | "editor" | "notify">;
}

export type SettingAbsence = "not-set" | "inherited";

function absentValue(absence: SettingAbsence): string {
  return absence === "inherited" ? "(继承)" : "(未设置)";
}

export function formatSettingValue(value: unknown, absence: SettingAbsence = "not-set"): string {
  if (value === undefined) return absentValue(absence);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return stringifyOwnJsonData(value);
}

export function formatNestedCount(
  value: unknown,
  noun = "项",
  absence: SettingAbsence = "not-set",
): string {
  if (value === undefined) return absentValue(absence);
  if (Array.isArray(value)) return `${value.length} ${noun}`;
  if (isPlainObject(value)) return `${Object.keys(value).length} ${noun}`;
  return `0 ${noun}`;
}

export function maskApiKey(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${"*".repeat(12)}${value.slice(-4)}`;
}

export function formatApiKeyReference(value: string | undefined): string {
  if (value === undefined) return "(未设置)";
  if (value.startsWith("$") || value.startsWith("!")) return value;
  return maskApiKey(value);
}

export async function collectOptionalString(
  ctx: FieldEditorUiContext,
  title: string,
  placeholder?: string,
): Promise<ScalarCollectionResult<string>> {
  const action = await ctx.ui.select(title, ["输入值", "清除值", "取消"]);
  if (action === undefined || action === "取消") return { status: "cancel" };
  if (action === "清除值") return { status: "clear" };
  return await collectRequiredString(ctx, title, placeholder);
}

export async function collectRequiredString(
  ctx: FieldEditorUiContext,
  title: string,
  placeholder?: string,
): Promise<RequiredCollectionResult<string>> {
  while (true) {
    const raw = await ctx.ui.input(title, placeholder);
    if (raw === undefined) return { status: "cancel" };
    const value = raw.trim();
    if (value.length > 0) return { status: "value", value };
    ctx.ui.notify("请输入非空值", "error");
  }
}

export async function collectPositiveInteger(
  ctx: FieldEditorUiContext,
  title: string,
  placeholder?: string,
): Promise<RequiredCollectionResult<number>> {
  while (true) {
    const raw = await ctx.ui.input(title, placeholder);
    if (raw === undefined) return { status: "cancel" };
    const value = Number(raw.trim());
    if (Number.isInteger(value) && value > 0) return { status: "value", value };
    ctx.ui.notify("请输入正整数", "error");
  }
}

export async function collectNonNegativeRate(
  ctx: FieldEditorUiContext,
  title: string,
  placeholder?: string,
): Promise<RequiredCollectionResult<number>> {
  while (true) {
    const raw = await ctx.ui.input(title, placeholder);
    if (raw === undefined) return { status: "cancel" };
    const normalized = raw.trim();
    if (normalized.length > 0) {
      const value = Number(normalized);
      if (Number.isFinite(value) && value >= 0) return { status: "value", value };
    }
    ctx.ui.notify("请输入有限的非负数", "error");
  }
}

export async function collectApiKeyAction(
  ctx: FieldEditorUiContext,
  _storedValue?: string,
): Promise<ApiKeyActionResult> {
  const action = await ctx.ui.select("API Key", ["保留", "替换", "清除"]);
  if (action === undefined) return { status: "cancel" };
  if (action === "保留") return { status: "keep" };
  if (action === "清除") return { status: "clear" };
  ctx.ui.notify("输入替换值时内容将可见", "warning");
  while (true) {
    const value = await ctx.ui.input("替换 API Key", "输入新的 API Key");
    if (value === undefined) return { status: "cancel" };
    const normalized = value.trim();
    if (normalized.length > 0) return { status: "replace", value: normalized };
    ctx.ui.notify("API Key 不能为空；如需移除请使用“清除”", "error");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return deepCloneJson(value ?? {});
}

function entryType(value: unknown): "string" | "Boolean" | "JSON" {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "Boolean";
  return "JSON";
}

function storedType(value: unknown): string {
  return entryType(value).toLowerCase();
}

export async function editStringMapDraft(
  ctx: FieldEditorUiContext,
  title: string,
  existing: Record<string, string> | undefined,
): Promise<DraftEditorResult<Record<string, string>>> {
  const draft = cloneRecord(existing as Record<string, unknown> | undefined) as Record<string, string>;
  while (true) {
    const keys = Object.keys(draft);
    const choice = await ctx.ui.select(title, [
      ...keys.map((key) => `${key} = string`),
      "新增条目",
      "保存并返回",
      "放弃更改",
    ]);
    if (choice === undefined || choice === "放弃更改") return { status: "discard" };
    if (choice === "保存并返回") return { status: "save", value: draft };
    if (choice === "新增条目") {
      const keyResult = await collectRequiredString(ctx, `${title} - 新键`, "请求头名称");
      if (keyResult.status === "cancel") return { status: "discard" };
      if (hasOwnKey(draft, keyResult.value)) {
        ctx.ui.notify("该键已存在", "error");
        continue;
      }
      const valueResult = await collectRequiredString(ctx, `${title} - 新值`, "请求头值");
      if (valueResult.status === "cancel") return { status: "discard" };
      setOwnValue(draft, keyResult.value, valueResult.value);
      continue;
    }
    const key = keys.find((candidate) => `${candidate} = string` === choice);
    if (!key) continue;
    const action = await ctx.ui.select(`${title} - ${key}`, ["编辑值", "删除条目", "返回"]);
    if (action === undefined) return { status: "discard" };
    if (action === "返回") continue;
    if (action === "删除条目") {
      deleteOwnKey(draft, key);
      continue;
    }
    const valueResult = await collectRequiredString(ctx, `${title} - ${key}`, "新值");
    if (valueResult.status === "cancel") return { status: "discard" };
    setOwnValue(draft, key, valueResult.value);
  }
}

const COMPAT_STRING_FIELDS = [
  { key: "maxTokensField", values: ["max_completion_tokens", "max_tokens"] },
  { key: "thinkingFormat", values: [...THINKING_FORMATS] },
  { key: "cacheControlFormat", values: ["anthropic"] },
] as const;

function compatBooleanLabel(draft: Record<string, unknown>, key: string, label: string): string {
  const value = getOwnValue(draft, key);
  const state = value === true ? "true" : value === false ? "false" : "默认";
  return `[${state}] ${label}`;
}

export async function editCompatDraft(
  ctx: FieldEditorUiContext,
  title: string,
  existing: Record<string, unknown> | undefined,
): Promise<DraftEditorResult<Record<string, unknown>>> {
  let draft = cloneRecord(existing);
  while (true) {
    const booleanLabels = COMPAT_BOOLEAN_FIELDS.map((field) => compatBooleanLabel(draft, field.key, field.label));
    const stringLabels = COMPAT_STRING_FIELDS.map((field) => `${field.key} = ${formatSettingValue(getOwnValue(draft, field.key))}`);
    const objectLabels = COMPAT_JSON_OBJECT_FIELDS.map((field) => `[对象] ${field.label}`);
    const choice = await ctx.ui.select(title, [
      ...booleanLabels,
      ...stringLabels,
      ...objectLabels,
      "保存并返回",
      "放弃更改",
    ]);
    if (choice === undefined || choice === "放弃更改") return { status: "discard" };
    if (choice === "保存并返回") return { status: "save", value: draft };

    const booleanIndex = booleanLabels.indexOf(choice);
    if (booleanIndex >= 0) {
      const field = COMPAT_BOOLEAN_FIELDS[booleanIndex]!;
      const selected = await ctx.ui.select(`${title} - ${field.label}`, ["使用默认值", "false", "true", "返回"]);
      if (selected === undefined) return { status: "discard" };
      if (selected === "返回") continue;
      const compatChoice = selected === "true" ? "true" : selected === "false" ? "false" : "default";
      draft = applyCompatBooleanChoice(draft, field.key, compatChoice);
      continue;
    }

    const stringIndex = stringLabels.indexOf(choice);
    if (stringIndex >= 0) {
      const field = COMPAT_STRING_FIELDS[stringIndex]!;
      const selected = await ctx.ui.select(`${title} - ${field.key}`, [...field.values, "清除", "返回"]);
      if (selected === undefined) return { status: "discard" };
      if (selected === "返回") continue;
      if (selected === "清除") deleteOwnKey(draft, field.key);
      else setOwnValue(draft, field.key, selected);
      continue;
    }

    const objectIndex = objectLabels.indexOf(choice);
    if (objectIndex < 0) continue;
    const field = COMPAT_JSON_OBJECT_FIELDS[objectIndex]!;
    const action = await ctx.ui.select(`${title} - ${field.label}`, ["编辑 JSON 对象", "清除", "返回"]);
    if (action === undefined) return { status: "discard" };
    if (action === "返回") continue;
    if (action === "清除") {
      draft = applyCompatObjectChoice(draft, field.key, undefined);
      continue;
    }
    const raw = await ctx.ui.editor(
      `${title} - ${field.label}`,
      getOwnValue(draft, field.key) === undefined ? "{}" : stringifyOwnJsonData(getOwnValue(draft, field.key), 2),
    );
    if (raw === undefined) return { status: "discard" };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error();
      draft = applyCompatObjectPatch(draft, field.key, parsed);
    } catch {
      ctx.ui.notify("请输入有效的 JSON 对象", "error");
    }
  }
}

function thinkingValueLabel(value: unknown): string {
  if (value === undefined) return "(未设置)";
  if (value === null) return "null";
  return typeof value === "string" ? value : "(保留值)";
}

export async function editThinkingMapDraft(
  ctx: FieldEditorUiContext,
  title: string,
  existing: Record<string, unknown> | undefined,
  reasoning: boolean | undefined,
): Promise<DraftEditorResult<Record<string, unknown>>> {
  const draft = cloneRecord(existing);
  const warning = getThinkingMapWarning(reasoning);
  const menuTitle = warning ? `${title} - ${warning}` : title;
  while (true) {
    const labels = THINKING_LEVELS.map((level) => `${level} = ${thinkingValueLabel(getOwnValue(draft, level))}`);
    const choice = await ctx.ui.select(menuTitle, [...labels, "保存并返回", "放弃更改"]);
    if (choice === undefined || choice === "放弃更改") return { status: "discard" };
    if (choice === "保存并返回") return { status: "save", value: draft };
    const index = labels.indexOf(choice);
    if (index < 0) continue;
    const level = THINKING_LEVELS[index]!;
    const action = await ctx.ui.select(`${title} - ${level}`, [
      "设置映射值", "设为 null", "清除映射", "返回",
    ]);
    if (action === undefined) return { status: "discard" };
    if (action === "返回") continue;
    if (action === "设为 null") {
      setOwnValue(draft, level, null);
      continue;
    }
    if (action === "清除映射") {
      deleteOwnKey(draft, level);
      continue;
    }
    const result = await collectRequiredString(ctx, `${title} - ${level}`, "提供商值");
    if (result.status === "cancel") return { status: "discard" };
    setOwnValue(draft, level, result.value);
  }
}

const COST_RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const TIER_RATE_LABELS = [
  ["input", "输入费率"],
  ["output", "输出费率"],
  ["cacheRead", "缓存读取费率"],
  ["cacheWrite", "缓存写入费率"],
] as const;

type TierEditorResult =
  | { status: "back"; tiers: Record<string, unknown>[] }
  | { status: "discard" };

async function collectTier(
  ctx: FieldEditorUiContext,
  title: string,
  current?: Record<string, unknown>,
): Promise<DraftEditorResult<Record<string, unknown>>> {
  const draft = cloneRecord(current);
  const threshold = await collectPositiveInteger(
    ctx,
    `${title} - 输入令牌数大于`,
    current ? String(getOwnValue(current, "inputTokensAbove") ?? "") : undefined,
  );
  if (threshold.status === "cancel") return { status: "discard" };
  setOwnValue(draft, "inputTokensAbove", threshold.value);
  for (const [key, label] of TIER_RATE_LABELS) {
    const rate = await collectNonNegativeRate(
      ctx,
      `${title} - ${label}`,
      current ? String(getOwnValue(current, key) ?? "") : undefined,
    );
    if (rate.status === "cancel") return { status: "discard" };
    setOwnValue(draft, key, rate.value);
  }
  return { status: "save", value: draft };
}

async function editCostTiersDraft(
  ctx: FieldEditorUiContext,
  title: string,
  current: Record<string, unknown>[],
): Promise<TierEditorResult> {
  const tiers = deepCloneJson(current);
  while (true) {
    const labels = tiers.map((tier, index) => `第 ${index + 1} 层: 高于 ${formatSettingValue(getOwnValue(tier, "inputTokensAbove"))}`);
    const choice = await ctx.ui.select(`${title} - 成本分层`, [
      ...labels,
      "新增分层",
      "返回成本",
    ]);
    if (choice === undefined) return { status: "discard" };
    if (choice === "返回成本") return { status: "back", tiers };
    if (choice === "新增分层") {
      const result = await collectTier(ctx, `${title} - 新分层`);
      if (result.status === "discard") return result;
      tiers.push(result.value);
      continue;
    }
    const index = labels.indexOf(choice);
    if (index < 0) continue;
    const action = await ctx.ui.select(`${title} - 第 ${index + 1} 层`, [
      "编辑分层", "上移", "下移", "删除分层", "返回",
    ]);
    if (action === undefined) return { status: "discard" };
    if (action === "返回") continue;
    if (action === "删除分层") {
      tiers.splice(index, 1);
      continue;
    }
    if (action === "上移") {
      if (index > 0) [tiers[index - 1], tiers[index]] = [tiers[index]!, tiers[index - 1]!];
      continue;
    }
    if (action === "下移") {
      if (index < tiers.length - 1) [tiers[index], tiers[index + 1]] = [tiers[index + 1]!, tiers[index]!];
      continue;
    }
    const result = await collectTier(ctx, `${title} - 第 ${index + 1} 层`, tiers[index]);
    if (result.status === "discard") return result;
    tiers[index] = result.value;
  }
}

export async function editCostDraft(
  ctx: FieldEditorUiContext,
  title: string,
  existing: Record<string, unknown> | undefined,
): Promise<DraftEditorResult<Record<string, unknown>>> {
  const draft = cloneRecord(existing);
  while (true) {
    const rateLabels = COST_RATE_KEYS.map((key) => `${key} = ${formatSettingValue(getOwnValue(draft, key))}`);
    const tiers = getOwnValue(draft, "tiers");
    const tierCount = Array.isArray(tiers) ? tiers.length : 0;
    const choice = await ctx.ui.select(title, [
      ...rateLabels,
      `成本分层 (${tierCount})`,
      "保存并返回",
      "放弃更改",
    ]);
    if (choice === undefined || choice === "放弃更改") return { status: "discard" };
    if (choice === "保存并返回") return { status: "save", value: draft };
    const rateIndex = rateLabels.indexOf(choice);
    if (rateIndex >= 0) {
      const key = COST_RATE_KEYS[rateIndex]!;
      const result = await collectNonNegativeRate(ctx, `${title} - ${key}`, String(getOwnValue(draft, key) ?? ""));
      if (result.status === "cancel") return { status: "discard" };
      setOwnValue(draft, key, result.value);
      continue;
    }
    if (choice !== `成本分层 (${tierCount})`) continue;
    const currentTiers = Array.isArray(tiers)
      ? tiers.filter(isPlainObject).map((tier) => deepCloneJson(tier))
      : [];
    const result = await editCostTiersDraft(ctx, title, currentTiers);
    if (result.status === "discard") return result;
    if (result.tiers.length === 0) deleteOwnKey(draft, "tiers");
    else setOwnValue(draft, "tiers", result.tiers);
  }
}

async function collectJsonValue(
  ctx: FieldEditorUiContext,
  title: string,
  initialValue?: unknown,
): Promise<RequiredCollectionResult<unknown>> {
  while (true) {
    const raw = await ctx.ui.editor(
      title,
      initialValue === undefined ? "" : stringifyOwnJsonData(initialValue, 2),
    );
    if (raw === undefined) return { status: "cancel" };
    try {
      const parsed: unknown = JSON.parse(raw);
      return { status: "value", value: deepCloneJson(parsed) };
    } catch {
      ctx.ui.notify("请输入有效的 JSON", "error");
    }
  }
}

async function collectPayloadValue(
  ctx: FieldEditorUiContext,
  title: string,
  type: "string" | "Boolean" | "JSON",
  current?: unknown,
): Promise<RequiredCollectionResult<unknown>> {
  if (type === "string") {
    const value = await ctx.ui.input(title, "字符串值");
    return value === undefined ? { status: "cancel" } : { status: "value", value };
  }
  if (type === "Boolean") {
    const selected = await ctx.ui.select(title, ["true", "false"]);
    if (selected === undefined) return { status: "cancel" };
    return { status: "value", value: selected === "true" };
  }
  return await collectJsonValue(ctx, title, current);
}

export async function editPayloadDraft(
  ctx: FieldEditorUiContext,
  title: string,
  existing: Record<string, unknown> | undefined,
): Promise<DraftEditorResult<Record<string, unknown>>> {
  const draft = cloneRecord(existing);
  while (true) {
    const keys = Object.keys(draft);
    const labels = keys.map((key) => `[${storedType(getOwnValue(draft, key))}] ${key}`);
    const choice = await ctx.ui.select(title, [
      ...labels,
      "新增条目",
      "保存并返回",
      "放弃更改",
    ]);
    if (choice === undefined || choice === "放弃更改") return { status: "discard" };
    if (choice === "保存并返回") return { status: "save", value: draft };
    if (choice === "新增条目") {
      const keyResult = await collectRequiredString(ctx, `${title} - 新键`, "Payload 键");
      if (keyResult.status === "cancel") return { status: "discard" };
      if (hasOwnKey(draft, keyResult.value)) {
        ctx.ui.notify("该键已存在", "error");
        continue;
      }
      const type = await ctx.ui.select(`${title} - ${keyResult.value}`, ["string", "Boolean", "JSON"]);
      if (type === undefined) return { status: "discard" };
      const value = await collectPayloadValue(ctx, `${title} - ${keyResult.value}`, type as "string" | "Boolean" | "JSON");
      if (value.status === "cancel") return { status: "discard" };
      setOwnValue(draft, keyResult.value, value.value);
      continue;
    }
    const index = labels.indexOf(choice);
    if (index < 0) continue;
    const key = keys[index]!;
    const current = getOwnValue(draft, key);
    const action = await ctx.ui.select(`${title} - ${key}`, ["编辑值", "删除条目", "返回"]);
    if (action === undefined) return { status: "discard" };
    if (action === "返回") continue;
    if (action === "删除条目") {
      deleteOwnKey(draft, key);
      continue;
    }
    const value = await collectPayloadValue(ctx, `${title} - ${key}`, entryType(current), current);
    if (value.status === "cancel") return { status: "discard" };
    setOwnValue(draft, key, value.value);
  }
}
