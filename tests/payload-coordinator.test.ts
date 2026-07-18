import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { hashArtifact, readArtifact } from "../atomic-file.ts";
import { getModelsPath } from "../config.ts";
import {
  applyRecovery,
  commitCoordinatedMutation,
  getTransactionJournalPath,
  inspectRecovery,
  resolveRequestPayload,
  type TransactionJournalV1,
} from "../payload-coordinator.ts";
import { getPayloadConfigPath, modelPayloadKey, type PayloadConfig } from "../payload-config.ts";

const model = (id: string) => ({
  id, reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const nativeBefore = { providers: { local: { baseUrl: "http://localhost", api: "openai-completions", models: [model("one")] } } };
const nativeAfter = { providers: { local: { baseUrl: "http://localhost", api: "openai-completions", models: [model("two")] } } };
const payloadBefore: PayloadConfig = { version: 1, extraPayloads: { [modelPayloadKey("local", "one")]: { setting: "before" } } };
const payloadAfter: PayloadConfig = { version: 1, extraPayloads: { [modelPayloadKey("local", "two")]: { setting: "after" } } };

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeState(agentDir: string, native: unknown, payload: unknown): void {
  fs.writeFileSync(path.join(agentDir, "models.json"), bytes(native));
  fs.writeFileSync(path.join(agentDir, "model-config-payloads.json"), bytes(payload), { mode: 0o600 });
}

function journal(_agentDir: string): TransactionJournalV1 {
  const beforeNative = bytes(nativeBefore);
  const afterNative = bytes(nativeAfter);
  const beforePayloadBytes = bytes(payloadBefore);
  const afterPayloadBytes = bytes(payloadAfter);
  return {
    version: 1,
    operationId: "operation-id",
    nativeBeforeHash: hashArtifact(beforeNative),
    nativeAfterHash: hashArtifact(afterNative),
    payloadBeforeHash: hashArtifact(beforePayloadBytes),
    payloadAfterHash: hashArtifact(afterPayloadBytes),
    beforePayload: payloadBefore,
    afterPayload: payloadAfter,
  };
}

function writeJournal(agentDir: string): void {
  fs.writeFileSync(getTransactionJournalPath(agentDir), bytes(journal(agentDir)), { mode: 0o600 });
}

async function withAgentDir(run: (agentDir: string) => Promise<void> | void): Promise<void> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-coordinator-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

test("resolves no-journal, journal-before, and journal-after payload views", async () => withAgentDir((agentDir) => {
  writeState(agentDir, nativeBefore, payloadBefore);
  assert.deepEqual(resolveRequestPayload("local", "one"), { setting: "before" });

  writeJournal(agentDir);
  assert.deepEqual(resolveRequestPayload("local", "one"), { setting: "before" });

  writeState(agentDir, nativeAfter, payloadBefore);
  assert.deepEqual(resolveRequestPayload("local", "two"), { setting: "after" });
}));

test("request resolution fails closed on unstable, malformed, and mismatched artifacts", async () => withAgentDir((agentDir) => {
  writeState(agentDir, nativeBefore, payloadBefore);
  let reads = 0;
  assert.equal(resolveRequestPayload("local", "one", {
    agentDir,
    readArtifact(filePath) {
      reads += 1;
      if (reads === 4 || reads === 16) fs.writeFileSync(getPayloadConfigPath(agentDir), bytes(payloadAfter));
      if (reads === 10) fs.writeFileSync(getPayloadConfigPath(agentDir), bytes(payloadBefore));
      return readArtifact(filePath);
    },
  }), undefined);

  fs.writeFileSync(getTransactionJournalPath(agentDir), "{");
  assert.equal(resolveRequestPayload("local", "one"), undefined);
  fs.writeFileSync(getTransactionJournalPath(agentDir), bytes(journal(agentDir)));
  fs.writeFileSync(getModelsPath(), bytes({ providers: { external: { baseUrl: "http://localhost", api: "openai-completions", models: [] } } }));
  assert.equal(resolveRequestPayload("local", "one"), undefined);
}));

test("commit journals both-changing mutations in native/payload order", async () => withAgentDir(async (agentDir) => {
  writeState(agentDir, nativeBefore, payloadBefore);
  const boundaries: string[] = [];
  const result = await commitCoordinatedMutation({
    build: () => ({ native: nativeAfter, payload: payloadAfter, affectedIdentities: [["local", "two"]] }),
    onBoundary(boundary) { boundaries.push(boundary); },
  });
  assert.deepEqual(result, { type: "committed" });
  assert.deepEqual(boundaries, ["journal", "native", "payload", "journal-removed"]);
  assert.equal(fs.existsSync(getTransactionJournalPath(agentDir)), false);
  assert.deepEqual(resolveRequestPayload("local", "two"), { setting: "after" });
}));

test("automatic recovery restores journal-selected complete payloads without native overwrite", async () => withAgentDir(async (agentDir) => {
  writeState(agentDir, nativeBefore, "{");
  const nativeBytes = fs.readFileSync(getModelsPath());
  writeJournal(agentDir);
  const result = await inspectRecovery();
  assert.equal(result.type, "automatic-recovered");
  assert.deepEqual(fs.readFileSync(getModelsPath()), nativeBytes);
  assert.deepEqual(resolveRequestPayload("local", "one"), { setting: "before" });
  assert.equal(fs.existsSync(getTransactionJournalPath(agentDir)), false);
  assert.equal(fs.readdirSync(agentDir).some((entry) => entry.startsWith("model-config-payloads.json.corrupt-")), true);

  writeState(agentDir, nativeAfter, payloadBefore);
  writeJournal(agentDir);
  assert.equal((await inspectRecovery()).type, "automatic-recovered");
  assert.deepEqual(resolveRequestPayload("local", "two"), { setting: "after" });
}));

test("recovery previews and revalidates valid mismatches and malformed storage", async () => withAgentDir(async (agentDir) => {
  writeState(agentDir, { providers: { external: { baseUrl: "http://localhost", api: "openai-completions", models: [] } } }, payloadBefore);
  writeJournal(agentDir);
  const mismatch = await inspectRecovery();
  assert.equal(mismatch.type, "needs-choice");
  if (mismatch.type !== "needs-choice") throw new Error("missing recovery preview");
  assert.deepEqual(mismatch.choices, ["restore-before-payload", "restore-after-payload"]);
  const externalNativeBytes = fs.readFileSync(getModelsPath());
  fs.writeFileSync(getPayloadConfigPath(), bytes(payloadAfter));
  assert.deepEqual(await applyRecovery(mismatch.snapshotToken, "restore-before-payload"), { type: "refresh" });
  assert.deepEqual(fs.readFileSync(getModelsPath()), externalNativeBytes);

  fs.writeFileSync(getTransactionJournalPath(agentDir), "{");
  const malformedJournal = await inspectRecovery();
  assert.equal(malformedJournal.type, "needs-choice");
  if (malformedJournal.type !== "needs-choice") throw new Error("missing recovery preview");
  assert.deepEqual(malformedJournal.choices, ["accept-current"]);
  assert.deepEqual(await applyRecovery(malformedJournal.snapshotToken, "accept-current"), { type: "recovered" });

  fs.writeFileSync(getPayloadConfigPath(), "{");
  const malformedPayload = await inspectRecovery();
  assert.equal(malformedPayload.type, "needs-choice");
  if (malformedPayload.type !== "needs-choice") throw new Error("missing recovery preview");
  assert.deepEqual(malformedPayload.choices, ["quarantine-and-empty"]);
  assert.deepEqual(await applyRecovery(malformedPayload.snapshotToken, "quarantine-and-empty"), { type: "recovered" });

  fs.writeFileSync(getModelsPath(), "{");
  const blocked = await inspectRecovery();
  assert.equal(blocked.type, "blocked");
}));

test("resolves current, built-in, and dynamic identities without registry access", async () => withAgentDir((agentDir) => {
  const payload: PayloadConfig = {
    version: 1,
    extraPayloads: {
      [modelPayloadKey("builtin", "one")]: { setting: "builtin" },
      [modelPayloadKey("dynamic", "two")]: { setting: "dynamic" },
    },
  };
  writeState(agentDir, nativeBefore, payload);
  assert.deepEqual(resolveRequestPayload("builtin", "one"), { setting: "builtin" });
  assert.deepEqual(resolveRequestPayload("dynamic", "two"), { setting: "dynamic" });
}));

test("crashed owners release the OS endpoint after journal/native/payload boundaries", async (t) => {
  for (const boundary of ["journal", "native", "payload"] as const) {
    await t.test(boundary, async () => withAgentDir(async (agentDir) => {
      writeState(agentDir, nativeBefore, payloadBefore);
      const fixture = path.resolve("tests/fixtures/coordinator-worker.ts");
      const child = spawn(process.execPath, ["--experimental-strip-types", fixture, boundary, agentDir], { stdio: "ignore" });
      await new Promise<void>((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))));
      const result = await inspectRecovery({ agentDir });
      assert.ok(result.type === "automatic-recovered" || result.type === "clean");
    }));
  }
});
