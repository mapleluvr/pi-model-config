import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  copyPayloadDocumentValue,
  copyProviderPayloadDocumentValues,
  emptyPayloadDocument,
  listProviderPayloadIdentities,
  lookupModelPayload,
  mergePayloadIntoRequest,
  modelPayloadKey,
  movePayloadDocumentValue,
  moveProviderPayloadDocumentValues,
  parsePayloadDocument,
  readPayloadConfig,
  removePayloadDocumentValue,
  removeProviderPayloadDocumentValues,
  serializePayloadDocument,
  setPayloadDocumentValue,
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

test("stores payloads by exact provider/model identity without cross-model leakage", () => {
  let config = emptyPayloadDocument();
  config = setPayloadDocumentValue(config, "local", "model-a", { temperature: 0.2 });
  config = setPayloadDocumentValue(config, "local", "model-b", { top_p: 0.9 });
  assert.deepEqual(lookupModelPayload(config, "local", "model-a"), { temperature: 0.2 });
  assert.deepEqual(lookupModelPayload(config, "local", "model-b"), { top_p: 0.9 });
  assert.equal(lookupModelPayload(config, "other", "model-a"), undefined);
  assert.equal(modelPayloadKey("local", "model-a"), '["local","model-a"]');
});

test("keeps slash-containing provider and model identities unambiguous during cleanup", () => {
  let config = setPayloadDocumentValue(emptyPayloadDocument(), "alpha", "beta/model", { owner: "alpha" });
  config = setPayloadDocumentValue(config, "alpha/beta", "model", { owner: "alpha/beta" });

  assert.notEqual(modelPayloadKey("alpha", "beta/model"), modelPayloadKey("alpha/beta", "model"));
  assert.deepEqual(lookupModelPayload(config, "alpha", "beta/model"), { owner: "alpha" });
  assert.deepEqual(lookupModelPayload(config, "alpha/beta", "model"), { owner: "alpha/beta" });

  config = removeProviderPayloadDocumentValues(config, "alpha");
  assert.equal(lookupModelPayload(config, "alpha", "beta/model"), undefined);
  assert.deepEqual(lookupModelPayload(config, "alpha/beta", "model"), { owner: "alpha/beta" });
});

