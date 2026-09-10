import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPAT_BOOLEAN_FIELDS,
  COMPAT_JSON_OBJECT_FIELDS,
  COMPAT_NUMBER_FIELDS,
  COMPAT_STRING_FIELDS,
  COMPAT_THINKING_FORMAT_FIELD,
  THINKING_FORMATS,
  applyCompatBooleanChoice,
  applyCompatObjectChoice,
  applyCompatObjectPatch,
  applyLegacySessionAffinityMigration,
  planLegacySessionAffinityMigration,
} from "../compat-settings.ts";

test("sets compat boolean fields to explicit true, explicit false, or default deletion", () => {
  assert.deepEqual(
    applyCompatBooleanChoice({ keep: "yes" }, "supportsDeveloperRole", "true"),
    { keep: "yes", supportsDeveloperRole: true },
  );

  assert.deepEqual(
    applyCompatBooleanChoice({ keep: "yes", supportsDeveloperRole: true }, "supportsDeveloperRole", "false"),
    { keep: "yes", supportsDeveloperRole: false },
  );

  assert.deepEqual(
    applyCompatBooleanChoice({ keep: "yes", supportsDeveloperRole: false }, "supportsDeveloperRole", "default"),
    { keep: "yes" },
  );
});

test("declares every Pi 0.85.1 boolean, object, string, number, and thinking-format option", () => {
  const booleanKeys: string[] = COMPAT_BOOLEAN_FIELDS.map((field) => field.key);
  for (const key of [
    "requiresAssistantAfterToolResult",
    "requiresReasoningContentOnAssistantMessages",
    "sendSessionAffinityHeaders",
    "zaiToolStream",
    "supportsCacheControlOnTools",
    "supportsTemperature",
    "supportsFinishReason",
    "supportsOpenAIGrammarTools",
    "supportsAdditionalTools",
    "supportsToolSearch",
    "supportsMaxOutputTokens",
    "supportsExplicitPromptCacheMode",
    "supportsStrictTools",
    "supportsMidConvoEffort",
    "supportsToolReferences",
  ]) {
    assert.ok(booleanKeys.includes(key), `${key} must be offered`);
  }
  // Pi 0.80.7 removed sendSessionIdHeader; only the previewed migration may touch it.
  assert.equal(booleanKeys.includes("sendSessionIdHeader"), false);
  assert.deepEqual(
    COMPAT_JSON_OBJECT_FIELDS.map((field) => field.key),
    ["chatTemplateKwargs", "chatTemplateArgs", "openRouterRouting", "vercelGatewayRouting"],
  );
  assert.deepEqual(
    COMPAT_STRING_FIELDS.map((field) => field.key),
    ["maxTokensField", "cacheControlFormat", "deferredToolsMode", "sessionAffinityFormat"],
  );
  // Engine-read but schema-undeclared, so the literal list is pinned here rather than derived.
  assert.deepEqual(COMPAT_THINKING_FORMAT_FIELD.values, [
    "openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen",
    "chat-template", "qwen-chat-template", "string-thinking", "ant-ling",
  ]);
  assert.deepEqual(COMPAT_NUMBER_FIELDS.map((field) => field.key), ["vllmPriority"]);
  for (const format of ["zai", "chat-template", "string-thinking", "ant-ling", "baseten"]) {
    assert.ok(THINKING_FORMATS.includes(format as (typeof THINKING_FORMATS)[number]), `${format} must be offered`);
  }
});

test("plans the removed sendSessionIdHeader migration per API family", () => {
  assert.equal(planLegacySessionAffinityMigration({}, "openai-responses"), undefined);

  const deleted = planLegacySessionAffinityMigration({ sendSessionIdHeader: true }, "openai-responses");
  assert.ok(deleted, "a stored true value must be migratable");
  assert.equal(deleted.setSessionAffinityFormat, undefined);
  assert.deepEqual(applyLegacySessionAffinityMigration({ sendSessionIdHeader: true, keep: 1 }, deleted), { keep: 1 });

  const mapped = planLegacySessionAffinityMigration({ sendSessionIdHeader: false }, "openai-completions");
  assert.ok(mapped, "a stored false value must be migratable");
  assert.equal(mapped.setSessionAffinityFormat, "openai-nosession");
  assert.deepEqual(
    applyLegacySessionAffinityMigration({ sendSessionIdHeader: false }, mapped),
    { sessionAffinityFormat: "openai-nosession" },
  );

  const anthropic = planLegacySessionAffinityMigration({ sendSessionIdHeader: false }, "anthropic-messages");
  assert.ok(anthropic, "a stored false value must stay removable on other APIs");
  assert.equal(anthropic.setSessionAffinityFormat, undefined);
});

test("sets, replaces, and clears compat object fields", () => {
  assert.deepEqual(applyCompatObjectChoice({}, "openRouterRouting", { only: ["bedrock"] }), { openRouterRouting: { only: ["bedrock"] } });
  assert.deepEqual(applyCompatObjectChoice({ openRouterRouting: { only: ["bedrock"] } }, "openRouterRouting", undefined), {});
});

test("patches known compat objects while retaining future nested fields", () => {
  const existing = {
    openRouterRouting: {
      only: ["old"],
      future: { retained: true, nested: { value: 1 } },
    },
    futureRoot: true,
  };
  assert.deepEqual(applyCompatObjectPatch(existing, "openRouterRouting", { only: ["new"] }), {
    openRouterRouting: {
      only: ["new"],
      future: { retained: true, nested: { value: 1 } },
    },
    futureRoot: true,
  });
  assert.deepEqual(existing.openRouterRouting.only, ["old"]);
});
