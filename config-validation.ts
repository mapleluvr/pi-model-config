export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationOptions {
  builtInProviders: ReadonlySet<string>;
}

export const BUILT_IN_PROVIDERS_PI_0_80_6: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
]);

const DEFAULT_OPTIONS: ValidationOptions = { builtInProviders: BUILT_IN_PROVIDERS_PI_0_80_6 };
const THINKING_LEVEL_KEYS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const INPUT_TYPES = new Set(["text", "image"]);
const THINKING_FORMATS = new Set([
  "openai", "openrouter", "deepseek", "together", "zai", "qwen", "chat-template",
  "qwen-chat-template", "string-thinking", "ant-ling",
]);
const BOOLEAN_COMPAT_FIELDS = [
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "supportsStrictMode",
  "supportsLongCacheRetention",
  "supportsTemperature",
  "zaiToolStream",
  "sendSessionIdHeader",
  "supportsEagerToolInputStreaming",
  "sendSessionAffinityHeaders",
  "supportsCacheControlOnTools",
  "forceAdaptiveThinking",
  "allowEmptySignature",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childPath(parent: string, key: string): string {
  return `${parent}.${key}`;
}

function addIssue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function validateOptionalNonEmptyString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (object[key] !== undefined && (typeof object[key] !== "string" || object[key].trim().length === 0)) {
    addIssue(issues, childPath(path, key), "must be a non-empty string when present");
  }
}

function validateBoolean(
  object: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (object[key] !== undefined && typeof object[key] !== "boolean") {
    addIssue(issues, childPath(path, key), "must be a boolean when present");
  }
}

function validateHeaders(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object with string values");
    return;
  }
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") addIssue(issues, childPath(path, key), "must be a string");
  }
}

function validatePositiveInteger(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    addIssue(issues, path, "must be a positive integer");
  }
}

function validateRate(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    addIssue(issues, path, "must be a finite non-negative number");
  }
}

function validateThinkingLevelMap(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  for (const [level, mappedValue] of Object.entries(value)) {
    const levelPath = childPath(path, level);
    if (!THINKING_LEVEL_KEYS.has(level)) {
      addIssue(issues, levelPath, "is not a supported Pi thinking level");
      continue;
    }
    if (mappedValue !== null && (typeof mappedValue !== "string" || mappedValue.trim().length === 0)) {
      addIssue(issues, levelPath, "must be null or a non-empty string");
    }
  }
}

function validateInput(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "must be an array");
    return;
  }
  value.forEach((input, index) => {
    if (typeof input !== "string" || !INPUT_TYPES.has(input)) {
      addIssue(issues, `${path}[${index}]`, "must be text or image");
    }
  });
}

function validateStringArray(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "must be an array of strings");
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string") addIssue(issues, `${path}[${index}]`, "must be a string");
  });
}

function validateFiniteNumber(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value)) addIssue(issues, path, "must be a finite number");
}

function validateChatTemplateKwargs(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  for (const [key, kwarg] of Object.entries(value)) {
    const kwargPath = childPath(path, key);
    const isScalar = kwarg === null || typeof kwarg === "string" || typeof kwarg === "boolean"
      || (typeof kwarg === "number" && Number.isFinite(kwarg));
    if (isScalar) continue;
    if (!isObject(kwarg)) {
      addIssue(issues, kwargPath, "must be a scalar or thinking variable object");
      continue;
    }
    if (kwarg.$var !== "thinking.enabled" && kwarg.$var !== "thinking.effort") {
      addIssue(issues, childPath(kwargPath, "$var"), "must be thinking.enabled or thinking.effort");
    }
    if (kwarg.omitWhenOff !== undefined && typeof kwarg.omitWhenOff !== "boolean") {
      addIssue(issues, childPath(kwargPath, "omitWhenOff"), "must be a boolean when present");
    }
  }
}

const OPEN_ROUTER_BOOLEAN_FIELDS = [
  "allow_fallbacks", "require_parameters", "zdr", "enforce_distillable_text",
] as const;
const OPEN_ROUTER_ARRAY_FIELDS = ["order", "only", "ignore", "quantizations"] as const;
const OPEN_ROUTER_PRICE_FIELDS = ["prompt", "completion", "image", "audio", "request"] as const;
const PERCENTILE_FIELDS = ["p50", "p75", "p90", "p99"] as const;

function validatePercentileOrNumber(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value === "number") {
    validateFiniteNumber(value, path, issues);
    return;
  }
  if (!isObject(value)) {
    addIssue(issues, path, "must be a finite number or percentile object");
    return;
  }
  for (const key of PERCENTILE_FIELDS) {
    if (value[key] !== undefined) validateFiniteNumber(value[key], childPath(path, key), issues);
  }
}

