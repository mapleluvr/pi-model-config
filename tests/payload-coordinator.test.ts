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
  fs.chmodSync(getPayloadConfigPath(agentDir), 0o666);
  const nativeBytes = fs.readFileSync(getModelsPath());
  writeJournal(agentDir);
  const result = await inspectRecovery();
  assert.equal(result.type, "automatic-recovered");
  assert.deepEqual(fs.readFileSync(getModelsPath()), nativeBytes);
  assert.deepEqual(resolveRequestPayload("local", "one"), { setting: "before" });
  assert.equal(fs.existsSync(getTransactionJournalPath(agentDir)), false);
  const quarantinedPayload = fs.readdirSync(agentDir).find((entry) => entry.startsWith("model-config-payloads.json.corrupt-"));
  assert.ok(quarantinedPayload);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(agentDir, quarantinedPayload)).mode & 0o777, 0o600);

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
      const expectedNative = boundary === "journal" ? bytes(nativeBefore) : bytes(nativeAfter);
      const expectedPayload = boundary === "journal" ? bytes(payloadBefore) : bytes(payloadAfter);
      assert.deepEqual(fs.readFileSync(getModelsPath(agentDir)), expectedNative);
      const result = await inspectRecovery({ agentDir });
      assert.ok(result.type === "automatic-recovered" || result.type === "clean");
      assert.deepEqual(fs.readFileSync(getModelsPath(agentDir)), expectedNative);
      assert.deepEqual(fs.readFileSync(getPayloadConfigPath(agentDir)), expectedPayload);
    }));
  }
});

test("uses the explicit coordinator directory without touching an ambient agent directory", async () => withAgentDir(async (ambientDir) => {
  const explicitDir = fs.mkdtempSync(path.join(path.dirname(ambientDir), "pi-model-config-explicit-"));
  try {
    writeState(ambientDir, nativeBefore, payloadBefore);
    writeState(explicitDir, nativeBefore, payloadBefore);
    const ambientNative = fs.readFileSync(getModelsPath(ambientDir));
    const result = await commitCoordinatedMutation({
      build: () => ({ native: nativeAfter, payload: payloadAfter, affectedIdentities: [["local", "two"]] }),
    }, { agentDir: explicitDir });
    assert.deepEqual(result, { type: "committed" });
    assert.deepEqual(fs.readFileSync(getModelsPath(ambientDir)), ambientNative);
    assert.deepEqual(resolveRequestPayload("local", "two", { agentDir: explicitDir }), { setting: "after" });
    assert.equal(resolveRequestPayload("local", "two", { agentDir: ambientDir }), undefined);
  } finally {
    fs.rmSync(explicitDir, { recursive: true, force: true });
  }
}));

test("fails closed for schema-invalid native documents in requests and mutation recovery", async () => withAgentDir(async (agentDir) => {
  writeState(agentDir, { providers: { invalid: null } }, payloadBefore);
  let diagnostics = 0;
  assert.equal(resolveRequestPayload("local", "one", { agentDir, onDiagnostic() { diagnostics += 1; } }), undefined);
  assert.equal(diagnostics, 1);
  assert.deepEqual(await inspectRecovery({ agentDir }), { type: "blocked" });
  assert.deepEqual(await commitCoordinatedMutation({
    build: () => ({ native: nativeAfter, payload: payloadAfter, affectedIdentities: [] }),
  }, { agentDir }), { type: "recovery-required" });
}));

