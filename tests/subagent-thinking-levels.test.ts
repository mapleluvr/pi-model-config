import test from "node:test";
import assert from "node:assert/strict";

import { SUBAGENT_THINKING_LEVELS } from "../subagent-settings.ts";
import { THINKING_LEVELS } from "../types.ts";

// Pi 0.84+ supports the opt-in `max` thinking level above `xhigh`
// (pi-ai ThinkingLevel, pi-agent-core ThinkingLevel, --thinking max,
// thinkingLevelMap keys). The subagent `thinking` menu must offer the
// same level so overrides can target max-effort reasoning.
test("subagent thinking levels include the max reasoning level", () => {
  assert.ok(
    (SUBAGENT_THINKING_LEVELS as readonly string[]).includes("max"),
    `SUBAGENT_THINKING_LEVELS is missing "max": ${SUBAGENT_THINKING_LEVELS.join(", ")}`,
  );
});

test("subagent thinking levels stay aligned with model thinking levels", () => {
  assert.deepEqual(
    [...SUBAGENT_THINKING_LEVELS],
    [...THINKING_LEVELS],
    "subagent thinking menu diverged from THINKING_LEVELS",
  );
});
