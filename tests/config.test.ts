import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelsConfigError, readModelsConfig, writeModelsConfig } from "../config.ts";

function withAgentDir(run: (agentDir: string) => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-jsonc-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

test("reads Pi models.json JSONC and preserves unknown root fields", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, `// Pi accepts comments\n{\n  "feature": true,\n  "providers": {\n    "local": { "models": [], },\n  },\n}\n`);

  assert.deepEqual(readModelsConfig(), {
    feature: true,
    providers: { local: { models: [] } },
  });
}));

test("writes canonical JSON while retaining parsed root and provider fields", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, `{ "rootSetting": "keep", "providers": { "local": { "headers": { "X-Test": "yes" }, "models": [] } } }`);
  const config = readModelsConfig();
  config.providers.local!.name = "Local";
  writeModelsConfig(config);

  const written = fs.readFileSync(filePath, "utf8");
  assert.deepEqual(JSON.parse(written), {
    rootSetting: "keep",
    providers: { local: { headers: { "X-Test": "yes" }, models: [], name: "Local" } },
  });
}));

test("refuses to overwrite malformed models.json", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  const malformed = `{ "providers": {`;
  fs.writeFileSync(filePath, malformed);

  assert.throws(() => readModelsConfig(), ModelsConfigError);
  assert.throws(() => writeModelsConfig({ providers: {} }), ModelsConfigError);
  assert.equal(fs.readFileSync(filePath, "utf8"), malformed);
}));

test("returns an empty provider map only when models.json is absent", () => withAgentDir(() => {
  assert.deepEqual(readModelsConfig(), { providers: {} });
}));