test("rejects malformed journal hashes without recovering or deleting the journal", async () => withAgentDir(async (agentDir) => {
  writeState(agentDir, nativeBefore, payloadBefore);
  const invalidJournal = { ...journal(agentDir), nativeBeforeHash: "sha256:not-a-digest" };
  fs.writeFileSync(getTransactionJournalPath(agentDir), bytes(invalidJournal), { mode: 0o600 });
  assert.equal(resolveRequestPayload("local", "one", { agentDir }), undefined);
  fs.chmodSync(getTransactionJournalPath(agentDir), 0o666);
  const recovery = await inspectRecovery({ agentDir });
  assert.equal(recovery.type, "needs-choice");
  if (recovery.type !== "needs-choice") throw new Error("missing recovery preview");
  assert.deepEqual(await applyRecovery(recovery.snapshotToken, "accept-current", { agentDir }), { type: "recovered" });
  const quarantinedJournal = fs.readdirSync(agentDir).find((entry) => entry.startsWith("model-config-transaction.json.corrupt-"));
  assert.ok(quarantinedJournal);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(agentDir, quarantinedJournal)).mode & 0o777, 0o600);
}));

test("request resolution makes exactly three attempts and contains reader failures", () => withAgentDir((agentDir) => {
  writeState(agentDir, nativeBefore, payloadBefore);
  let reads = 0;
  let diagnostics = 0;
  assert.equal(resolveRequestPayload("local", "one", {
    agentDir,
    readArtifact() { reads += 1; throw new Error("reader failure"); },
    onDiagnostic() { diagnostics += 1; },
  }), undefined);
  assert.equal(reads, 3);
  assert.equal(diagnostics, 1);

  let singleReads = 0;
  assert.equal(resolveRequestPayload("local", "one", {
    agentDir,
    readArtifact(filePath) {
      singleReads += 1;
      if (singleReads === 1) throw new Error("reader failure");
      return readArtifact(filePath);
    },
  }), undefined);
  assert.ok(singleReads > 1);
}));

test("recomputes snapshot hashes from bytes before recovery token comparison", async () => withAgentDir(async (agentDir) => {
  writeState(agentDir, { providers: { external: { baseUrl: "http://localhost", api: "openai-completions", models: [] } } }, payloadBefore);
  writeJournal(agentDir);
  const preview = await inspectRecovery({ agentDir });
  assert.equal(preview.type, "needs-choice");
  if (preview.type !== "needs-choice") throw new Error("missing recovery preview");
  const nativePath = getModelsPath(agentDir);
  const before = readArtifact(nativePath);
  const changed = bytes(nativeBefore);
  const result = await applyRecovery(preview.snapshotToken, "restore-before-payload", {
    agentDir,
    readArtifact(filePath) {
      const snapshot = readArtifact(filePath);
      return filePath === nativePath ? { ...snapshot, bytes: changed, hash: before.hash } : snapshot;
    },
  });
  assert.deepEqual(result, { type: "refresh" });
  assert.deepEqual(fs.readFileSync(nativePath), before.bytes);
}));

test("isolates build input and journal before-payload from mutating builders", async () => withAgentDir(async (agentDir) => {
  writeState(agentDir, nativeBefore, payloadBefore);
  await assert.rejects(commitCoordinatedMutation({
    build(snapshot) {
      snapshot.payload.document!.extraPayloads = { [modelPayloadKey("local", "one")]: { setting: "mutated" } };
      return { native: nativeAfter, payload: payloadAfter, affectedIdentities: [["local", "two"]] };
    },
    onBoundary(boundary) { if (boundary === "journal") throw new Error("stop after journal"); },
  }, { agentDir }), /stop after journal/);
  assert.equal((await inspectRecovery({ agentDir })).type, "automatic-recovered");
  assert.deepEqual(resolveRequestPayload("local", "one", { agentDir }), { setting: "before" });
}));

test("does not remove a journal replaced at the final unlink boundary", async () => withAgentDir(async (agentDir) => {
  writeState(agentDir, nativeBefore, payloadBefore);
  await assert.rejects(commitCoordinatedMutation({
    build: () => ({ native: nativeAfter, payload: payloadAfter, affectedIdentities: [["local", "two"]] }),
    onBoundary(boundary) {
      if (boundary === "payload") fs.writeFileSync(getTransactionJournalPath(agentDir), bytes(journal(agentDir)), { mode: 0o600 });
    },
  }, { agentDir }), /changed before removal/);
  assert.equal(fs.existsSync(getTransactionJournalPath(agentDir)), true);
}));