test("keeps ambiguous legacy delimiter keys inert for slash-containing identities", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "model-config-payloads.json");
  const ambiguousKey = "alpha/beta/model";
  const original = {
    version: 1 as const,
    extraPayloads: { [ambiguousKey]: { legacy: true } },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(original, null, 2)}\n`);
  let config = parsePayloadDocument(fs.readFileSync(filePath), filePath);

  assert.equal(lookupModelPayload(config, "alpha", "beta/model"), undefined);
  assert.equal(lookupModelPayload(config, "alpha/beta", "model"), undefined);
  config = copyPayloadDocumentValue(config, "alpha", "beta/model", "target", "copy");
  config = movePayloadDocumentValue(config, "alpha/beta", "model", "target", "moved");
  config = copyProviderPayloadDocumentValues(config, "alpha", "target", ["beta/model"]);
  config = moveProviderPayloadDocumentValues(config, "alpha/beta", "target", ["model"]);
  config = removePayloadDocumentValue(config, "alpha", "beta/model");
  config = removeProviderPayloadDocumentValues(config, "alpha");

  assert.equal(lookupModelPayload(config, "target", "copy"), undefined);
  assert.equal(lookupModelPayload(config, "target", "moved"), undefined);
  assert.deepEqual(config.extraPayloads, original.extraPayloads);
}));

test("reads and migrates only unambiguous legacy delimiter keys", () => {
  let config = parsePayloadDocument(JSON.stringify({
    version: 1,
    extraPayloads: { "alpha/model": { legacy: true } },
  }));

  assert.deepEqual(lookupModelPayload(config, "alpha", "model"), { legacy: true });
  config = movePayloadDocumentValue(config, "alpha", "model", "target", "model");
  assert.equal(lookupModelPayload(config, "alpha", "model"), undefined);
  assert.deepEqual(lookupModelPayload(config, "target", "model"), { legacy: true });
  assert.equal(Object.hasOwn(config.extraPayloads, "alpha/model"), false);
});

test("moves and removes payload identities", () => {
  let config = setPayloadDocumentValue(emptyPayloadDocument(), "local", "old", { seed: 7 });
  config = movePayloadDocumentValue(config, "local", "old", "local", "new");
  assert.equal(lookupModelPayload(config, "local", "old"), undefined);
  assert.deepEqual(lookupModelPayload(config, "local", "new"), { seed: 7 });
  config = removePayloadDocumentValue(config, "local", "new");
  assert.equal(lookupModelPayload(config, "local", "new"), undefined);
  config = setPayloadDocumentValue(config, "local", "one", { a: 1 });
  config = setPayloadDocumentValue(config, "local", "two", { b: 2 });
  config = setPayloadDocumentValue(config, "other", "one", { c: 3 });
  config = removeProviderPayloadDocumentValues(config, "local");
  assert.deepEqual(config.extraPayloads, { [modelPayloadKey("other", "one")]: { c: 3 } });
});

test("does not migrate a payload until the caller has committed the native identity", () => {
  let config = setPayloadDocumentValue(emptyPayloadDocument(), "local", "old", { seed: 7 });
  assert.deepEqual(lookupModelPayload(config, "local", "old"), { seed: 7 });
  assert.equal(lookupModelPayload(config, "local", "new"), undefined);
  config = movePayloadDocumentValue(config, "local", "old", "local", "new");
  assert.equal(lookupModelPayload(config, "local", "old"), undefined);
  assert.deepEqual(lookupModelPayload(config, "local", "new"), { seed: 7 });
});

test("copies model and provider payloads without removing their source identities", () => {
  let config = setPayloadDocumentValue(emptyPayloadDocument(), "source/provider", "model/one", { seed: 7 });
  config = setPayloadDocumentValue(config, "source/provider", "model/two", { temperature: 0.2 });

  config = copyPayloadDocumentValue(config, "source/provider", "model/one", "source/provider", "model/one-copy");
  config = copyProviderPayloadDocumentValues(config, "source/provider", "target/provider", ["model/one", "model/two"]);

  assert.deepEqual(lookupModelPayload(config, "source/provider", "model/one"), { seed: 7 });
  assert.deepEqual(lookupModelPayload(config, "source/provider", "model/one-copy"), { seed: 7 });
  assert.deepEqual(lookupModelPayload(config, "target/provider", "model/one"), { seed: 7 });
  assert.deepEqual(lookupModelPayload(config, "target/provider", "model/two"), { temperature: 0.2 });
});

test("moves all named provider payloads in one lifecycle operation", () => {
  let config = setPayloadDocumentValue(emptyPayloadDocument(), "source/provider", "model/one", { seed: 7 });
  config = setPayloadDocumentValue(config, "source/provider", "model/two", { temperature: 0.2 });

  config = moveProviderPayloadDocumentValues(config, "source/provider", "target/provider", ["model/one", "model/two"]);

  assert.equal(lookupModelPayload(config, "source/provider", "model/one"), undefined);
  assert.equal(lookupModelPayload(config, "source/provider", "model/two"), undefined);
  assert.deepEqual(lookupModelPayload(config, "target/provider", "model/one"), { seed: 7 });
  assert.deepEqual(lookupModelPayload(config, "target/provider", "model/two"), { temperature: 0.2 });
});

test("fails closed for malformed private payload configuration without overwriting it", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "model-config-payloads.json");
  fs.writeFileSync(filePath, "{ broken");
  assert.deepEqual(readPayloadConfig(), { version: 1, extraPayloads: {} });
  assert.throws(() => parsePayloadDocument(fs.readFileSync(filePath), filePath));
  assert.equal(fs.readFileSync(filePath, "utf8"), "{ broken");
}));

test("serializes payload documents without retaining caller aliases", () => {
  const config = setPayloadDocumentValue(emptyPayloadDocument(), "local", "model", { seed: 1 });
  const serialized = serializePayloadDocument(config);
  config.extraPayloads[modelPayloadKey("local", "model")]!.seed = 99;
  assert.deepEqual(JSON.parse(serialized.toString("utf8")).extraPayloads[modelPayloadKey("local", "model")], { seed: 1 });
});

test("injects shallow payload values without mutating stored or event objects", () => {
  const eventPayload = { model: "model", nested: { keep: true } };
  const configuredPayload = { temperature: 0.2, nested: { replace: true } };
  const result = mergePayloadIntoRequest(eventPayload, configuredPayload);
  assert.deepEqual(result, { model: "model", temperature: 0.2, nested: { replace: true } });
  assert.deepEqual(eventPayload, { model: "model", nested: { keep: true } });
  assert.deepEqual(configuredPayload, { temperature: 0.2, nested: { replace: true } });
});

test("enumerates unambiguous empty-model legacy key provider/ and cleans it on provider removal", () => {
  let config = emptyPayloadDocument();
  Object.defineProperty(config.extraPayloads, "local/", {
    value: { empty: true },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(config.extraPayloads, "local/a/b", {
    value: { inert: true },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  assert.deepEqual(listProviderPayloadIdentities(config, "local"), [["local", ""]]);
  assert.deepEqual(lookupModelPayload(config, "local", ""), { empty: true });
  config = removeProviderPayloadDocumentValues(config, "local");
  assert.equal(Object.hasOwn(config.extraPayloads, "local/"), false);
  assert.equal(Object.hasOwn(config.extraPayloads, "local/a/b"), true);
});
