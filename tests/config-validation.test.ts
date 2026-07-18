import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_PROVIDERS_PI_0_80_6,
  ModelsCandidateValidationError,
  assertValidModelsCandidate,
  validateModelsCandidate,
} from "../config-validation.ts";

const injectedBuiltIns = new Set(["native"]);
const options = { builtInProviders: injectedBuiltIns };

function issuePaths(candidate: unknown): string[] {
  return validateModelsCandidate(candidate, options).map((issue) => issue.path);
}

test("exports the exact Pi 0.80.6 built-in provider catalog", () => {
  assert.deepEqual([...BUILT_IN_PROVIDERS_PI_0_80_6], [
    "amazon-bedrock", "ant-ling", "anthropic", "azure-openai-responses", "cerebras",
    "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks", "github-copilot",
    "google", "google-vertex", "groq", "huggingface", "kimi-coding", "minimax", "minimax-cn",
    "mistral", "moonshotai", "moonshotai-cn", "nvidia", "openai", "openai-codex", "opencode",
    "opencode-go", "openrouter", "together", "vercel-ai-gateway", "xai", "xiaomi",
    "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai", "zai-coding-cn",
  ]);
});

test("accepts complete built-in and custom providers without changing unknown fields", () => {
  const candidate = {
    rootPreview: { keep: true },
    providers: {
      native: {
        nativePreview: 1,
        models: [{ id: "native-model", modelPreview: true }],
        modelOverrides: {
          "native-model": {
            name: "Native override", reasoning: true, thinkingLevelMap: { off: null, high: "high", max: "maximum" },
            input: ["text", "image"], cost: {
              input: 1, output: 2, cacheRead: 0, cacheWrite: 0,
              tiers: [{ inputTokensAbove: 2000, input: 2, output: 3, cacheRead: 0.2, cacheWrite: 0.4 }],
            },
            contextWindow: 1000, maxTokens: 100, headers: { "X-Test": "yes" },
            compat: { supportsStore: true, futureCompat: "keep" }, legacyPreview: "keep",
          },
        },
      },
      custom: {
        name: "Custom", baseUrl: "https://example.test", api: "openai-completions", apiKey: "$KEY",
        headers: { Authorization: "Bearer token" }, authHeader: false,
        compat: { thinkingFormat: "openrouter", maxTokensField: "max_tokens", futureCompat: 1 },
        models: [{
          id: "custom-model", name: "Custom model", reasoning: false,
          thinkingLevelMap: { off: null, minimal: "minimal", xhigh: "xhigh", max: "max" }, input: ["text"],
          contextWindow: 128000, maxTokens: 4096,
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2,
            tiers: [{ inputTokensAbove: 1000, input: 2, output: 3, cacheRead: 0.2, cacheWrite: 0.4 }] },
          headers: { "X-Model": "yes" }, compat: {
            supportsTemperature: true,
            chatTemplateKwargs: {
              scalar: "auto", count: 2, enabled: true, empty: null,
              effort: { $var: "thinking.effort", omitWhenOff: true, futureVariableField: "keep" },
            },
            openRouterRouting: {
              allow_fallbacks: true, require_parameters: false, data_collection: "deny", zdr: true,
              enforce_distillable_text: false, order: ["one"], only: ["two"], ignore: ["three"],
              quantizations: ["fp8"], sort: { by: "price", partition: null, futureSortField: true },
              max_price: { prompt: 1, completion: "2", futurePriceField: true },
              preferred_min_throughput: { p50: 1, p99: 2, futureCutoff: true },
              preferred_max_latency: 500, futureRoutingField: true,
            },
            vercelGatewayRouting: { only: ["one"], order: ["two"], futureVercelField: true },
            futureCompat: true,
          },
          modelPreview: "keep",
        }],
      },
      emptyCustom: { headers: { "X-Keep": "yes" } },
    },
  };
  const before = structuredClone(candidate);

  assert.deepEqual(validateModelsCandidate(candidate, options), []);
  assert.doesNotThrow(() => assertValidModelsCandidate(candidate, options));
  assert.deepEqual(candidate, before);
});

test("rejects malformed root and provider field families", () => {
  const cases: Array<[unknown, string]> = [
    [null, "$"],
    [[], "$"],
    [{}, "$.providers"],
    [{ providers: [] }, "$.providers"],
    [{ providers: { p: null } }, "$.providers.p"],
    [{ providers: { p: { name: "" } } }, "$.providers.p.name"],
    [{ providers: { p: { baseUrl: 1 } } }, "$.providers.p.baseUrl"],
    [{ providers: { p: { api: " " } } }, "$.providers.p.api"],
    [{ providers: { p: { apiKey: false } } }, "$.providers.p.apiKey"],
    [{ providers: { p: { headers: { Good: "yes", Bad: 1 } } } }, "$.providers.p.headers.Bad"],
    [{ providers: { p: { authHeader: "yes" } } }, "$.providers.p.authHeader"],
    [{ providers: { p: { models: {} } } }, "$.providers.p.models"],
    [{ providers: { p: { modelOverrides: [] } } }, "$.providers.p.modelOverrides"],
    [{ providers: { p: { compat: false } } }, "$.providers.p.compat"],
  ];
  for (const [candidate, path] of cases) assert.ok(issuePaths(candidate).includes(path), path);
});

