import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getModelsPath, ModelsConfigError, parseModelsDocument, readModelsConfig, writeModelsConfig } from "../config.ts";
import { ModelsCandidateValidationError } from "../config-validation.ts";
import { withTempAgentDir as withAgentDir } from "./helpers/temp-agent-dir.ts";

test("reads Pi models.json JSONC and preserves unknown root fields", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, `// Pi accepts comments\n{\n  "feature": true,\n  "providers": {\n    "local": { "headers": { "X-Test": "yes" }, "models": [], },\n  },\n}\n`);

  assert.deepEqual(readModelsConfig(), {
    feature: true,
    providers: { local: { headers: { "X-Test": "yes" }, models: [] } },
  });
}));

test("uses an explicit agent directory for models paths and rejects schema-invalid documents", () => withAgentDir((ambientDir) => {
  const explicitDir = fs.mkdtempSync(path.join(path.dirname(ambientDir), "pi-model-config-explicit-"));
  try {
    assert.equal(getModelsPath(explicitDir), path.join(explicitDir, "models.json"));
    assert.throws(() => parseModelsDocument(path.join(explicitDir, "models.json"), JSON.stringify({ providers: { invalid: null } })), ModelsConfigError);
  } finally {
    fs.rmSync(explicitDir, { recursive: true, force: true });
  }
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

test("retains existing root fields when replacing providers", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, `{ "nativeRoot": true, "providers": { "p": { "headers": { "X-Test": "yes" }, "models": [] } } }`);

  writeModelsConfig({ providers: {} });

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), {
    nativeRoot: true,
    providers: {},
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

test("treats a blank or whitespace-only models.json as malformed and preserves it", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  const blank = " \r\n\t";
  fs.writeFileSync(filePath, blank);

  assert.throws(() => readModelsConfig(), ModelsConfigError);
  assert.throws(() => writeModelsConfig({ providers: {} }), ModelsConfigError);
  assert.equal(fs.readFileSync(filePath, "utf8"), blank);
}));

test("returns an empty provider map only when models.json is absent", () => withAgentDir(() => {
  assert.deepEqual(readModelsConfig(), { providers: {} });
}));

test("rejects a Pi-invalid complete candidate before replacing existing bytes", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  const original = `{ "rootSetting": "keep", "providers": {} }\n`;
  fs.writeFileSync(filePath, original);

  assert.throws(() => writeModelsConfig({
    providers: { custom: { models: [{ id: "model" }] } },
  }), ModelsCandidateValidationError);
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
}));

test("atomically writes a valid candidate while preserving unknown nested fields and native mode", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, JSON.stringify({
    rootPreview: true,
    providers: {
      openai: {
        headers: { "X-Keep": "yes" },
        providerPreview: true,
        models: [{ id: "model", modelPreview: true, compat: { futureCompat: "keep" } }],
      },
    },
  }), { mode: 0o640 });
  const originalMode = fs.statSync(filePath).mode & 0o777;
  const candidate = readModelsConfig();
  candidate.providers.openai!.models![0]!.name = "Updated";

  writeModelsConfig(candidate);

  const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(written.rootPreview, true);
  assert.equal(written.providers.openai.providerPreview, true);
  assert.equal(written.providers.openai.models[0].modelPreview, true);
  assert.equal(written.providers.openai.models[0].compat.futureCompat, "keep");
  assert.equal(written.providers.openai.models[0].name, "Updated");
  assert.equal(fs.statSync(filePath).mode & 0o777, originalMode);
  assert.deepEqual(fs.readdirSync(agentDir).filter((entry) => entry.endsWith(".tmp")), []);
}));