function validateOpenRouterRouting(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  for (const key of OPEN_ROUTER_BOOLEAN_FIELDS) validateBoolean(value, key, path, issues);
  for (const key of OPEN_ROUTER_ARRAY_FIELDS) {
    if (value[key] !== undefined) validateStringArray(value[key], childPath(path, key), issues);
  }
  if (value.data_collection !== undefined && value.data_collection !== "deny" && value.data_collection !== "allow") {
    addIssue(issues, childPath(path, "data_collection"), "must be deny or allow");
  }
  if (value.sort !== undefined) {
    const sortPath = childPath(path, "sort");
    if (typeof value.sort !== "string" && !isObject(value.sort)) addIssue(issues, sortPath, "must be a string or object");
    else if (isObject(value.sort)) {
      if (value.sort.by !== undefined && typeof value.sort.by !== "string") {
        addIssue(issues, childPath(sortPath, "by"), "must be a string when present");
      }
      if (value.sort.partition !== undefined && value.sort.partition !== null && typeof value.sort.partition !== "string") {
        addIssue(issues, childPath(sortPath, "partition"), "must be a string or null when present");
      }
    }
  }
  if (value.max_price !== undefined) {
    const pricePath = childPath(path, "max_price");
    if (!isObject(value.max_price)) addIssue(issues, pricePath, "must be an object");
    else {
      for (const key of OPEN_ROUTER_PRICE_FIELDS) {
        const price = value.max_price[key];
        if (price !== undefined && typeof price !== "string" && (typeof price !== "number" || !Number.isFinite(price))) {
          addIssue(issues, childPath(pricePath, key), "must be a finite number or string");
        }
      }
    }
  }
  if (value.preferred_min_throughput !== undefined) {
    validatePercentileOrNumber(value.preferred_min_throughput, childPath(path, "preferred_min_throughput"), issues);
  }
  if (value.preferred_max_latency !== undefined) {
    validatePercentileOrNumber(value.preferred_max_latency, childPath(path, "preferred_max_latency"), issues);
  }
}

function validateVercelGatewayRouting(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  if (value.only !== undefined) validateStringArray(value.only, childPath(path, "only"), issues);
  if (value.order !== undefined) validateStringArray(value.order, childPath(path, "order"), issues);
}

function validateCompat(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }

  for (const key of BOOLEAN_COMPAT_FIELDS) validateBoolean(value, key, path, issues);

  if (value.maxTokensField !== undefined && value.maxTokensField !== "max_completion_tokens" && value.maxTokensField !== "max_tokens") {
    addIssue(issues, childPath(path, "maxTokensField"), "must be max_completion_tokens or max_tokens");
  }
  if (value.thinkingFormat !== undefined && (typeof value.thinkingFormat !== "string" || !THINKING_FORMATS.has(value.thinkingFormat))) {
    addIssue(issues, childPath(path, "thinkingFormat"), "must be a supported thinking format");
  }
  if (value.cacheControlFormat !== undefined && value.cacheControlFormat !== "anthropic") {
    addIssue(issues, childPath(path, "cacheControlFormat"), "must be anthropic");
  }
  if (value.chatTemplateKwargs !== undefined) {
    validateChatTemplateKwargs(value.chatTemplateKwargs, childPath(path, "chatTemplateKwargs"), issues);
  }
  if (value.openRouterRouting !== undefined) {
    validateOpenRouterRouting(value.openRouterRouting, childPath(path, "openRouterRouting"), issues);
  }
  if (value.vercelGatewayRouting !== undefined) {
    validateVercelGatewayRouting(value.vercelGatewayRouting, childPath(path, "vercelGatewayRouting"), issues);
  }
}

const COST_RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function validateCostTier(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  validatePositiveInteger(value.inputTokensAbove, childPath(path, "inputTokensAbove"), issues);
  for (const key of COST_RATE_KEYS) validateRate(value[key], childPath(path, key), issues);
}

function validateModelCost(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  for (const key of COST_RATE_KEYS) validateRate(value[key], childPath(path, key), issues);
  if (value.tiers !== undefined) {
    const tiersPath = childPath(path, "tiers");
    if (!Array.isArray(value.tiers)) addIssue(issues, tiersPath, "must be an array");
    else value.tiers.forEach((tier, index) => validateCostTier(tier, `${tiersPath}[${index}]`, issues));
  }
}

function validateOverrideCost(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  for (const key of COST_RATE_KEYS) {
    if (value[key] !== undefined) validateRate(value[key], childPath(path, key), issues);
  }
  if (value.tiers !== undefined) {
    const tiersPath = childPath(path, "tiers");
    if (!Array.isArray(value.tiers)) addIssue(issues, tiersPath, "must be an array");
    else value.tiers.forEach((tier, index) => validateCostTier(tier, `${tiersPath}[${index}]`, issues));
  }
}