test("rejects malformed model values, costs, tiers, and known compat fields", () => {
  const model = (patch: Record<string, unknown>) => ({
    providers: { native: { models: [{ id: "model", ...patch }] } },
  });
  const cases: Array<[unknown, string]> = [
    [model({ id: "" }), "$.providers.native.models[0].id"],
    [model({ name: 1 }), "$.providers.native.models[0].name"],
    [model({ api: "" }), "$.providers.native.models[0].api"],
    [model({ baseUrl: " " }), "$.providers.native.models[0].baseUrl"],
    [model({ reasoning: 1 }), "$.providers.native.models[0].reasoning"],
    [model({ thinkingLevelMap: { future: "future" } }), "$.providers.native.models[0].thinkingLevelMap.future"],
    [model({ thinkingLevelMap: { high: "" } }), "$.providers.native.models[0].thinkingLevelMap.high"],
    [model({ input: ["audio"] }), "$.providers.native.models[0].input[0]"],
    [model({ contextWindow: 0 }), "$.providers.native.models[0].contextWindow"],
    [model({ maxTokens: 1.5 }), "$.providers.native.models[0].maxTokens"],
    [model({ headers: { X: null } }), "$.providers.native.models[0].headers.X"],
    [model({ cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }), "$.providers.native.models[0].cost.input"],
    [model({ cost: { input: 0, output: Number.POSITIVE_INFINITY, cacheRead: 0, cacheWrite: 0 } }), "$.providers.native.models[0].cost.output"],
    [model({ cost: { input: 0, output: 0, cacheRead: 0 } }), "$.providers.native.models[0].cost.cacheWrite"],
    [model({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [{}] } }), "$.providers.native.models[0].cost.tiers[0].inputTokensAbove"],
    [model({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: -1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }] } }), "$.providers.native.models[0].cost.tiers[0].inputTokensAbove"],
    [model({ compat: { supportsStore: "yes" } }), "$.providers.native.models[0].compat.supportsStore"],
    [model({ compat: { maxTokensField: "tokens" } }), "$.providers.native.models[0].compat.maxTokensField"],
    [model({ compat: { thinkingFormat: "future" } }), "$.providers.native.models[0].compat.thinkingFormat"],
    [model({ compat: { cacheControlFormat: "future" } }), "$.providers.native.models[0].compat.cacheControlFormat"],
    [model({ compat: { chatTemplateKwargs: [] } }), "$.providers.native.models[0].compat.chatTemplateKwargs"],
    [model({ compat: { chatTemplateKwargs: { bad: [] } } }), "$.providers.native.models[0].compat.chatTemplateKwargs.bad"],
    [model({ compat: { chatTemplateKwargs: { bad: { $var: "future" } } } }), "$.providers.native.models[0].compat.chatTemplateKwargs.bad.$var"],
    [model({ compat: { chatTemplateKwargs: { bad: { $var: "thinking.enabled", omitWhenOff: "yes" } } } }), "$.providers.native.models[0].compat.chatTemplateKwargs.bad.omitWhenOff"],
    [model({ compat: { openRouterRouting: { allow_fallbacks: "yes" } } }), "$.providers.native.models[0].compat.openRouterRouting.allow_fallbacks"],
    [model({ compat: { openRouterRouting: { data_collection: "always" } } }), "$.providers.native.models[0].compat.openRouterRouting.data_collection"],
    [model({ compat: { openRouterRouting: { order: [1] } } }), "$.providers.native.models[0].compat.openRouterRouting.order[0]"],
    [model({ compat: { openRouterRouting: { sort: [] } } }), "$.providers.native.models[0].compat.openRouterRouting.sort"],
    [model({ compat: { openRouterRouting: { sort: { by: 1 } } } }), "$.providers.native.models[0].compat.openRouterRouting.sort.by"],
    [model({ compat: { openRouterRouting: { sort: { partition: false } } } }), "$.providers.native.models[0].compat.openRouterRouting.sort.partition"],
    [model({ compat: { openRouterRouting: { max_price: { prompt: false } } } }), "$.providers.native.models[0].compat.openRouterRouting.max_price.prompt"],
    [model({ compat: { openRouterRouting: { preferred_min_throughput: { p50: "fast" } } } }), "$.providers.native.models[0].compat.openRouterRouting.preferred_min_throughput.p50"],
    [model({ compat: { openRouterRouting: { preferred_max_latency: [] } } }), "$.providers.native.models[0].compat.openRouterRouting.preferred_max_latency"],
    [model({ compat: { vercelGatewayRouting: { only: [1] } } }), "$.providers.native.models[0].compat.vercelGatewayRouting.only[0]"],
  ];
  for (const [candidate, path] of cases) assert.ok(issuePaths(candidate).includes(path), path);
});

