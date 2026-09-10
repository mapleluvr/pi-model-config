import { cloneOwnJsonData } from "./own-keys.ts";
import { OAUTH_PROVIDER_TYPES } from "./types.ts";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationOptions {
  builtInProviders: ReadonlySet<string>;
}

export const BUILT_IN_PROVIDERS_PI_0_85_1: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "baseten",
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
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "radius",
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

const DEFAULT_OPTIONS: ValidationOptions = { builtInProviders: BUILT_IN_PROVIDERS_PI_0_85_1 };
const THINKING_LEVEL_KEYS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const INPUT_TYPES = new Set(["text", "image"]);
const THINKING_FORMATS = new Set([
  "openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template",
  "qwen-chat-template", "string-thinking", "ant-ling",
]);
const BOOLEAN_COMPAT_FIELDS = [
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsFinishReason",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "supportsStrictMode",
  "supportsOpenAIGrammarTools",
  "supportsLongCacheRetention",
  "supportsTemperature",
  "zaiToolStream",
  "supportsAdditionalTools",
  "supportsToolSearch",
  "supportsMaxOutputTokens",
  "supportsEagerToolInputStreaming",
  "sendSessionAffinityHeaders",
  "supportsCacheControlOnTools",
  "forceAdaptiveThinking",
  "allowEmptySignature",
  "supportsStrictTools",
  "supportsMidConvoEffort",
  "supportsToolReferences",
] as const;
const SESSION_AFFINITY_FORMATS = new Set(["openai", "openai-nosession", "openrouter"]);
const DEFERRED_TOOLS_MODES = new Set(["kimi"]);
/** The engine resolves all three; the models.json TypeBox schema only declares two. */
const CHAT_TEMPLATE_VARIABLES = new Set([
  "thinking.enabled", "thinking.effort", "thinking.budget",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Raw JSON value read from a candidate document before validation narrows it. */
type CandidateJson =
  | string
  | number
  | boolean
  | null
  | CandidateJson[]
  | { [key: string]: CandidateJson };

function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return  Object.hasOwn(target, key);
}

function getOwn(target: Record<string, unknown>, key: string): CandidateJson | undefined {
  return hasOwn(target, key) ? (target[key] as CandidateJson) : undefined;
}

/**
 * Deep own-data-property materialization onto null prototypes.
 * Inherited fields and serialization/accessor hooks are never observed.
 */
export function materializeOwnOnly(value: unknown): CandidateJson {
  return cloneOwnJsonData(value, { allowNonFiniteNumbers: true }) as CandidateJson;
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
  if (!hasOwn(object, key)) return;
  const value = getOwn(object, key);
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(issues, childPath(path, key), "must be a non-empty string when present");
  }
}

function validateBoolean(
  object: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!hasOwn(object, key)) return;
  if (typeof getOwn(object, key) !== "boolean") {
    addIssue(issues, childPath(path, key), "must be a boolean when present");
  }
}

