import { cloneOwnJsonData, getOwnValue, setOwnValue } from "./own-keys.ts";

export type CompatBooleanChoice = "default" | "false" | "true";

export const COMPAT_BOOLEAN_FIELDS = [
  { key: "supportsStore", label: "supportsStore" },
  { key: "supportsDeveloperRole", label: "supportsDeveloperRole" },
  { key: "supportsReasoningEffort", label: "supportsReasoningEffort" },
  { key: "supportsUsageInStreaming", label: "supportsUsageInStreaming" },
  { key: "requiresToolResultName", label: "requiresToolResultName" },
  { key: "requiresAssistantAfterToolResult", label: "requiresAssistantAfterToolResult" },
  { key: "requiresThinkingAsText", label: "requiresThinkingAsText" },
  { key: "requiresReasoningContentOnAssistantMessages", label: "requiresReasoningContentOnAssistantMessages" },
  { key: "supportsStrictMode", label: "supportsStrictMode" },
  { key: "supportsLongCacheRetention", label: "supportsLongCacheRetention" },
  { key: "supportsTemperature", label: "supportsTemperature" },
  { key: "zaiToolStream", label: "zaiToolStream" },
  { key: "sendSessionIdHeader", label: "sendSessionIdHeader" },
  { key: "supportsEagerToolInputStreaming", label: "supportsEagerToolInputStreaming (Anthropic)" },
  { key: "sendSessionAffinityHeaders", label: "sendSessionAffinityHeaders (Anthropic)" },
  { key: "supportsCacheControlOnTools", label: "supportsCacheControlOnTools (Anthropic)" },
  { key: "forceAdaptiveThinking", label: "forceAdaptiveThinking (Anthropic)" },
  { key: "allowEmptySignature", label: "allowEmptySignature (Anthropic)" },
] as const;

export const COMPAT_JSON_OBJECT_FIELDS = [
  { key: "chatTemplateKwargs", label: "chatTemplateKwargs" },
  { key: "openRouterRouting", label: "openRouterRouting" },
  { key: "vercelGatewayRouting", label: "vercelGatewayRouting" },
] as const;

export const THINKING_FORMATS = [
  "openai", "openrouter", "deepseek", "together", "zai", "qwen",
  "chat-template", "qwen-chat-template", "string-thinking", "ant-ling",
] as const;

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
