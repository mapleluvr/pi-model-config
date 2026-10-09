import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_PROVIDERS_PI_1_1_0,
  BUILT_IN_PROVIDERS_PERMISSIVE,
  validateModelsCandidate,
} from "../config-validation.ts";

function validModel(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      probe: {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        models: [
          {
            id: "probe-model",
            ...fields,
          },
        ],
      },
    },
  };
}

test("Pi 1.1.0 validation: builtInProviders includes azure, meta, and typesafe (42 total)", () => {
  assert.equal(BUILT_IN_PROVIDERS_PI_1_1_0.size, 42);
  assert.ok(BUILT_IN_PROVIDERS_PI_1_1_0.has("azure"));
  assert.ok(BUILT_IN_PROVIDERS_PI_1_1_0.has("meta"));
  assert.ok(BUILT_IN_PROVIDERS_PI_1_1_0.has("typesafe"));
  assert.equal(BUILT_IN_PROVIDERS_PI_1_1_0.has("azure-openai-responses"), false);

  assert.equal(BUILT_IN_PROVIDERS_PERMISSIVE.size, 43);
  assert.ok(BUILT_IN_PROVIDERS_PERMISSIVE.has("azure-openai-responses"));
});

test("Pi 1.1.0 validation: accepts valid inputLimits, promptCache, and samplingParamsByThinkingLevel", () => {
  const issues = validateModelsCandidate(validModel({
    inputLimits: {
      maxRequestBytes: 10485760,
      images: {
        maxPerMessage: 10,
        maxPerRequest: 20,
        resize: {
          maxWidth: 2048,
          maxHeight: 2048,
          maxBytes: 5242880,
          jpegQuality: 85,
        },
      },
    },
    promptCache: {
      short: 300,
      long: 3600,
    },
    samplingParamsByThinkingLevel: {
      high: { temperature: 0.7, top_p: 0.95 },
      off: { temperature: 1.0 },
    },
  }));
  assert.deepEqual(issues, []);
});

test("Pi 1.1.0 validation: rejects invalid inputLimits", () => {
  // jpegQuality out of range (101)
  const issuesQuality101 = validateModelsCandidate(validModel({
    inputLimits: { images: { resize: { jpegQuality: 101 } } },
  }));
  assert.ok(issuesQuality101.some((i) => i.path.includes("jpegQuality") && i.message.includes("between 1 and 100")));

  // jpegQuality out of range (0)
  const issuesQuality0 = validateModelsCandidate(validModel({
    inputLimits: { images: { resize: { jpegQuality: 0 } } },
  }));
  assert.ok(issuesQuality0.some((i) => i.path.includes("jpegQuality")));

  // non-positive integer dimension
  const issuesNegativeWidth = validateModelsCandidate(validModel({
    inputLimits: { images: { resize: { maxWidth: -1 } } },
  }));
  assert.ok(issuesNegativeWidth.some((i) => i.path.includes("maxWidth")));
});

test("Pi 1.1.0 validation: rejects invalid promptCache", () => {
  const issuesZero = validateModelsCandidate(validModel({
    promptCache: { short: 0 },
  }));
  assert.ok(issuesZero.some((i) => i.path.includes("short") && i.message.includes("greater than 0")));

  const issuesNegative = validateModelsCandidate(validModel({
    promptCache: { long: -10 },
  }));
  assert.ok(issuesNegative.some((i) => i.path.includes("long")));
});

test("Pi 1.1.0 validation: rejects invalid samplingParamsByThinkingLevel", () => {
  // invalid thinking level
  const issuesBadLevel = validateModelsCandidate(validModel({
    samplingParamsByThinkingLevel: { ultra: { temperature: 0.5 } },
  }));
  assert.ok(issuesBadLevel.some((i) => i.path.includes("ultra") && i.message.includes("valid thinking level")));

  // non-object params
  const issuesArray = validateModelsCandidate(validModel({
    samplingParamsByThinkingLevel: { high: [1, 2, 3] },
  }));
  assert.ok(issuesArray.some((i) => i.path.includes("high") && i.message.includes("must be an object")));
});

test("Pi 1.1.0 validation: enforces thinkingTokenBudgetField enum and supportsThinkingTokenBudget boolean", () => {
  // 3 valid enum values pass
  for (const field of ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"]) {
    const issues = validateModelsCandidate(validModel({
      compat: { thinkingTokenBudgetField: field, supportsThinkingTokenBudget: true },
    }));
    assert.deepEqual(issues, []);
  }

  // arbitrary string (e.g. max_tokens) is rejected
  const issuesArbitrary = validateModelsCandidate(validModel({
    compat: { thinkingTokenBudgetField: "max_tokens" },
  }));
  assert.ok(issuesArbitrary.some((i) => i.path.includes("thinkingTokenBudgetField") && i.message.includes("thinking_token_budget")));

  // non-boolean supportsThinkingTokenBudget is rejected
  const issuesNonBool = validateModelsCandidate(validModel({
    compat: { supportsThinkingTokenBudget: "true" },
  }));
  assert.ok(issuesNonBool.some((i) => i.path.includes("supportsThinkingTokenBudget") && i.message.includes("boolean")));
});

test("Pi 1.1.0 validation: allowedFallbackModels hardening constraints", () => {
  const rates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
  // Valid <= 3 items
  const validFallback = validateModelsCandidate(validModel({
    compat: {
      allowedFallbackModels: [
        { provider: "anthropic", model: "claude-3-5-haiku", cost: rates },
        { provider: "anthropic", model: "claude-3-opus", cost: rates },
      ],
    },
  }));
  assert.deepEqual(validFallback, []);

  // Over 3 items rejected by plugin hardening
  const issuesOverLimit = validateModelsCandidate(validModel({
    compat: {
      allowedFallbackModels: [
        { provider: "p", model: "m1", cost: rates },
        { provider: "p", model: "m2", cost: rates },
        { provider: "p", model: "m3", cost: rates },
        { provider: "p", model: "m4", cost: rates },
      ],
    },
  }));
  assert.ok(issuesOverLimit.some((i) => i.path.includes("allowedFallbackModels") && i.message.includes("at most 3")));

  // Malformed entry rejected
  const issuesMissingModel = validateModelsCandidate(validModel({
    compat: {
      allowedFallbackModels: [{ provider: "p", cost: rates }],
    },
  }));
  assert.ok(issuesMissingModel.some((i) => i.path.includes("model")));
});

test("Pi 1.1.0 validation: auth-only empty provider is accepted", () => {
  const issuesApiKey = validateModelsCandidate({
    providers: {
      openai: { apiKey: "synthetic-secret" },
    },
  });
  assert.deepEqual(issuesApiKey, []);

  const issuesAuthHeader = validateModelsCandidate({
    providers: {
      custom: { authHeader: true },
    },
  });
  assert.deepEqual(issuesAuthHeader, []);
});
