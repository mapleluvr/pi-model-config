import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicRemove, atomicReplace, hashArtifact, quarantineArtifact, readArtifact, type ArtifactSnapshot } from "./atomic-file.ts";
import { getModelsPath, parseModelsDocument, serializeModelsDocument } from "./config.ts";
import {
  clonePayloadDocument,
  emptyPayloadDocument,
  getPayloadConfigPath,
  lookupModelPayload,
  mergePayloadIntoRequest,
  parsePayloadDocument,
  serializePayloadDocument,
  type PayloadConfig,
} from "./payload-config.ts";
import { tryAcquireMutationLock, type AcquireLockResult, type MutationLockHandle } from "./process-lock.ts";
import type { ModelsConfig } from "./types.ts";

export interface TransactionJournalV1 {
  version: 1;
  operationId: string;
  nativeBeforeHash: string;
  nativeAfterHash: string;
  payloadBeforeHash: string;
  payloadAfterHash: string;
  beforePayload: PayloadConfig;
  afterPayload: PayloadConfig;
}

type ParseState = "missing" | "valid" | "malformed";

interface ParsedArtifact<T> extends ArtifactSnapshot {
  path: string;
  parseState: ParseState;
  document?: T;
}

export interface CoordinatedSnapshot {
  agentDir: string;
  native: ParsedArtifact<ModelsConfig>;
  payload: ParsedArtifact<PayloadConfig>;
  journal: ParsedArtifact<TransactionJournalV1>;
}

export interface PayloadCoordinatorOptions {
  agentDir?: string;
  /** Reader bytes are authoritative; reported hashes are ignored and recomputed locally. */
  readArtifact?: (filePath: string) => ArtifactSnapshot;
  onDiagnostic?: () => void;
}

export interface CoordinatedMutation {
  native: ModelsConfig;
  payload: PayloadConfig;
  affectedIdentities: readonly (readonly [string, string])[];
}

export interface MutationRequest {
  build(snapshot: CoordinatedSnapshot): CoordinatedMutation;
  onBoundary?(boundary: "journal" | "native" | "payload" | "journal-removed"): void;
}

export type CommitResult = { type: "committed" | "unchanged" } | Exclude<AcquireLockResult, { type: "acquired" }> | { type: "recovery-required" };
export type RecoveryChoice = "restore-before-payload" | "restore-after-payload" | "accept-current" | "quarantine-and-empty";
export type RecoveryResult =
  | { type: "clean" | "automatic-recovered" | "blocked" }
  | Exclude<AcquireLockResult, { type: "acquired" }>
  | { type: "needs-choice"; snapshotToken: string; choices: RecoveryChoice[] };
export type ApplyRecoveryResult = { type: "recovered" | "refresh" } | Exclude<AcquireLockResult, { type: "acquired" }> | { type: "blocked" };

function currentAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function getTransactionJournalPath(agentDir = currentAgentDir()): string {
  return path.join(agentDir, "model-config-transaction.json");
}

function genericFailure(options: PayloadCoordinatorOptions): undefined {
  options.onDiagnostic?.();
  return undefined;
}

function normalizedSnapshot(snapshot: ArtifactSnapshot): ArtifactSnapshot {
  if (!snapshot.exists) return { exists: false, hash: hashArtifact(undefined), mode: snapshot.mode };
  if (snapshot.bytes === undefined) throw new Error("artifact reader returned no bytes");
  const bytes = Buffer.from(snapshot.bytes);
  return { exists: true, bytes, hash: hashArtifact(bytes), mode: snapshot.mode };
}

function parsed<T>(snapshot: ArtifactSnapshot, filePath: string, parser: (bytes: Uint8Array) => T, missing: () => T): ParsedArtifact<T> {
  if (!snapshot.exists) return { ...snapshot, path: filePath, parseState: "missing", document: missing() };
  try {
    return { ...snapshot, path: filePath, parseState: "valid", document: parser(snapshot.bytes!) };
  } catch {
    return { ...snapshot, path: filePath, parseState: "malformed" };
  }
}

