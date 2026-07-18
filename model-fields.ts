import { cloneOwnJsonData, getOwnValue, setOwnValue } from "./own-keys.ts";
import type { ModelConfig, ModelCostTier, ProviderConfig } from "./types.ts";

export type ConfigPatch<T extends Record<string, unknown>> = {
  [Key in keyof T]?: T[Key] | null;
} & Record<string, unknown>;

export type ProviderSubtreeKey = "headers" | "compat" | "modelOverrides";
export type ModelSubtreeKey = "headers" | "compat" | "thinkingLevelMap" | "cost";

export const THINKING_MAP_INACTIVE_WARNING = "Thinking Level Map is inactive while reasoning is false";

export function getThinkingMapWarning(reasoning: boolean | undefined): string | undefined {
  return reasoning === false ? THINKING_MAP_INACTIVE_WARNING : undefined;
}

function mergeDefined<T extends Record<string, unknown>>(existing: T | undefined, changes: ConfigPatch<T>): T {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

export function deepCloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return cloneOwnJsonData(value, { objectPrototype: "ordinary" });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Order-insensitive for plain objects; array order is significant. */
export function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => deepEqualJson(entry, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    const rightSet = new Set(rightKeys);
    for (const key of leftKeys) {
      if (!rightSet.has(key)) return false;
      if (!deepEqualJson(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Exact stored presence for subtree baselines.
 * absent, explicit null, and explicit `{}` are distinct — never normalize them together.
 */
export type SubtreePresence =
  | { presence: "absent" }
  | { presence: "null" }
  | { presence: "value"; value: unknown };

export function describeSubtreePresence(value: unknown): SubtreePresence {
  if (value === undefined) return { presence: "absent" };
  if (value === null) return { presence: "null" };
  return { presence: "value", value: deepCloneJson(value) };
}

export function subtreePresenceEqual(left: SubtreePresence, right: SubtreePresence): boolean {
  if (left.presence !== right.presence) return false;
  if (left.presence === "value" && right.presence === "value") {
    return deepEqualJson(left.value, right.value);
  }
  return true;
}

/** @deprecated Prefer describeSubtreePresence for exact absent/null/value baselines. */
export function normalizeSubtreeBaseline(value: unknown): unknown {
  return value === undefined ? null : value;
}

export function mergeProviderConfig(existing: ProviderConfig | undefined, changes: ConfigPatch<ProviderConfig>): ProviderConfig {
  return mergeDefined(existing, changes);
}

export function mergeModelConfig(existing: ModelConfig | undefined, changes: ConfigPatch<ModelConfig>): ModelConfig {
  return mergeDefined(existing, changes);
}

export function readProviderSubtree(provider: ProviderConfig, key: ProviderSubtreeKey): unknown {
  return deepCloneJson(getOwnValue(provider as Record<string, unknown>, key));
}

export function writeProviderSubtree(provider: ProviderConfig, key: ProviderSubtreeKey, value: unknown): ProviderConfig {
  const next = deepCloneJson(provider);
  if (value === undefined || value === null) delete (next as Record<string, unknown>)[key];
  else setOwnValue(next as Record<string, unknown>, key, deepCloneJson(value));
  return next;
}

export function readModelSubtree(model: ModelConfig, key: ModelSubtreeKey): unknown {
  return deepCloneJson(getOwnValue(model as Record<string, unknown>, key));
}

export function writeModelSubtree(model: ModelConfig, key: ModelSubtreeKey, value: unknown): ModelConfig {
  const next = deepCloneJson(model);
  if (value === undefined || value === null) delete (next as Record<string, unknown>)[key];
  else setOwnValue(next as Record<string, unknown>, key, deepCloneJson(value));
  return next;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateCostTier(candidate: unknown): ModelCostTier | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const value = candidate as Record<string, unknown>;
  if (typeof value.inputTokensAbove !== "number" || !Number.isInteger(value.inputTokensAbove) || value.inputTokensAbove <= 0) return undefined;
  if (!finiteNonNegative(value.input) || !finiteNonNegative(value.output) || !finiteNonNegative(value.cacheRead) || !finiteNonNegative(value.cacheWrite)) return undefined;
  return deepCloneJson(value) as unknown as ModelCostTier;
}

export function replaceCostTiers(
  cost: NonNullable<ModelConfig["cost"]>,
  tiers: ModelCostTier[],
): NonNullable<ModelConfig["cost"]> {
  const next = { ...cost };
  if (tiers.length === 0) delete next.tiers;
  else next.tiers = tiers.map((tier) => ({ ...tier }));
  return next;
}
