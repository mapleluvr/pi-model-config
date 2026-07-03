import test from "node:test";
import assert from "node:assert/strict";

import {
  buildToolSelectionOptions,
  normalizeToolList,
} from "../tool-options.ts";

test("builds tool options in active parent-tool order with descriptions", () => {
  const options = buildToolSelectionOptions(
    ["read", "bash", "read", "subagent"],
    [
      { name: "bash", description: "Execute shell commands", sourceInfo: { type: "builtin" } },
      { name: "read", description: "Read files", sourceInfo: { type: "builtin" } },
      { name: "write", description: "Write files", sourceInfo: { type: "builtin" } },
      { name: "subagent", description: "Run subagents", sourceInfo: { type: "extension", packageName: "pi-subagents" } },
    ],
  );

  assert.deepEqual(options.map((option) => option.value), ["read", "bash", "subagent"]);
  assert.equal(options[0]?.label, "read");
  assert.equal(options[0]?.description, "Read files");
  assert.match(options[0]?.searchText ?? "", /read/);
  assert.match(options[1]?.searchText ?? "", /Execute shell commands/);
  assert.equal(options[2]?.warning, "Allows nested subagent fanout");
});

test("falls back to tool name when all-tools metadata is missing", () => {
  const options = buildToolSelectionOptions(["custom_tool"], []);

  assert.deepEqual(options, [{
    value: "custom_tool",
    label: "custom_tool",
    description: undefined,
    searchText: "custom_tool",
    warning: undefined,
  }]);
});

test("normalizes manual tool list from commas, whitespace, and newlines", () => {
  assert.deepEqual(
    normalizeToolList(" read, bash\nedit  write\n\nread "),
    ["read", "bash", "edit", "write"],
  );
});

test("preserves mcp direct tools and path-like extension tools", () => {
  assert.deepEqual(
    normalizeToolList("mcp:github/search ./tools/custom.ts C:/tools/win.js"),
    ["mcp:github/search", "./tools/custom.ts", "C:/tools/win.js"],
  );
});