function validateHeaders(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object with string values");
    return;
  }
  for (const key of Object.keys(value)) {
    if (!hasOwn(value, key)) continue;
    if (typeof getOwn(value, key) !== "string") addIssue(issues, childPath(path, key), "must be a string");
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

function validateChatTemplateValues(value: unknown, path: string, issues: ValidationIssue[]): void {
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
    if (typeof kwarg.$var !== "string" || !CHAT_TEMPLATE_VARIABLES.has(kwarg.$var)) {
      addIssue(issues, childPath(kwargPath, "$var"), "must be thinking.enabled, thinking.effort, or thinking.budget");
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
    if (isObject(value.max_price)) {
      for (const key of OPEN_ROUTER_PRICE_FIELDS) {
        const price = value.max_price[key];
        if (price !== undefined && typeof price !== "string" && (typeof price !== "number" || !Number.isFinite(price))) {
          addIssue(issues, childPath(pricePath, key), "must be a finite number or string");
        }
      }
    } else addIssue(issues, pricePath, "must be an object");
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
    validateChatTemplateValues(value.chatTemplateKwargs, childPath(path, "chatTemplateKwargs"), issues);
  }
  if (value.chatTemplateArgs !== undefined) {
    validateChatTemplateValues(value.chatTemplateArgs, childPath(path, "chatTemplateArgs"), issues);
  }
  if (value.deferredToolsMode !== undefined
    && (typeof value.deferredToolsMode !== "string" || !DEFERRED_TOOLS_MODES.has(value.deferredToolsMode))) {
    addIssue(issues, childPath(path, "deferredToolsMode"), "must be kimi");
  }
  if (value.sessionAffinityFormat !== undefined
    && (typeof value.sessionAffinityFormat !== "string" || !SESSION_AFFINITY_FORMATS.has(value.sessionAffinityFormat))) {
    addIssue(issues, childPath(path, "sessionAffinityFormat"), "must be openai, openai-nosession, or openrouter");
  }
  if (value.vllmPriority !== undefined) {
    validateFiniteNumber(value.vllmPriority, childPath(path, "vllmPriority"), issues);
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
    if (Array.isArray(value.tiers)) value.tiers.forEach((tier, index) => validateCostTier(tier, `${tiersPath}[${index}]`, issues)); else addIssue(issues, tiersPath, "must be an array");
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
    if (Array.isArray(value.tiers)) value.tiers.forEach((tier, index) => validateCostTier(tier, `${tiersPath}[${index}]`, issues)); else addIssue(issues, tiersPath, "must be an array");
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
  if (hasOwn(value, "thinkingLevelMap")) {
    validateThinkingLevelMap(getOwn(value, "thinkingLevelMap"), childPath(path, "thinkingLevelMap"), issues);
  }
  if (hasOwn(value, "input")) validateInput(getOwn(value, "input"), childPath(path, "input"), issues);
  if (hasOwn(value, "contextWindow")) {
    validatePositiveInteger(getOwn(value, "contextWindow"), childPath(path, "contextWindow"), issues);
  }
  if (hasOwn(value, "maxTokens")) {
    validatePositiveInteger(getOwn(value, "maxTokens"), childPath(path, "maxTokens"), issues);
  }
  if (hasOwn(value, "cost")) {
    const costPath = childPath(path, "cost");
    const cost = getOwn(value, "cost");
    if (override) validateOverrideCost(cost, costPath, issues);
    else validateModelCost(cost, costPath, issues);
  }
  if (hasOwn(value, "headers")) validateHeaders(getOwn(value, "headers"), childPath(path, "headers"), issues);
  if (hasOwn(value, "compat")) validateCompat(getOwn(value, "compat"), childPath(path, "compat"), issues);
  if (hasOwn(value, "samplingParams")) {
    const samplingParams = getOwn(value, "samplingParams");
    if (!isObject(samplingParams)) {
      addIssue(issues, childPath(path, "samplingParams"), "must be an object");
    }
  }
}

function validateModel(value: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    addIssue(issues, path, "must be an object");
    return undefined;
  }
  const id = getOwn(value, "id");
  if (typeof id !== "string" || id.trim().length === 0) {
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
  if (hasOwn(value, "oauth")) {
    const oauth = getOwn(value, "oauth");
    if (typeof oauth !== "string" || !(OAUTH_PROVIDER_TYPES as readonly string[]).includes(oauth)) {
      addIssue(issues, childPath(path, "oauth"), "must be radius");
    }
  }
  if (hasOwn(value, "headers")) validateHeaders(getOwn(value, "headers"), childPath(path, "headers"), issues);
  if (hasOwn(value, "compat")) validateCompat(getOwn(value, "compat"), childPath(path, "compat"), issues);

  let models: Array<Record<string, unknown> | undefined> | undefined;
  const modelsValue = hasOwn(value, "models") ? getOwn(value, "models") : undefined;
  if (modelsValue !== undefined) {
    const modelsPath = childPath(path, "models");
    if (Array.isArray(modelsValue)) {
      models = modelsValue.map((model, index) => validateModel(model, `${modelsPath}[${index}]`, issues));
      const seenIds = new Set<string>();
      modelsValue.forEach((model, index) => {
        if (!isObject(model)) return;
        const modelId = getOwn(model, "id");
        if (typeof modelId !== "string" || modelId.trim().length === 0) return;
        if (seenIds.has(modelId)) {
          addIssue(issues, `${modelsPath}[${index}].id`, "must be unique within the provider");
        } else {
          seenIds.add(modelId);
        }
      });
    } else addIssue(issues, modelsPath, "must be an array");
  }

  let overrideCount = 0;
  if (hasOwn(value, "modelOverrides")) {
    const overridesPath = childPath(path, "modelOverrides");
    const overrides = getOwn(value, "modelOverrides");
    if (isObject(overrides)) {
      overrideCount = Object.keys(overrides).filter((key) => hasOwn(overrides, key)).length;
      for (const modelId of Object.keys(overrides)) {
        if (!hasOwn(overrides, modelId)) continue;
        validateOverride(getOwn(overrides, modelId), childPath(overridesPath, modelId), issues);
      }
    } else addIssue(issues, overridesPath, "must be an object");
  }

  const hasModels = Array.isArray(modelsValue) && modelsValue.length > 0;
  const ownBaseUrl = hasOwn(value, "baseUrl") ? getOwn(value, "baseUrl") : undefined;
  const ownApi = hasOwn(value, "api") ? getOwn(value, "api") : undefined;
  if (!options.builtInProviders.has(providerId) && hasModels) {
    if (typeof ownBaseUrl !== "string" || ownBaseUrl.trim().length === 0) {
      addIssue(issues, childPath(path, "baseUrl"), "is required for a custom provider with models");
    }
    models?.forEach((model, index) => {
      if (model === undefined) return;
      const modelApi = hasOwn(model, "api") ? getOwn(model, "api") : undefined;
      if ((typeof ownApi !== "string" || ownApi.trim().length === 0)
        && (typeof modelApi !== "string" || modelApi.trim().length === 0)) {
        addIssue(issues, `${childPath(path, "models")}[${index}].api`, "must be defined by the model or inherited from its provider");
      }
    });
  }

  const isEmptyProvider = !hasModels;
  const retainsEmptyProviderData = ownBaseUrl !== undefined
    || hasOwn(value, "headers")
    || hasOwn(value, "compat")
    || overrideCount > 0;
  if (isEmptyProvider && !retainsEmptyProviderData) {
    addIssue(issues, path, "an empty provider must retain baseUrl, headers, compat, or non-empty modelOverrides");
  }
}

export function validateModelsCandidate(
  candidate: unknown,
  options: ValidationOptions = DEFAULT_OPTIONS,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let materialized: Record<string, unknown>;
  try {
    const materializedValue = materializeOwnOnly(candidate);
    if (!isObject(materializedValue)) {
      addIssue(issues, "$", "must be an object");
      return issues;
    }
    materialized = materializedValue;
  } catch {
    addIssue(issues, "$", "must contain only own JSON data properties");
    return issues;
  }
  if (!hasOwn(materialized, "providers")) {
    addIssue(issues, "$.providers", "must be an object");
    return issues;
  }
  const providersValue = getOwn(materialized, "providers");
  if (!isObject(providersValue)) {
    addIssue(issues, "$.providers", "must be an object");
    return issues;
  }
  const providers: Record<string, unknown> = providersValue;
  for (const providerId of Object.keys(providers)) {
    if (!hasOwn(providers, providerId)) continue;
    validateProvider(providerId, getOwn(providers, providerId), childPath("$.providers", providerId), options, issues);
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