function readNormalized(read: (filePath: string) => ArtifactSnapshot, filePath: string): ArtifactSnapshot {
  return normalizedSnapshot(read(filePath));
}

function cloneModelsDocument(document: ModelsConfig): ModelsConfig {
  return JSON.parse(JSON.stringify(document)) as ModelsConfig;
}

function cloneParsedArtifact<T>(artifact: ParsedArtifact<T>, clone: (document: T) => T): ParsedArtifact<T> {
  return {
    ...artifact,
    bytes: artifact.bytes === undefined ? undefined : Buffer.from(artifact.bytes),
    document: artifact.document === undefined ? undefined : clone(artifact.document),
  };
}

function cloneSnapshot(snapshot: CoordinatedSnapshot): CoordinatedSnapshot {
  return {
    ...snapshot,
    native: cloneParsedArtifact(snapshot.native, cloneModelsDocument),
    payload: cloneParsedArtifact(snapshot.payload, clonePayloadDocument),
    journal: cloneParsedArtifact(snapshot.journal, (journal) => ({
      ...journal,
      beforePayload: clonePayloadDocument(journal.beforePayload),
      afterPayload: clonePayloadDocument(journal.afterPayload),
    })),
  };
}

function parseJournal(bytes: Uint8Array): TransactionJournalV1 {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("invalid transaction journal");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid transaction journal");
  const record = value as Record<string, unknown>;
  const expected = ["afterPayload", "nativeAfterHash", "nativeBeforeHash", "operationId", "payloadAfterHash", "payloadBeforeHash", "beforePayload", "version"].sort();
  if (Object.keys(record).sort().join(",") !== expected.join(",")) throw new Error("invalid transaction journal");
  if (
    record.version !== 1 || typeof record.operationId !== "string" || !record.operationId ||
    [record.nativeBeforeHash, record.nativeAfterHash, record.payloadBeforeHash, record.payloadAfterHash].some((hash) => typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(hash))
  ) throw new Error("invalid transaction journal");
  return {
    version: 1,
    operationId: record.operationId,
    nativeBeforeHash: record.nativeBeforeHash as string,
    nativeAfterHash: record.nativeAfterHash as string,
    payloadBeforeHash: record.payloadBeforeHash as string,
    payloadAfterHash: record.payloadAfterHash as string,
    beforePayload: parsePayloadDocument(JSON.stringify(record.beforePayload), "transaction journal"),
    afterPayload: parsePayloadDocument(JSON.stringify(record.afterPayload), "transaction journal"),
  };
}

function serializeJournal(journal: TransactionJournalV1): Buffer {
  parseJournal(Buffer.from(JSON.stringify(journal), "utf8"));
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

export function readCoordinatedSnapshot(options: PayloadCoordinatorOptions = {}): CoordinatedSnapshot {
  const agentDir = options.agentDir ?? currentAgentDir();
  const read = options.readArtifact ?? readArtifact;
  const nativePath = getModelsPath(agentDir);
  const payloadPath = getPayloadConfigPath(agentDir);
  const journalPath = getTransactionJournalPath(agentDir);
  return {
    agentDir,
    native: parsed(readNormalized(read, nativePath), nativePath, (bytes) => parseModelsDocument(nativePath, bytes), () => ({ providers: {} })),
    payload: parsed(readNormalized(read, payloadPath), payloadPath, (bytes) => parsePayloadDocument(bytes, payloadPath), emptyPayloadDocument),
    journal: parsed(readNormalized(read, journalPath), journalPath, parseJournal, () => undefined as never),
  };
}

function stableSnapshot(options: PayloadCoordinatorOptions): CoordinatedSnapshot | undefined {
  const agentDir = options.agentDir ?? currentAgentDir();
  const read = options.readArtifact ?? readArtifact;
  const nativePath = getModelsPath(agentDir);
  const payloadPath = getPayloadConfigPath(agentDir);
  const journalPath = getTransactionJournalPath(agentDir);
  let readerFailed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let journalOne: ArtifactSnapshot;
    let nativeOne: ArtifactSnapshot;
    let payloadOne: ArtifactSnapshot;
    let nativeTwo: ArtifactSnapshot;
    let payloadTwo: ArtifactSnapshot;
    let journalTwo: ArtifactSnapshot;
    try {
      journalOne = readNormalized(read, journalPath);
      nativeOne = readNormalized(read, nativePath);
      payloadOne = readNormalized(read, payloadPath);
      nativeTwo = readNormalized(read, nativePath);
      payloadTwo = readNormalized(read, payloadPath);
      journalTwo = readNormalized(read, journalPath);
    } catch {
      readerFailed = true;
      continue;
    }
    if (journalOne.hash !== journalTwo.hash || nativeOne.hash !== nativeTwo.hash || payloadOne.hash !== payloadTwo.hash) continue;
    if (readerFailed) return undefined;
    return {
      agentDir,
      native: parsed(nativeOne, nativePath, (bytes) => parseModelsDocument(nativePath, bytes), () => ({ providers: {} })),
      payload: parsed(payloadOne, payloadPath, (bytes) => parsePayloadDocument(bytes, payloadPath), emptyPayloadDocument),
      journal: parsed(journalOne, journalPath, parseJournal, () => undefined as never),
    };
  }
  return undefined;
}

