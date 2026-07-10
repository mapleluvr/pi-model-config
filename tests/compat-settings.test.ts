import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPAT_BOOLEAN_FIELDS,
  COMPAT_JSON_OBJECT_FIELDS,
  THINKING_FORMATS,
  applyCompatBooleanChoice,
  applyCompatObjectChoice,
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

test("declares every Pi 0.80.6 boolean, object, and thinking-format option", () => {
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "requiresAssistantAfterToolResult"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "requiresReasoningContentOnAssistantMessages"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "sendSessionAffinityHeaders"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "zaiToolStream"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "sendSessionIdHeader"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "supportsCacheControlOnTools"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "supportsTemperature"));
  assert.deepEqual(COMPAT_JSON_OBJECT_FIELDS.map((field) => field.key), ["chatTemplateKwargs", "openRouterRouting", "vercelGatewayRouting"]);
  assert.ok(THINKING_FORMATS.includes("zai"));
  assert.ok(THINKING_FORMATS.includes("chat-template"));
  assert.ok(THINKING_FORMATS.includes("string-thinking"));
  assert.ok(THINKING_FORMATS.includes("ant-ling"));
});

test("sets, replaces, and clears compat object fields", () => {
  assert.deepEqual(applyCompatObjectChoice({}, "openRouterRouting", { only: ["bedrock"] }), { openRouterRouting: { only: ["bedrock"] } });
  assert.deepEqual(applyCompatObjectChoice({ openRouterRouting: { only: ["bedrock"] } }, "openRouterRouting", undefined), {});
});
