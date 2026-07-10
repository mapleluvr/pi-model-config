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