export function resolveRequestPayload(provider: string, modelId: string, options: PayloadCoordinatorOptions = {}): Record<string, unknown> | undefined {
  const snapshot = stableSnapshot(options);
  if (!snapshot || snapshot.native.parseState === "malformed") return genericFailure(options);
  if (snapshot.journal.parseState === "malformed") return genericFailure(options);
  if (snapshot.journal.parseState === "valid") {
    const journal = snapshot.journal.document!;
    if (snapshot.native.hash === journal.nativeBeforeHash) return lookupModelPayload(journal.beforePayload, provider, modelId);
    if (snapshot.native.hash === journal.nativeAfterHash) return lookupModelPayload(journal.afterPayload, provider, modelId);
    return genericFailure(options);
  }
  if (snapshot.payload.parseState === "malformed") return genericFailure(options);
  return lookupModelPayload(snapshot.payload.document!, provider, modelId);
}

function tokenFor(snapshot: CoordinatedSnapshot): string {
  return JSON.stringify({
    nativeHash: snapshot.native.hash,
    payloadHash: snapshot.payload.hash,
    journalHash: snapshot.journal.hash,
    nativeState: snapshot.native.parseState,
    payloadState: snapshot.payload.parseState,
    journalState: snapshot.journal.parseState,
    operationId: snapshot.journal.document?.operationId ?? null,
  });
}

function recoveryChoices(snapshot: CoordinatedSnapshot): RecoveryChoice[] | undefined {
  if (snapshot.native.parseState === "malformed") return undefined;
  if (snapshot.journal.parseState === "valid") {
    if (snapshot.native.hash === snapshot.journal.document!.nativeBeforeHash || snapshot.native.hash === snapshot.journal.document!.nativeAfterHash) return [];
    return ["restore-before-payload", "restore-after-payload"];
  }
  if (snapshot.journal.parseState === "malformed") {
    return snapshot.payload.parseState === "valid" || snapshot.payload.parseState === "missing"
      ? ["accept-current"]
      : ["quarantine-and-empty"];
  }
  if (snapshot.payload.parseState === "malformed") return ["quarantine-and-empty"];
  return undefined;
}

function assertAndReplace(lock: MutationLockHandle, filePath: string, bytes: Uint8Array, expectedHash: string, mode?: number): void {
  lock.assertOwned();
  atomicReplace(filePath, bytes, { expectedHash, mode });
}

function assertAndRemove(lock: MutationLockHandle, filePath: string, expectedHash: string): void {
  lock.assertOwned();
  atomicRemove(filePath, { expectedHash });
}

function assertAndQuarantine(lock: MutationLockHandle, filePath: string, expectedHash: string, privateArtifact: boolean): void {
  lock.assertOwned();
  quarantineArtifact(filePath, `${Date.now()}-${randomUUID()}`, {
    expectedHash,
    mode: privateArtifact ? 0o600 : undefined,
  });
}

