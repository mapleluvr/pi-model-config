import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getModelPayload, mergePayloadIntoRequest, modelPayloadKey, moveModelPayload,
  readPayloadConfig, removeModelPayload, removeProviderPayloads, setModelPayload,
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
  assert.equal(modelPayloadKey("local", "model-a"), "local/model-a");
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
  assert.deepEqual(readPayloadConfig().extraPayloads, { "other/one": { c: 3 } });
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
