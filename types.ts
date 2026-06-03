// ── models.json 类型定义 ──

export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}

export interface ProviderConfig {
  /** Display name for the provider in UI */
  name?: string;
  /** API endpoint URL */
  baseUrl?: string;
  /** API type: openai-completions | anthropic-messages | google-generative-ai etc. */
  api?: string;
  /** API key (literal, env var with $, or command with !) */
  apiKey?: string;
  /** Custom headers */
  headers?: Record<string, string>;
  /** If true, adds Authorization: Bearer header with the resolved API key */
  authHeader?: boolean;
  /** Models registered under this provider */
  models?: ModelConfig[];
  /** Per-model overrides for built-in providers */
  modelOverrides?: Record<string, Partial<ModelConfig>>;
  /** Provider-level compatibility settings */
  compat?: CompatConfig;
}

export interface ModelConfig {
  /** Model identifier (passed to the API) */
  id: string;
  /** Human-readable model label */
  name?: string;
  /** API type override for this specific model */
  api?: string;
  /** API endpoint override for this specific model */
  baseUrl?: string;
  /** Whether the model supports extended thinking */
  reasoning?: boolean;
  /** Maps pi thinking levels to provider/model-specific values */
  thinkingLevelMap?: Record<string, string | null>;
  /** Supported input types */
  input?: ("text" | "image")[];
  /** Maximum context window size in tokens */
  contextWindow?: number;
  /** Maximum output tokens */
  maxTokens?: number;
  /** Cost per million tokens */
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** Custom headers for this specific model */
  headers?: Record<string, string>;
  /** Model-level compatibility settings */
  compat?: CompatConfig;
  /** 自定义 Payload 参数 — 附加到 API 请求体的键值对 */
  extraPayload?: ExtraPayloadParam[];
}

/** 单个自定义 Payload 参数 */
export interface ExtraPayloadParam {
  /** 参数键名 */
  key: string;
  /** 值类型 */
  type: "json" | "string" | "bool";
  /** 参数值（以字符串形式存储，bool 为 "true"/"false"，json 为合法 JSON 字符串） */
  value: string;
}

/** Compatibility settings for OpenAI / Anthropic APIs */
export interface CompatConfig {
  // ── OpenAI compat ──
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "qwen-chat-template";
  cacheControlFormat?: "anthropic";
  supportsStrictMode?: boolean;
  supportsLongCacheRetention?: boolean;

  // ── Anthropic compat ──
  supportsEagerToolInputStreaming?: boolean;
  sendSessionAffinityHeaders?: boolean;
  supportsCacheControlOnTools?: boolean;
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
}

/** API type options */
export const API_TYPES = [
  { id: "openai-completions", label: "OpenAI Chat Completions (推荐)" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "google-generative-ai", label: "Google Generative AI" },
  { id: "google-vertex", label: "Google Vertex AI" },
  { id: "bedrock-converse-stream", label: "Amazon Bedrock Converse" },
  { id: "mistral-conversations", label: "Mistral SDK Conversations" },
] as const;

/** Thinking level keys */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