function validateModelLikeFields(
  value: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
  override: boolean,
): void {
  validateOptionalNonEmptyString(value, "name", path, issues);
  validateBoolean(value, "reasoning", path, issues);
  if (value.thinkingLevelMap !== undefined) validateThinkingLevelMap(value.thinkingLevelMap, childPath(path, "thinkingLevelMap"), issues);
  if (value.input !== undefined) validateInput(value.input, childPath(path, "input"), issues);
  if (value.contextWindow !== undefined) validatePositiveInteger(value.contextWindow, childPath(path, "contextWindow"), issues);
  if (value.maxTokens !== undefined) validatePositiveInteger(value.maxTokens, childPath(path, "maxTokens"), issues);
  if (value.cost !== undefined) {
    const costPath = childPath(path, "cost");
    if (override) validateOverrideCost(value.cost, costPath, issues);
    else validateModelCost(value.cost, costPath, issues);
  }
  if (value.headers !== undefined) validateHeaders(value.headers, childPath(path, "headers"), issues);
  if (value.compat !== undefined) validateCompat(value.compat, childPath(path, "compat"), issues);
}

function validateModel(value: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return undefined;
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    addIssue(issues, childPath(path, "id"), "must be a non-empty string");
  }
  validateOptionalNonEmptyString(value, "api", path, issues);
  validateOptionalNonEmptyString(value, "baseUrl", path, issues);
  validateModelLikeFields(value, path, issues, false);
  return value;
}

function validateOverride(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  validateModelLikeFields(value, path, issues, true);
}

function validateProvider(
  providerId: string,
  value: unknown,
  path: string,
  options: ValidationOptions,
  issues: ValidationIssue[],
): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }

  for (const key of ["name", "baseUrl", "api", "apiKey"] as const) {
    validateOptionalNonEmptyString(value, key, path, issues);
  }
  validateBoolean(value, "authHeader", path, issues);
  if (value.headers !== undefined) validateHeaders(value.headers, childPath(path, "headers"), issues);
  if (value.compat !== undefined) validateCompat(value.compat, childPath(path, "compat"), issues);

  let models: Array<Record<string, unknown> | undefined> | undefined;
  if (value.models !== undefined) {
    const modelsPath = childPath(path, "models");
    if (!Array.isArray(value.models)) addIssue(issues, modelsPath, "must be an array");
    else models = value.models.map((model, index) => validateModel(model, `${modelsPath}[${index}]`, issues));
  }

  let overrideCount = 0;
  if (value.modelOverrides !== undefined) {
    const overridesPath = childPath(path, "modelOverrides");
    if (!isObject(value.modelOverrides)) addIssue(issues, overridesPath, "must be an object");
    else {
      overrideCount = Object.keys(value.modelOverrides).length;
      for (const [modelId, override] of Object.entries(value.modelOverrides)) {
        validateOverride(override, childPath(overridesPath, modelId), issues);
      }
    }
  }

  const hasModels = Array.isArray(value.models) && value.models.length > 0;
  if (!options.builtInProviders.has(providerId) && hasModels) {
    if (typeof value.baseUrl !== "string" || value.baseUrl.trim().length === 0) {
      addIssue(issues, childPath(path, "baseUrl"), "is required for a custom provider with models");
    }
    models?.forEach((model, index) => {
      if (model !== undefined && (typeof value.api !== "string" || value.api.trim().length === 0)
        && (typeof model.api !== "string" || model.api.trim().length === 0)) {
        addIssue(issues, `${childPath(path, "models")}[${index}].api`, "must be defined by the model or inherited from its provider");
      }
    });
  }

  const isEmptyProvider = !hasModels;
  const retainsEmptyProviderData = value.baseUrl !== undefined || value.headers !== undefined
    || value.compat !== undefined || overrideCount > 0;
  if (isEmptyProvider && !retainsEmptyProviderData) {
    addIssue(issues, path, "an empty provider must retain baseUrl, headers, compat, or non-empty modelOverrides");
  }
}

export function validateModelsCandidate(
  candidate: unknown,
  options: ValidationOptions = DEFAULT_OPTIONS,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isObject(candidate)) {
    addIssue(issues, "$", "must be an object");
    return issues;
  }
  if (!isObject(candidate.providers)) {
    addIssue(issues, "$.providers", "must be an object");
    return issues;
  }
  for (const [providerId, provider] of Object.entries(candidate.providers)) {
    validateProvider(providerId, provider, childPath("$.providers", providerId), options, issues);
  }
  return issues;
}

export class ModelsCandidateValidationError extends Error {
  public readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`Invalid models.json candidate: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    this.name = "ModelsCandidateValidationError";
    this.issues = issues;
  }
}

export function assertValidModelsCandidate(
  candidate: unknown,
  options: ValidationOptions = DEFAULT_OPTIONS,
): void {
  const issues = validateModelsCandidate(candidate, options);
  if (issues.length > 0) throw new ModelsCandidateValidationError(issues);
}
