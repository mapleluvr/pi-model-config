import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const BANNED_EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectTypeScriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(fullPath);
  }
  return files;
}

function scannedPaths(): string[] {
  const runtime = fs.readdirSync(PROJECT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(PROJECT_ROOT, entry.name));
  return [
    ...runtime,
    ...collectTypeScriptFiles(path.join(PROJECT_ROOT, "tests")),
    path.join(PROJECT_ROOT, "README.md"),
    path.join(PROJECT_ROOT, "README-CN.md"),
  ].sort();
}

test("all runtime TypeScript, test TypeScript, and bilingual docs contain no emoji", () => {
  const matches: string[] = [];

  for (const fullPath of scannedPaths()) {
    const relativePath = path.relative(PROJECT_ROOT, fullPath).replaceAll(path.sep, "/");
    const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (BANNED_EMOJI_PATTERN.test(line)) {
        matches.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(matches, []);
});
