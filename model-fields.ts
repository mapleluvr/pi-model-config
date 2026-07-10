import type { ModelConfig, ModelCostTier, ProviderConfig } from "./types.ts";

type ConfigPatch<T extends Record<string, unknown>> = {
  [Key in keyof T]?: T[Key] | null;
} & Record<string, unknown>;

function mergeDefined<T extends Record<string, unknown>>(existing: T | undefined, changes: ConfigPatch<T>): T {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

export function mergeProviderConfig(existing: ProviderConfig | undefined, changes: ConfigPatch<ProviderConfig>): ProviderConfig {
  return mergeDefined(existing, changes);
}

export function mergeModelConfig(existing: ModelConfig | undefined, changes: ConfigPatch<ModelConfig>): ModelConfig {
  return mergeDefined(existing, changes);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateCostTier(candidate: unknown): ModelCostTier | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const value = candidate as Record<string, unknown>;
  if (typeof value.inputTokensAbove !== "number" || !Number.isInteger(value.inputTokensAbove) || value.inputTokensAbove <= 0) return undefined;
  if (!finiteNonNegative(value.input) || !finiteNonNegative(value.output) || !finiteNonNegative(value.cacheRead) || !finiteNonNegative(value.cacheWrite)) return undefined;
  return {
    inputTokensAbove: value.inputTokensAbove,
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
  };
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
