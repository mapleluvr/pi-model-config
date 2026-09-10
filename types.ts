// ── models.json 类型定义 ──

/** Any JSON value stored in models.json (own data properties only). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

export interface ModelCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ProviderConfig {
  [key: string]: unknown;
  /** Display name for the provider in UI */
  name?: string;
  /** API endpoint URL */
  baseUrl?: string;
  /** API type: openai-completions | anthropic-messages | google-generative-ai etc. */
  api?: string;
  /** API key (literal, env var with $, or command with !) */
  apiKey?: string;
  /** Dynamic OAuth provider type (currently "radius"; requires the gateway baseUrl) */
  oauth?: "radius";
  /** Custom headers */
  headers?: Record<string, string>;
  /** If true, adds Authorization: Bearer header with the resolved API key */
  authHeader?: boolean;
  /** Models registered under this provider */
  models?: ModelConfig[];
  /** Per-model overrides for built-in providers */
  modelOverrides?: Record<string, ModelOverrideConfig>;
  /** Provider-level compatibility settings */
  compat?: CompatConfig;
}

export interface ModelOverrideCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiers?: ModelCostTier[];
}

export interface ModelOverrideConfig {
  [key: string]: unknown;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input?: ("text" | "image")[];
  cost?: ModelOverrideCost;
  contextWindow?: number;
  maxTokens?: number;
  /** Default sampling parameters, merged per key with the base model's value */
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: CompatConfig;
}

export interface ModelConfig {
  [key: string]: unknown;
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
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  /** Supported input types */
  input?: ("text" | "image")[];
  /** Maximum context window size in tokens */
  contextWindow?: number;
  /** Maximum output tokens */
  maxTokens?: number;
  /** Sampling parameters merged verbatim into every OpenAI-compatible request body */
  samplingParams?: Record<string, unknown>;
  /** Cost per million tokens */
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: ModelCostTier[];
  };
  /** Custom headers for this specific model */
  headers?: Record<string, string>;
  /** Model-level compatibility settings */
  compat?: CompatConfig;
}

/** Dynamic OAuth provider types accepted in models.json. */
export const OAUTH_PROVIDER_TYPES = ["radius"] as const;

/** Compatibility settings for OpenAI / Anthropic APIs (Pi 0.85.1 surface) */
export interface CompatConfig {
  // ── OpenAI compat (openai-completions) ──
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsFinishReason?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "baseten" | "zai" | "qwen" |
    "chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling";
  cacheControlFormat?: "anthropic";
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  supportsLongCacheRetention?: boolean;
  supportsTemperature?: boolean;
  zaiToolStream?: boolean;
  chatTemplateKwargs?: Record<string, unknown>;
  chatTemplateArgs?: Record<string, unknown>;
  deferredToolsMode?: "kimi";
  sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
  vllmPriority?: number;
  openRouterRouting?: Record<string, unknown>;
  vercelGatewayRouting?: { only?: string[]; order?: string[] };

  // ── OpenAI Responses ──
  supportsAdditionalTools?: boolean;
  supportsToolSearch?: boolean;
  supportsMaxOutputTokens?: boolean;

  // ── Anthropic compat (anthropic-messages) ──
  supportsEagerToolInputStreaming?: boolean;
  sendSessionAffinityHeaders?: boolean;
  supportsCacheControlOnTools?: boolean;
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
  supportsStrictTools?: boolean;
  supportsMidConvoEffort?: boolean;
  supportsToolReferences?: boolean;
}

/** API type options */
export const API_TYPES = [
  { id: "openai-completions", label: "OpenAI Chat Completions (推荐)" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "azure-openai-responses", label: "Azure OpenAI Responses" },
  { id: "openai-codex-responses", label: "OpenAI Codex Responses" },
  { id: "google-generative-ai", label: "Google Generative AI" },
  { id: "google-vertex", label: "Google Vertex AI" },
  { id: "bedrock-converse-stream", label: "Amazon Bedrock Converse" },
  { id: "mistral-conversations", label: "Mistral SDK Conversations" },
  { id: "pi-messages", label: "Pi Messages (gateway)" },
] as const;

/** Single source for every editor API selector. */
export const API_TYPE_IDS: readonly string[] = API_TYPES.map((entry) => entry.id);

/** Thinking level keys */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
