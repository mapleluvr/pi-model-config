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
  return absence === "inherited" ? "(inherited)" : "(not set)";
}

export function formatSettingValue(value: unknown, absence: SettingAbsence = "not-set"): string {
  if (value === undefined) return absentValue(absence);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return stringifyOwnJsonData(value);
}

export function formatNestedCount(
  value: unknown,
  noun = "entries",
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
  if (value === undefined) return "(not set)";
  if (value.startsWith("$") || value.startsWith("!")) return value;
  return maskApiKey(value);
}

export async function collectOptionalString(
  ctx: FieldEditorUiContext,
  title: string,
  placeholder?: string,
): Promise<ScalarCollectionResult<string>> {
  const action = await ctx.ui.select(title, ["Enter a value", "Clear value", "Cancel"]);
  if (action === undefined || action === "Cancel") return { status: "cancel" };
  if (action === "Clear value") return { status: "clear" };
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
    ctx.ui.notify("A non-empty value is required", "error");
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
    ctx.ui.notify("Enter a positive integer", "error");
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
    const value = Number(raw.trim());
    if (Number.isFinite(value) && value >= 0) return { status: "value", value };
    ctx.ui.notify("Enter a finite non-negative number", "error");
  }
}

export async function collectApiKeyAction(
  ctx: FieldEditorUiContext,
  _storedValue?: string,
): Promise<ApiKeyActionResult> {
  const action = await ctx.ui.select("API Key", ["Keep", "Replace", "Clear"]);
  if (action === undefined) return { status: "cancel" };
  if (action === "Keep") return { status: "keep" };
  if (action === "Clear") return { status: "clear" };
  ctx.ui.notify("The replacement will be visible while you type it", "warning");
  while (true) {
    const value = await ctx.ui.input("Replace API Key", "Enter new API key");
    if (value === undefined) return { status: "cancel" };
    const normalized = value.trim();
    if (normalized.length > 0) return { status: "replace", value: normalized };
    ctx.ui.notify("API Key cannot be blank; use Clear instead", "error");
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
      "Add entry",
      "Save and return",
      "Discard changes",
    ]);
    if (choice === undefined || choice === "Discard changes") return { status: "discard" };
    if (choice === "Save and return") return { status: "save", value: draft };
    if (choice === "Add entry") {
      const keyResult = await collectRequiredString(ctx, `${title} - New key`, "Header name");
      if (keyResult.status === "cancel") return { status: "discard" };
      if (hasOwnKey(draft, keyResult.value)) {
        ctx.ui.notify("That key already exists", "error");
        continue;
      }
      const valueResult = await collectRequiredString(ctx, `${title} - New value`, "Header value");
      if (valueResult.status === "cancel") return { status: "discard" };
      setOwnValue(draft, keyResult.value, valueResult.value);
      continue;
    }
    const key = keys.find((candidate) => `${candidate} = string` === choice);
    if (!key) continue;
    const action = await ctx.ui.select(`${title} - ${key}`, ["Edit value", "Delete entry", "Back"]);
    if (action === undefined) return { status: "discard" };
    if (action === "Back") continue;
    if (action === "Delete entry") {
      deleteOwnKey(draft, key);
      continue;
    }
    const valueResult = await collectRequiredString(ctx, `${title} - ${key}`, "New value");
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
  const state = value === true ? "true" : value === false ? "false" : "default";
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
    const objectLabels = COMPAT_JSON_OBJECT_FIELDS.map((field) => `[object] ${field.label}`);
    const choice = await ctx.ui.select(title, [
      ...booleanLabels,
      ...stringLabels,
      ...objectLabels,
      "Save and return",
      "Discard changes",
    ]);
    if (choice === undefined || choice === "Discard changes") return { status: "discard" };
    if (choice === "Save and return") return { status: "save", value: draft };

    const booleanIndex = booleanLabels.indexOf(choice);
    if (booleanIndex >= 0) {
      const field = COMPAT_BOOLEAN_FIELDS[booleanIndex]!;
      const selected = await ctx.ui.select(`${title} - ${field.label}`, ["Use default", "false", "true", "Back"]);
      if (selected === undefined) return { status: "discard" };
      if (selected === "Back") continue;
      const compatChoice = selected === "true" ? "true" : selected === "false" ? "false" : "default";
      draft = applyCompatBooleanChoice(draft, field.key, compatChoice);
      continue;
    }

    const stringIndex = stringLabels.indexOf(choice);
    if (stringIndex >= 0) {
      const field = COMPAT_STRING_FIELDS[stringIndex]!;
      const selected = await ctx.ui.select(`${title} - ${field.key}`, [...field.values, "Clear", "Back"]);
      if (selected === undefined) return { status: "discard" };
      if (selected === "Back") continue;
      if (selected === "Clear") deleteOwnKey(draft, field.key);
      else setOwnValue(draft, field.key, selected);
      continue;
    }

    const objectIndex = objectLabels.indexOf(choice);
    if (objectIndex < 0) continue;
    const field = COMPAT_JSON_OBJECT_FIELDS[objectIndex]!;
    const action = await ctx.ui.select(`${title} - ${field.label}`, ["Edit JSON object", "Clear", "Back"]);
    if (action === undefined) return { status: "discard" };
    if (action === "Back") continue;
    if (action === "Clear") {
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
      ctx.ui.notify("Enter a valid JSON object", "error");
    }
  }
}

