import { cloneOwnJsonData, deleteOwnKey, getOwnValue, setOwnValue } from "./own-keys.ts";

export type CompatBooleanChoice = "default" | "false" | "true";

/**
 * Boolean compat fields, grouped by the Pi 0.85.1 API family that reads them.
 * Pi ignores a field that belongs to another family, so the label names the family.
 */
export const COMPAT_BOOLEAN_FIELDS = [
  // OpenAI-compatible completions
  { key: "supportsStore", label: "supportsStore (OpenAI)" },
  { key: "supportsDeveloperRole", label: "supportsDeveloperRole (OpenAI+Responses)" },
  { key: "supportsReasoningEffort", label: "supportsReasoningEffort (OpenAI)" },
  { key: "supportsUsageInStreaming", label: "supportsUsageInStreaming (OpenAI)" },
  { key: "supportsFinishReason", label: "supportsFinishReason (OpenAI)" },
  { key: "requiresToolResultName", label: "requiresToolResultName (OpenAI)" },
  { key: "requiresAssistantAfterToolResult", label: "requiresAssistantAfterToolResult (OpenAI)" },
  { key: "requiresThinkingAsText", label: "requiresThinkingAsText (OpenAI)" },
  { key: "requiresReasoningContentOnAssistantMessages", label: "requiresReasoningContentOnAssistantMessages (OpenAI)" },
  { key: "supportsStrictMode", label: "supportsStrictMode (OpenAI+Responses)" },
  { key: "supportsOpenAIGrammarTools", label: "supportsOpenAIGrammarTools (OpenAI+Responses)" },
  { key: "supportsLongCacheRetention", label: "supportsLongCacheRetention (OpenAI+Responses+Anthropic)" },
  { key: "zaiToolStream", label: "zaiToolStream (OpenAI, z.ai)" },
  // OpenAI Responses
  { key: "supportsAdditionalTools", label: "supportsAdditionalTools (Responses)" },
  { key: "supportsToolSearch", label: "supportsToolSearch (Responses)" },
  { key: "supportsMaxOutputTokens", label: "supportsMaxOutputTokens (Responses)" },
  // Anthropic Messages
  { key: "supportsEagerToolInputStreaming", label: "supportsEagerToolInputStreaming (Anthropic)" },
  { key: "sendSessionAffinityHeaders", label: "sendSessionAffinityHeaders (OpenAI+Anthropic)" },
  { key: "supportsCacheControlOnTools", label: "supportsCacheControlOnTools (Anthropic)" },
  { key: "supportsTemperature", label: "supportsTemperature (Anthropic)" },
  { key: "forceAdaptiveThinking", label: "forceAdaptiveThinking (Anthropic)" },
  { key: "allowEmptySignature", label: "allowEmptySignature (Anthropic)" },
  { key: "supportsStrictTools", label: "supportsStrictTools (Anthropic)" },
  { key: "supportsMidConvoEffort", label: "supportsMidConvoEffort (Anthropic)" },
  { key: "supportsToolReferences", label: "supportsToolReferences (Anthropic)" },
] as const;

export const COMPAT_STRING_FIELDS = [
  { key: "maxTokensField", label: "maxTokensField (OpenAI)", values: ["max_completion_tokens", "max_tokens"] },
  { key: "cacheControlFormat", label: "cacheControlFormat (OpenAI)", values: ["anthropic"] },
  { key: "deferredToolsMode", label: "deferredToolsMode (OpenAI)", values: ["kimi"] },
  { key: "sessionAffinityFormat", label: "sessionAffinityFormat (OpenAI+Responses)", values: ["openai", "openai-nosession", "openrouter"] },
] as const;

/** Free-form JSON object compat fields. */
export const COMPAT_JSON_OBJECT_FIELDS = [
  { key: "chatTemplateKwargs", label: "chatTemplateKwargs" },
  { key: "chatTemplateArgs", label: "chatTemplateArgs" },
  { key: "openRouterRouting", label: "openRouterRouting" },
  { key: "vercelGatewayRouting", label: "vercelGatewayRouting" },
] as const;

