import test from "node:test";
import assert from "node:assert/strict";

import {
  formatSubagentOverrideSummary,
  formatToolsOverride,
  getInitialToolsSelection,
} from "../subagent-ui.ts";

test("formats tools override states", () => {
  assert.equal(formatToolsOverride(undefined), "tools=(agent default)");
  assert.equal(formatToolsOverride(false), "tools=(disabled all)");
  assert.equal(formatToolsOverride(["read", "bash"]), "tools=2 [read, bash]");
});

test("formats subagent summary with model, thinking, and tools", () => {
  assert.equal(
    formatSubagentOverrideSummary("worker", {
      model: "anthropic/claude-sonnet-4",
      thinking: "high",
      tools: ["read", "bash"],
    }),
    "编辑 [worker] model=anthropic/claude-sonnet-4 thinking=high tools=2 [read, bash]",
  );
});

test("formats an explicit model=false override without presenting it as the current default", () => {
  assert.match(
    formatSubagentOverrideSummary("worker", { model: false }),
    /model=\(清除模型固定，继承当前模型\)/,
  );
});
test("formats explicit inherit tools state", () => {
  assert.equal(formatToolsOverride("inherit"), "tools=(inherit Pi defaults)");
});

test("uses explicit tools as initial selection and parent tools for default override", () => {
  assert.deepEqual(getInitialToolsSelection(["read", "bash"], ["read"]), ["read"]);
  assert.deepEqual(getInitialToolsSelection(["read", "bash"], false), []);
  assert.deepEqual(getInitialToolsSelection(["read", "bash"], undefined), ["read", "bash"]);
});