function thinkingValueLabel(value: unknown): string {
  if (value === undefined) return "(not set)";
  if (value === null) return "null";
  return typeof value === "string" ? value : "(preserved value)";
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
    const choice = await ctx.ui.select(menuTitle, [...labels, "Save and return", "Discard changes"]);
    if (choice === undefined || choice === "Discard changes") return { status: "discard" };
    if (choice === "Save and return") return { status: "save", value: draft };
    const index = labels.indexOf(choice);
    if (index < 0) continue;
    const level = THINKING_LEVELS[index]!;
    const action = await ctx.ui.select(`${title} - ${level}`, [
      "Set mapped value", "Set null", "Clear mapping", "Back",
    ]);
    if (action === undefined) return { status: "discard" };
    if (action === "Back") continue;
    if (action === "Set null") {
      setOwnValue(draft, level, null);
      continue;
    }
    if (action === "Clear mapping") {
      deleteOwnKey(draft, level);
      continue;
    }
    const result = await collectRequiredString(ctx, `${title} - ${level}`, "Provider value");
    if (result.status === "cancel") return { status: "discard" };
    setOwnValue(draft, level, result.value);
  }
}

const COST_RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const TIER_RATE_LABELS = [
  ["input", "Input rate"],
  ["output", "Output rate"],
  ["cacheRead", "Cache read rate"],
  ["cacheWrite", "Cache write rate"],
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
    `${title} - Input tokens above`,
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
    const labels = tiers.map((tier, index) => `Tier ${index + 1}: above ${formatSettingValue(getOwnValue(tier, "inputTokensAbove"))}`);
    const choice = await ctx.ui.select(`${title} - Cost tiers`, [
      ...labels,
      "Add tier",
      "Back to cost",
    ]);
    if (choice === undefined) return { status: "discard" };
    if (choice === "Back to cost") return { status: "back", tiers };
    if (choice === "Add tier") {
      const result = await collectTier(ctx, `${title} - New tier`);
      if (result.status === "discard") return result;
      tiers.push(result.value);
      continue;
    }
    const index = labels.indexOf(choice);
    if (index < 0) continue;
    const action = await ctx.ui.select(`${title} - Tier ${index + 1}`, [
      "Edit tier", "Move up", "Move down", "Delete tier", "Back",
    ]);
    if (action === undefined) return { status: "discard" };
    if (action === "Back") continue;
    if (action === "Delete tier") {
      tiers.splice(index, 1);
      continue;
    }
    if (action === "Move up") {
      if (index > 0) [tiers[index - 1], tiers[index]] = [tiers[index]!, tiers[index - 1]!];
      continue;
    }
    if (action === "Move down") {
      if (index < tiers.length - 1) [tiers[index], tiers[index + 1]] = [tiers[index + 1]!, tiers[index]!];
      continue;
    }
    const result = await collectTier(ctx, `${title} - Tier ${index + 1}`, tiers[index]);
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
      `Cost tiers (${tierCount})`,
      "Save and return",
      "Discard changes",
    ]);
    if (choice === undefined || choice === "Discard changes") return { status: "discard" };
    if (choice === "Save and return") return { status: "save", value: draft };
    const rateIndex = rateLabels.indexOf(choice);
    if (rateIndex >= 0) {
      const key = COST_RATE_KEYS[rateIndex]!;
      const result = await collectNonNegativeRate(ctx, `${title} - ${key}`, String(getOwnValue(draft, key) ?? ""));
      if (result.status === "cancel") return { status: "discard" };
      setOwnValue(draft, key, result.value);
      continue;
    }
    if (choice !== `Cost tiers (${tierCount})`) continue;
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
      ctx.ui.notify("Enter valid JSON", "error");
    }
  }
}

async function collectPayloadValue(
  ctx: FieldEditorUiContext,
  title: string,
  type: "string" | "Boolean" | "JSON",
  current?: unknown,
): Promise<RequiredCollectionResult<unknown>> {
  if (type === "string") return await collectRequiredString(ctx, title, "String value");
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
      "Add entry",
      "Save and return",
      "Discard changes",
    ]);
    if (choice === undefined || choice === "Discard changes") return { status: "discard" };
    if (choice === "Save and return") return { status: "save", value: draft };
    if (choice === "Add entry") {
      const keyResult = await collectRequiredString(ctx, `${title} - New key`, "Payload key");
      if (keyResult.status === "cancel") return { status: "discard" };
      if (hasOwnKey(draft, keyResult.value)) {
        ctx.ui.notify("That key already exists", "error");
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
    const action = await ctx.ui.select(`${title} - ${key}`, ["Edit value", "Delete entry", "Back"]);
    if (action === undefined) return { status: "discard" };
    if (action === "Back") continue;
    if (action === "Delete entry") {
      deleteOwnKey(draft, key);
      continue;
    }
    const value = await collectPayloadValue(ctx, `${title} - ${key}`, entryType(current), current);
    if (value.status === "cancel") return { status: "discard" };
    setOwnValue(draft, key, value.value);
  }
}
