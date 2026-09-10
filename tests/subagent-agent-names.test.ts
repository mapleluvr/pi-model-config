import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_SUBAGENT_NAMES,
  EXTERNAL_CLI_SUBAGENT_NAMES,
  isExternalCliSubagent,
  listSubagentAgentNames,
} from "../subagent-settings.ts";

// pi-subagents 0.63.0 ships these builtins (src/agents/builtin-names.ts); the plugin
// used to hardcode context-builder/planner, which no longer exist.
test("builtin agent names match the installed pi-subagents surface", () => {
  assert.deepEqual([...BUILTIN_SUBAGENT_NAMES], [
    "advisor",
    "claude-code",
    "claude-code-writer",
    "codex-exec",
    "codex-exec-writer",
    "cursor-agent",
    "cursor-agent-writer",
    "delegate",
    "oracle",
    "researcher",
    "reviewer",
    "scout",
    "worker",
  ]);
  assert.equal((BUILTIN_SUBAGENT_NAMES as readonly string[]).includes("context-builder"), false);
  assert.equal((BUILTIN_SUBAGENT_NAMES as readonly string[]).includes("planner"), false);
});

test("agent list keeps stored overrides reachable next to the builtins", () => {
  const names = listSubagentAgentNames({ planner: { model: "provider/one" }, reviewer: {} });
  assert.deepEqual(names.slice(0, BUILTIN_SUBAGENT_NAMES.length), [...BUILTIN_SUBAGENT_NAMES]);
  assert.ok(names.includes("planner"), "a stored non-builtin override must stay listed");
  assert.equal(names.filter((name) => name === "reviewer").length, 1, "stored builtins must not duplicate");
  assert.deepEqual(listSubagentAgentNames({}), [...BUILTIN_SUBAGENT_NAMES]);
});

test("external CLI runners are marked so the editor can drop Pi-native options", () => {
  for (const name of EXTERNAL_CLI_SUBAGENT_NAMES) {
    assert.ok(isExternalCliSubagent(name), `${name} must be treated as an external CLI runner`);
  }
  for (const name of ["advisor", "delegate", "reviewer", "worker", "planner"]) {
    assert.equal(isExternalCliSubagent(name), false, `${name} is a native Pi child agent`);
  }
});
