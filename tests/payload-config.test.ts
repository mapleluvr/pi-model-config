import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  copyModelPayload, copyProviderPayloads, getModelPayload, mergePayloadIntoRequest,
  modelPayloadKey, moveModelPayload, moveProviderPayloads, readPayloadConfig,
  removeModelPayload, removeProviderPayloads, setModelPayload,
} from "../payload-config.ts";

function withAgentDir(run: (agentDir: string) => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-payload-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

test("stores payloads by exact provider/model identity without cross-model leakage", () => withAgentDir(() => {
  setModelPayload("local", "model-a", { temperature: 0.2 });
  setModelPayload("local", "model-b", { top_p: 0.9 });
  assert.deepEqual(getModelPayload("local", "model-a"), { temperature: 0.2 });
  assert.deepEqual(getModelPayload("local", "model-b"), { top_p: 0.9 });
  assert.equal(getModelPayload("other", "model-a"), undefined);
  assert.equal(modelPayloadKey("local", "model-a"), '["local","model-a"]');
}));

test("keeps slash-containing provider and model identities unambiguous during cleanup", () => withAgentDir(() => {
  setModelPayload("alpha", "beta/model", { owner: "alpha" });
  setModelPayload("alpha/beta", "model", { owner: "alpha/beta" });

  assert.notEqual(modelPayloadKey("alpha", "beta/model"), modelPayloadKey("alpha/beta", "model"));
  assert.deepEqual(getModelPayload("alpha", "beta/model"), { owner: "alpha" });
  assert.deepEqual(getModelPayload("alpha/beta", "model"), { owner: "alpha/beta" });

  removeProviderPayloads("alpha");
  assert.equal(getModelPayload("alpha", "beta/model"), undefined);
  assert.deepEqual(getModelPayload("alpha/beta", "model"), { owner: "alpha/beta" });
}));

test("keeps ambiguous legacy delimiter keys inert for slash-containing identities", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "model-config-payloads.json");
  const ambiguousKey = "alpha/beta/model";
  const original = {
    version: 1,
    extraPayloads: { [ambiguousKey]: { legacy: true } },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(original, null, 2)}\n`);

  assert.equal(getModelPayload("alpha", "beta/model"), undefined);
  assert.equal(getModelPayload("alpha/beta", "model"), undefined);
  copyModelPayload("alpha", "beta/model", "target", "copy");
  moveModelPayload("alpha/beta", "model", "target", "moved");
  copyProviderPayloads("alpha", "target", ["beta/model"]);
  moveProviderPayloads("alpha/beta", "target", ["model"]);
  removeModelPayload("alpha", "beta/model");
  removeProviderPayloads("alpha");

  assert.equal(getModelPayload("target", "copy"), undefined);
  assert.equal(getModelPayload("target", "moved"), undefined);
  assert.deepEqual(readPayloadConfig().extraPayloads, original.extraPayloads);
}));

test("reads and migrates only unambiguous legacy delimiter keys", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "model-config-payloads.json");
  fs.writeFileSync(filePath, `${JSON.stringify({
    version: 1,
    extraPayloads: { "alpha/model": { legacy: true } },
  }, null, 2)}\n`);

  assert.deepEqual(getModelPayload("alpha", "model"), { legacy: true });
  moveModelPayload("alpha", "model", "target", "model");
  assert.equal(getModelPayload("alpha", "model"), undefined);
  assert.deepEqual(getModelPayload("target", "model"), { legacy: true });
  assert.equal(Object.hasOwn(readPayloadConfig().extraPayloads, "alpha/model"), false);
}));

test("moves and removes payload identities", () => withAgentDir(() => {
  setModelPayload("local", "old", { seed: 7 });
  moveModelPayload("local", "old", "local", "new");
  assert.equal(getModelPayload("local", "old"), undefined);
  assert.deepEqual(getModelPayload("local", "new"), { seed: 7 });
  removeModelPayload("local", "new");
  assert.equal(getModelPayload("local", "new"), undefined);
  setModelPayload("local", "one", { a: 1 });
  setModelPayload("local", "two", { b: 2 });
  setModelPayload("other", "one", { c: 3 });
  removeProviderPayloads("local");
  assert.deepEqual(readPayloadConfig().extraPayloads, { [modelPayloadKey("other", "one")]: { c: 3 } });
}));

test("does not migrate a payload until the caller has committed the native identity", () => withAgentDir(() => {
  setModelPayload("local", "old", { seed: 7 });
  assert.deepEqual(getModelPayload("local", "old"), { seed: 7 });
  assert.equal(getModelPayload("local", "new"), undefined);
  moveModelPayload("local", "old", "local", "new");
  assert.equal(getModelPayload("local", "old"), undefined);
  assert.deepEqual(getModelPayload("local", "new"), { seed: 7 });
}));

test("copies model and provider payloads without removing their source identities", () => withAgentDir(() => {
  setModelPayload("source/provider", "model/one", { seed: 7 });
  setModelPayload("source/provider", "model/two", { temperature: 0.2 });

  copyModelPayload("source/provider", "model/one", "source/provider", "model/one-copy");
  copyProviderPayloads("source/provider", "target/provider", ["model/one", "model/two"]);

  assert.deepEqual(getModelPayload("source/provider", "model/one"), { seed: 7 });
  assert.deepEqual(getModelPayload("source/provider", "model/one-copy"), { seed: 7 });
  assert.deepEqual(getModelPayload("target/provider", "model/one"), { seed: 7 });
  assert.deepEqual(getModelPayload("target/provider", "model/two"), { temperature: 0.2 });
}));

test("moves all named provider payloads in one lifecycle operation", () => withAgentDir(() => {
  setModelPayload("source/provider", "model/one", { seed: 7 });
  setModelPayload("source/provider", "model/two", { temperature: 0.2 });

  moveProviderPayloads("source/provider", "target/provider", ["model/one", "model/two"]);

  assert.equal(getModelPayload("source/provider", "model/one"), undefined);
  assert.equal(getModelPayload("source/provider", "model/two"), undefined);
  assert.deepEqual(getModelPayload("target/provider", "model/one"), { seed: 7 });
  assert.deepEqual(getModelPayload("target/provider", "model/two"), { temperature: 0.2 });
}));

test("fails closed for malformed private payload configuration without overwriting it", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "model-config-payloads.json");
  fs.writeFileSync(filePath, "{ broken");
  assert.deepEqual(readPayloadConfig(), { version: 1, extraPayloads: {} });
  assert.equal(getModelPayload("local", "model"), undefined);
  assert.throws(() => setModelPayload("local", "model", { temperature: 0.2 }));
  assert.equal(fs.readFileSync(filePath, "utf8"), "{ broken");
}));

test("injects shallow payload values without mutating stored or event objects", () => {
  const eventPayload = { model: "model", nested: { keep: true } };
  const configuredPayload = { temperature: 0.2, nested: { replace: true } };
  const result = mergePayloadIntoRequest(eventPayload, configuredPayload);
  assert.deepEqual(result, { model: "model", temperature: 0.2, nested: { replace: true } });
  assert.deepEqual(eventPayload, { model: "model", nested: { keep: true } });
  assert.deepEqual(configuredPayload, { temperature: 0.2, nested: { replace: true } });
});