function automaticRecovery(lock: MutationLockHandle, snapshot: CoordinatedSnapshot): boolean {
  if (snapshot.native.parseState === "malformed" || snapshot.journal.parseState !== "valid") return false;
  const journal = snapshot.journal.document!;
  const replacement = snapshot.native.hash === journal.nativeBeforeHash
    ? journal.beforePayload
    : snapshot.native.hash === journal.nativeAfterHash ? journal.afterPayload : undefined;
  if (!replacement) return false;
  const payloadHash = snapshot.payload.parseState === "malformed" && snapshot.payload.exists
    ? (assertAndQuarantine(lock, snapshot.payload.path, snapshot.payload.hash, true), hashArtifact(undefined))
    : snapshot.payload.hash;
  assertAndReplace(lock, snapshot.payload.path, serializePayloadDocument(clonePayloadDocument(replacement)), payloadHash, 0o600);
  assertAndRemove(lock, snapshot.journal.path, snapshot.journal.hash);
  return true;
}

async function acquire(agentDir: string): Promise<AcquireLockResult> {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  return tryAcquireMutationLock(agentDir);
}

export async function inspectRecovery(options: PayloadCoordinatorOptions = {}): Promise<RecoveryResult> {
  const agentDir = options.agentDir ?? currentAgentDir();
  const acquired = await acquire(agentDir);
  if (acquired.type !== "acquired") return acquired;
  try {
    let snapshot: CoordinatedSnapshot;
    try {
      snapshot = readCoordinatedSnapshot({ ...options, agentDir });
    } catch {
      return { type: "blocked" };
    }
    if (automaticRecovery(acquired.handle, snapshot)) return { type: "automatic-recovered" };
    const choices = recoveryChoices(snapshot);
    if (choices === undefined) return snapshot.native.parseState !== "malformed"
      && snapshot.journal.parseState === "missing" && snapshot.payload.parseState !== "malformed"
      ? { type: "clean" }
      : { type: "blocked" };
    if (choices.length === 0) return { type: "blocked" };
    return { type: "needs-choice", snapshotToken: tokenFor(snapshot), choices };
  } finally {
    await acquired.handle.release();
  }
}

export async function applyRecovery(snapshotToken: string, choice: RecoveryChoice, options: PayloadCoordinatorOptions = {}): Promise<ApplyRecoveryResult> {
  const agentDir = options.agentDir ?? currentAgentDir();
  const acquired = await acquire(agentDir);
  if (acquired.type !== "acquired") return acquired;
  try {
    let snapshot: CoordinatedSnapshot;
    try {
      snapshot = readCoordinatedSnapshot({ ...options, agentDir });
    } catch {
      return { type: "blocked" };
    }
    if (tokenFor(snapshot) !== snapshotToken) return { type: "refresh" };
    const choices = recoveryChoices(snapshot);
    if (!choices?.includes(choice)) return { type: "blocked" };
    if (choice === "restore-before-payload" || choice === "restore-after-payload") {
      const journal = snapshot.journal.document!;
      const payload = choice === "restore-before-payload" ? journal.beforePayload : journal.afterPayload;
      const payloadHash = snapshot.payload.parseState === "malformed" && snapshot.payload.exists
        ? (assertAndQuarantine(acquired.handle, snapshot.payload.path, snapshot.payload.hash, true), hashArtifact(undefined))
        : snapshot.payload.hash;
      assertAndReplace(acquired.handle, snapshot.payload.path, serializePayloadDocument(clonePayloadDocument(payload)), payloadHash, 0o600);
      assertAndRemove(acquired.handle, snapshot.journal.path, snapshot.journal.hash);
      return { type: "recovered" };
    }
    if (choice === "accept-current") {
      assertAndQuarantine(acquired.handle, snapshot.journal.path, snapshot.journal.hash, true);
      return { type: "recovered" };
    }
    if (snapshot.journal.parseState === "malformed" && snapshot.journal.exists) {
      assertAndQuarantine(acquired.handle, snapshot.journal.path, snapshot.journal.hash, true);
    }
    if (snapshot.payload.exists) assertAndQuarantine(acquired.handle, snapshot.payload.path, snapshot.payload.hash, true);
    assertAndReplace(acquired.handle, snapshot.payload.path, serializePayloadDocument(emptyPayloadDocument()), hashArtifact(undefined), 0o600);
    return { type: "recovered" };
  } finally {
    await acquired.handle.release();
  }
}

