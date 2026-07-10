import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const BANNED_EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
const SCANNED_PATHS = [
  "README.md",
  "README-CN.md",
  "compat-settings.ts",
  "index.ts",
  "searchable-multi-select.ts",
  "searchable-select.ts",
  "subagent-settings.ts",
  "subagent-ui.ts",
  "tool-options.ts",
  "tests/compat-settings.test.ts",
  "tests/no-emoji.test.ts",
  "tests/release-docs.test.ts",
  "tests/searchable-multi-select.test.ts",
  "tests/searchable-select.test.ts",
  "tests/subagent-settings.test.ts",
  "tests/subagent-ui.test.ts",
  "tests/tool-options.test.ts",
];

test("plugin source and tests do not contain emoji UI markers", () => {
  const matches: string[] = [];

  for (const relativePath of SCANNED_PATHS) {
    const fullPath = path.join(PROJECT_ROOT, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const lines = fs.readFileSync(fullPath, "utf-8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (BANNED_EMOJI_PATTERN.test(line)) {
        matches.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(matches, []);
});