test("accepts max thinking maps, empty input arrays, and override cost tiers", () => {
  assert.deepEqual(issuePaths({ providers: { native: {
    models: [{ id: "model", thinkingLevelMap: { max: "maximum" }, input: [] }],
    modelOverrides: { model: {
      thinkingLevelMap: { max: null }, input: [],
      cost: { tiers: [{ inputTokensAbove: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }] },
    } },
  } } }), []);
});

test("enforces custom-provider and empty-provider cross-rules", () => {
  const cases: Array<[unknown, string]> = [
    [{ providers: { custom: { models: [{ id: "m", api: "openai-completions" }] } } }, "$.providers.custom.baseUrl"],
    [{ providers: { custom: { baseUrl: "https://example.test", models: [{ id: "m" }] } } }, "$.providers.custom.models[0].api"],
    [{ providers: { custom: {} } }, "$.providers.custom"],
    [{ providers: { custom: { modelOverrides: {} } } }, "$.providers.custom"],
  ];
  for (const [candidate, path] of cases) assert.ok(issuePaths(candidate).includes(path), path);

  assert.deepEqual(issuePaths({ providers: {
    custom: { baseUrl: "https://example.test", api: "openai-completions", models: [{ id: "m" }] },
  } }), []);
  assert.deepEqual(issuePaths({ providers: {
    custom: { baseUrl: "https://example.test", models: [{ id: "m", api: "openai-completions" }] },
  } }), []);
});

test("validates override descriptors without exposing full-model fields as known schema", () => {
  const override = (value: unknown) => ({ providers: { native: { modelOverrides: { m: value } } } });
  const cases: Array<[unknown, string]> = [
    [override(null), "$.providers.native.modelOverrides.m"],
    [override({ name: "" }), "$.providers.native.modelOverrides.m.name"],
    [override({ reasoning: "yes" }), "$.providers.native.modelOverrides.m.reasoning"],
    [override({ input: ["audio"] }), "$.providers.native.modelOverrides.m.input[0]"],
    [override({ contextWindow: -1 }), "$.providers.native.modelOverrides.m.contextWindow"],
    [override({ cost: { input: -1 } }), "$.providers.native.modelOverrides.m.cost.input"],
    [override({ cost: { tiers: [{}] } }), "$.providers.native.modelOverrides.m.cost.tiers[0].inputTokensAbove"],
  ];
  for (const [candidate, path] of cases) assert.ok(issuePaths(candidate).includes(path), path);

  assert.deepEqual(issuePaths(override({
    id: "legacy-id", api: "legacy-api", baseUrl: "legacy-url", privatePayload: { keep: true },
  })), []);
});

test("assertion error reports paths and messages but never inspected secret values", () => {
  const secret = "do-not-serialize-this-secret";
  assert.throws(
    () => assertValidModelsCandidate({ providers: { p: { apiKey: secret, headers: { Authorization: 42 } } } }, options),
    (error: unknown) => {
      assert.ok(error instanceof ModelsCandidateValidationError);
      assert.ok(error.issues.length > 0);
      assert.match(error.message, /\$\.providers\.p/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("rejects duplicate model ids within a provider", () => {
  const paths = issuePaths({
    providers: {
      native: {
        models: [{ id: "dup" }, { id: "dup" }],
      },
    },
  });
  assert.ok(paths.includes("$.providers.native.models[1].id"));
});


test("inherited Object.prototype and custom-prototype fields never satisfy validation", () => {
  const proto = Object.prototype as Record<string, unknown>;
  const previousBase = proto.baseUrl;
  const previousApi = proto.api;
  const previousModels = proto.models;
  try {
    Object.defineProperty(Object.prototype, "baseUrl", {
      value: "http://evil",
      configurable: true,
      enumerable: true,
      writable: true,
    });
    Object.defineProperty(Object.prototype, "api", {
      value: "openai-completions",
      configurable: true,
      enumerable: true,
      writable: true,
    });
    Object.defineProperty(Object.prototype, "models", {
      value: [{ id: "evil" }],
      configurable: true,
      enumerable: true,
      writable: true,
    });

    const polluted = {
      providers: {
        custom: {
          models: [{ id: "m1" }],
        },
      },
    };
    const paths = issuePaths(polluted);
    assert.ok(paths.includes("$.providers.custom.baseUrl"));

    const customProto = { baseUrl: "http://custom", api: "openai-completions" };
    const provider = Object.create(customProto) as Record<string, unknown>;
    provider.models = [{ id: "m2" }];
    const paths2 = issuePaths({ providers: { custom2: provider } });
    assert.ok(paths2.includes("$.providers.custom2.baseUrl"));
  } finally {
    if (previousBase === undefined) delete proto.baseUrl;
    else Object.defineProperty(Object.prototype, "baseUrl", {
      value: previousBase, configurable: true, enumerable: true, writable: true,
    });
    if (previousApi === undefined) delete proto.api;
    else Object.defineProperty(Object.prototype, "api", {
      value: previousApi, configurable: true, enumerable: true, writable: true,
    });
    if (previousModels === undefined) delete proto.models;
    else Object.defineProperty(Object.prototype, "models", {
      value: previousModels, configurable: true, enumerable: true, writable: true,
    });
  }
});
