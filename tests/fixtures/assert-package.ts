import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const input = fs.readFileSync(0, "utf8");
const report: unknown = JSON.parse(input);
assert.ok(Array.isArray(report) && report.length === 1, "expected one npm pack report");
const entry = report[0] as { files?: Array<{ path?: unknown }> };
assert.ok(Array.isArray(entry.files), "npm pack report has no files array");

const packedPaths = entry.files.map((file) => {
  assert.equal(typeof file.path, "string", "packed file path must be a string");
  return String(file.path).replaceAll("\\", "/");
}).sort();

const runtimeModules = fs.readdirSync(process.cwd(), { withFileTypes: true })
  .filter((item) => item.isFile() && item.name.endsWith(".ts"))
  .map((item) => item.name);
const expectedPaths = [
  ...runtimeModules,
  "LICENSE",
  "README-CN.md",
  "README.md",
  "package.json",
].sort();
assert.deepEqual(packedPaths, expectedPaths, "package contents differ from the release allowlist");

const forbidden = /(^|\/)(?:tests|\.pi-subagents)(?:\/|$)|(?:^|\/)(?:model-config-transaction\.json|[^/]*journal[^/]*|[^/]*temp-agent[^/]*|[^/]*\.tmp)$|\.tgz$/i;
for (const packedPath of packedPaths) {
  assert.doesNotMatch(packedPath, forbidden, `forbidden package path: ${packedPath}`);
}