export async function commitCoordinatedMutation(request: MutationRequest, options: PayloadCoordinatorOptions = {}): Promise<CommitResult> {
  const agentDir = options.agentDir ?? currentAgentDir();
  const acquired = await acquire(agentDir);
  if (acquired.type !== "acquired") return acquired;
  try {
    let snapshot: CoordinatedSnapshot;
    try {
      snapshot = readCoordinatedSnapshot({ ...options, agentDir });
      if (automaticRecovery(acquired.handle, snapshot)) snapshot = readCoordinatedSnapshot({ ...options, agentDir });
    } catch {
      return { type: "recovery-required" };
    }
    if (snapshot.native.parseState === "malformed" || snapshot.payload.parseState === "malformed" || snapshot.journal.parseState !== "missing") {
      return { type: "recovery-required" };
    }
    const candidate = request.build(cloneSnapshot(snapshot));
    const nativeBytes = serializeModelsDocument(cloneModelsDocument(candidate.native));
    const payloadBytes = serializePayloadDocument(clonePayloadDocument(candidate.payload));
    const nativeCandidate = parseModelsDocument(snapshot.native.path, nativeBytes);
    const payloadCandidate = parsePayloadDocument(payloadBytes, snapshot.payload.path);
    const nativeChanged = hashArtifact(nativeBytes) !== snapshot.native.hash;
    const payloadChanged = hashArtifact(payloadBytes) !== snapshot.payload.hash;
    if (!nativeChanged && !payloadChanged) return { type: "unchanged" };
    if (nativeChanged && payloadChanged) {
      const journal: TransactionJournalV1 = {
        version: 1,
        operationId: randomUUID(),
        nativeBeforeHash: snapshot.native.hash,
        nativeAfterHash: hashArtifact(nativeBytes),
        payloadBeforeHash: snapshot.payload.hash,
        payloadAfterHash: hashArtifact(payloadBytes),
        beforePayload: clonePayloadDocument(snapshot.payload.document!),
        afterPayload: clonePayloadDocument(payloadCandidate),
      };
      const journalBytes = serializeJournal(journal);
      assertAndReplace(acquired.handle, snapshot.journal.path, journalBytes, snapshot.journal.hash, 0o600);
      request.onBoundary?.("journal");
      assertAndReplace(acquired.handle, snapshot.native.path, nativeBytes, snapshot.native.hash);
      request.onBoundary?.("native");
      assertAndReplace(acquired.handle, snapshot.payload.path, payloadBytes, snapshot.payload.hash, 0o600);
      request.onBoundary?.("payload");
      assertAndRemove(acquired.handle, snapshot.journal.path, hashArtifact(journalBytes));
      request.onBoundary?.("journal-removed");
      return { type: "committed" };
    }
    if (nativeChanged) {
      assertAndReplace(acquired.handle, snapshot.native.path, serializeModelsDocument(nativeCandidate), snapshot.native.hash);
      request.onBoundary?.("native");
    } else {
      assertAndReplace(acquired.handle, snapshot.payload.path, payloadBytes, snapshot.payload.hash, 0o600);
      request.onBoundary?.("payload");
    }
    return { type: "committed" };
  } finally {
    await acquired.handle.release();
  }
}

export function mergeResolvedPayload(payload: unknown, provider: string, modelId: string): Record<string, unknown> | undefined {
  const resolved = resolveRequestPayload(provider, modelId);
  return resolved === undefined ? undefined : mergePayloadIntoRequest(payload, resolved);
}