export const COMPAT_NUMBER_FIELDS = [
  { key: "vllmPriority", label: "vllmPriority (OpenAI, vLLM 调度优先级)" },
] as const;

export const THINKING_FORMATS = [
  "openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen",
  "chat-template", "qwen-chat-template", "string-thinking", "ant-ling",
] as const;

/** `thinkingFormat` needs the enum list, so it lives beside it rather than in the value table. */
export const COMPAT_THINKING_FORMAT_FIELD = {
  key: "thinkingFormat",
  label: "thinkingFormat (OpenAI)",
  values: [...THINKING_FORMATS],
} as const;

export const SESSION_AFFINITY_FORMATS = ["openai", "openai-nosession", "openrouter"] as const;

export function applyCompatBooleanChoice(compat: Record<string, unknown>, key: string, choice: CompatBooleanChoice): Record<string, unknown> {
  const next = { ...compat };
  if (choice === "default") delete next[key];
  else next[key] = choice === "true";
  return next;
}

export function applyCompatObjectChoice(compat: Record<string, unknown>, key: string, value: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = { ...compat };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeObjectPatch(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = cloneOwnJsonData(existing, { objectPrototype: "ordinary" });
  for (const key of Object.keys(patch)) {
    const current = getOwnValue(next, key);
    const value = getOwnValue(patch, key);
    setOwnValue(next, key, isObject(current) && isObject(value)
      ? mergeObjectPatch(current, value)
      : cloneOwnJsonData(value, { objectPrototype: "ordinary" }));
  }
  return next;
}

/** Apply a JSON object as a patch while retaining unedited future nested fields. */
export function applyCompatObjectPatch(
  compat: Record<string, unknown>,
  key: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const current = getOwnValue(compat, key);
  return applyCompatObjectChoice(compat, key, mergeObjectPatch(isObject(current) ? current : {}, patch));
}

/**
 * Pi 0.80.7 removed `compat.sendSessionIdHeader` from models.json in favor of
 * `compat.sessionAffinityFormat`; stored `true` values only restate the default.
 */
export interface LegacySessionAffinityPlan {
  legacyValue: unknown;
  setSessionAffinityFormat?: (typeof SESSION_AFFINITY_FORMATS)[number];
  reason: string;
}

export const LEGACY_SESSION_AFFINITY_KEY = "sendSessionIdHeader";

export function planLegacySessionAffinityMigration(
  compat: Record<string, unknown>,
  api?: string,
): LegacySessionAffinityPlan | undefined {
  const legacyValue = getOwnValue(compat, LEGACY_SESSION_AFFINITY_KEY);
  if (legacyValue === undefined) return undefined;
  if (legacyValue !== false) {
    return {
      legacyValue,
      reason: `Pi 0.80.7 起 models.json 已移除 ${LEGACY_SESSION_AFFINITY_KEY}；当前值等同默认行为，可安全删除。`,
    };
  }
  if (api === "openai-completions" || api === "openai-responses") {
    return {
      legacyValue,
      setSessionAffinityFormat: "openai-nosession",
      reason: `${LEGACY_SESSION_AFFINITY_KEY}: false 原本用于省略 session_id 头部，等价于 sessionAffinityFormat = "openai-nosession"。`,
    };
  }
  return {
    legacyValue,
    reason: `该 Provider/Model 的 API（${api ?? "未设置"}）不读取 ${LEGACY_SESSION_AFFINITY_KEY}；直接删除旧字段。`,
  };
}

export function applyLegacySessionAffinityMigration(
  compat: Record<string, unknown>,
  plan: LegacySessionAffinityPlan,
): Record<string, unknown> {
  const next = { ...compat };
  deleteOwnKey(next, LEGACY_SESSION_AFFINITY_KEY);
  if (plan.setSessionAffinityFormat !== undefined) {
    setOwnValue(next, "sessionAffinityFormat", plan.setSessionAffinityFormat);
  }
  return next;
}
