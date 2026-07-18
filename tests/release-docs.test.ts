import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const RUNTIME_MODULES = fs.readdirSync(PROJECT_ROOT)
  .filter((entry) => entry.endsWith(".ts") && fs.statSync(path.join(PROJECT_ROOT, entry)).isFile())
  .sort();

for (const file of ["README.md", "README-CN.md"]) {
  test(`${file} documents the complete 1.2 editor and recovery behavior`, () => {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, file), "utf8");
    assert.match(content, /1\.2\.0/);
    assert.match(content, /JSONC/);
    assert.match(content, /model-config-payloads\.json/);
    assert.match(content, /\[provider, model-id\]/);
    assert.match(content, /88/);
    assert.match(content, /two-pane|双栏/i);
    assert.match(content, /narrow|窄/i);
    assert.match(content, /simple fields|简单字段/i);
    assert.match(content, /draft|草稿/i);
    assert.match(content, /Provider ID/);
    assert.match(content, /Model ID/);
    assert.match(content, /thinkingLevelMap/);
    assert.match(content, /cost\.tiers/);
    assert.match(content, /Merge/);
    assert.match(content, /Replace/);
    assert.match(content, /Cancel/);
    assert.match(content, /IPC/);
    assert.match(content, /model-config-transaction\.json/);
    assert.match(content, /journal|事务日志/i);
    assert.match(content, /API key|API 密钥/i);
    assert.match(content, /Subagent/);
    assert.doesNotMatch(content, /Register configured providers at Pi startup|启动时从 `models\.json` 注册/);
  });
}

test("release metadata, runtime checks, package allowlist, and license are exact", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package-lock.json"), "utf8"));
  assert.equal(packageJson.version, "1.2.0");
  assert.equal(packageLock.version, "1.2.0");
  assert.equal(packageLock.packages[""].version, "1.2.0");
  assert.deepEqual(packageJson.files, ["*.ts", "README.md", "README-CN.md", "LICENSE"]);

  for (const module of RUNTIME_MODULES) {
    assert.match(packageJson.scripts.check, new RegExp(`(?:^|\\s)${module.replace(".", "\\.")}(?:\\s|$)`), `${module} is not syntax checked`);
  }
  const checkedModules = [...packageJson.scripts.check.matchAll(/--check\s+([^\s&]+\.ts)/g)].map((match) => match[1]).sort();
  assert.deepEqual(checkedModules, RUNTIME_MODULES);

  const license = fs.readFileSync(path.join(PROJECT_ROOT, "LICENSE"), "utf8");
  assert.match(license, /^MIT License\n/);
  assert.match(license, new RegExp(`Copyright \\(c\\) 2026 ${packageJson.author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test("manual agent fixture captures and verifies exact deterministic editor and malformed-journal bytes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-config-manual-fixture-"));
  const agentDir = path.join(tempDir, "agent");
  const manifestPath = path.join(tempDir, "manifest.json");
  const fixturePath = path.join(PROJECT_ROOT, "tests", "fixtures", "manual-agent-state.ts");
  try {
    for (const scenario of ["editor", "malformed-journal-valid-files"]) {
      execFileSync(process.execPath, [
        "--experimental-strip-types",
        fixturePath,
        "--agent-dir", agentDir,
        "--scenario", scenario,
        "--base-url", "http://127.0.0.1:43123",
        "--capture-manifest", manifestPath,
      ], { cwd: PROJECT_ROOT, stdio: "pipe" });
      execFileSync(process.execPath, [
        "--experimental-strip-types",
        fixturePath,
        "--agent-dir", agentDir,
        "--assert-manifest", manifestPath,
      ], { cwd: PROJECT_ROOT, stdio: "pipe" });
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      assert.deepEqual(Object.keys(manifest.artifacts).sort(), [
        "model-config-payloads.json",
        "model-config-transaction.json",
        "models.json",
      ]);
      assert.doesNotMatch(JSON.stringify(manifest), /apiKey|secret|payload value/i);
      const journal = manifest.artifacts["model-config-transaction.json"];
      assert.equal(journal.exists, scenario === "malformed-journal-valid-files");
      if (journal.exists) {
        const bytes = Buffer.from("{ malformed journal\n", "utf8");
        assert.equal(journal.byteLength, bytes.byteLength);
        assert.equal(journal.sha256, createHash("sha256").update(bytes).digest("hex"));
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("package assertion parses npm JSON from stdin and rejects forbidden paths", () => {
  const fixturePath = path.join(PROJECT_ROOT, "tests", "fixtures", "assert-package.ts");
  const allowed = [...RUNTIME_MODULES, "LICENSE", "README-CN.md", "README.md", "package.json"]
    .map((packedPath) => ({ path: packedPath }));
  execFileSync(process.execPath, ["--experimental-strip-types", fixturePath], {
    cwd: PROJECT_ROOT,
    input: JSON.stringify([{ files: allowed }]),
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.throws(() => execFileSync(process.execPath, ["--experimental-strip-types", fixturePath], {
    cwd: PROJECT_ROOT,
    input: JSON.stringify([{ files: [...allowed, { path: "tests/private.test.ts" }] }]),
    stdio: ["pipe", "pipe", "pipe"],
  }));
});
