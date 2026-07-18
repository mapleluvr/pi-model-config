import { randomUUID } from "node:crypto";
import {
  commitCoordinatedMutation,
  readCoordinatedSnapshot,
  type CommitResult,
  type CoordinatedSnapshot,
  type MutationRequest,
  type PayloadCoordinatorOptions,
} from "./payload-coordinator.ts";
import {
  clonePayloadDocument,
  copyPayloadDocumentValue,
  emptyPayloadDocument,
  listProviderPayloadIdentities,
  lookupModelPayload,
  movePayloadDocumentValue,
  removePayloadDocumentValue,
  removeProviderPayloadDocumentValues,
  setPayloadDocumentValue,
  type PayloadConfig,
} from "./payload-config.ts";
import { deleteOwnKey, getOwnValue, hasOwnKey, setOwnValue } from "./own-keys.ts";
import {
  deepCloneJson,
  deepEqualJson,
  mergeModelConfig,
  mergeProviderConfig,
  normalizeSubtreeBaseline,
  readModelSubtree,
  readProviderSubtree,
  writeModelSubtree,
  writeProviderSubtree,
  type ConfigPatch,
  type ModelSubtreeKey,
  type ProviderSubtreeKey,
} from "./model-fields.ts";
import {
  assertValidModelsCandidate,
  validateModelsCandidate,
  type ValidationIssue,
  type ValidationOptions,
} from "./config-validation.ts";
import type { ModelConfig, ModelsConfig, ProviderConfig } from "./types.ts";

export type ModelIdentity = readonly [provider: string, modelId: string];

/** Opaque bound preview token. Never contains request bodies or secrets. */
export type IdentityPreviewToken = string;

export interface IdentityPreviewDescriptor {
  scope: "provider" | "model";
  kind: "rename" | "copy" | "delete";
  sourceProviderId: string;
  sourceModelId?: string;
  targetProviderId?: string;
  targetModelId?: string;
  nativeHash: string;
  payloadHash: string;
  affectedIdentities: ModelIdentity[];
  collisions: ModelIdentity[];
  resolution?: PayloadCollisionResolution;
}

export type ActionResult =
  | { type: "success"; snapshot: EditorSnapshot }
  | {
    type: "stale-target";
    nativeHash?: string;
    payloadHash?: string;
    path?: string;
    preview?: IdentityPreviewDescriptor & { token: IdentityPreviewToken };
  }
  | { type: "validation-error"; issues: ValidationIssue[] }
  | { type: "subtree-conflict"; path: string; nativeHash: string; payloadHash: string }
  | { type: "native-collision"; target: string }
  | {
    type: "payload-collision";
    collisions: ModelIdentity[];
    affectedIdentities: ModelIdentity[];
    nativeHash: string;
    payloadHash: string;
    scope: "provider" | "model";
    kind: "rename" | "copy" | "delete" | "create";
  }
  | {
    type: "preview";
    token: IdentityPreviewToken;
    affectedIdentities: ModelIdentity[];
    collisions: ModelIdentity[];
    descriptor: IdentityPreviewDescriptor;
  }
  | { type: "lock-busy" }
  | { type: "lock-collision" }
  | { type: "lock-unsupported" }
  | { type: "recovery-required" };

export interface EditorSnapshot {
  type: "snapshot";
  native: ModelsConfig;
  payload: PayloadConfig;
  nativeHash: string;
  payloadHash: string;
}

export type PayloadCollisionResolution = "replace-target" | "reuse-target";

/** Explicit resolution required before any write may strip malformed native legacy rows. */
export type LegacyDiscardResolution = "discard-malformed-legacy";

export type ProviderIdentityRequest =
  | {
    kind: "rename";
    providerId: string;
    targetProviderId: string;
    /** Managed-field patch merged into the fresh source Provider under lock. Never replaces models implicitly. */
    providerPatch?: ConfigPatch<ProviderConfig>;
    fieldBaselines?: Readonly<Record<string, unknown>>;
    payloadCollisionResolution?: PayloadCollisionResolution;
    legacyDiscardResolution?: LegacyDiscardResolution;
  }
  | {
    kind: "copy";
    providerId: string;
    targetProviderId: string;
    payloadCollisionResolution?: PayloadCollisionResolution;
    legacyDiscardResolution?: LegacyDiscardResolution;
  }
  | { kind: "delete"; providerId: string };

export type ModelIdentityRequest =
  | {
    kind: "rename";
    providerId: string;
    modelId: string;
    targetModelId: string;
    /** Managed-field patch merged into the fresh source Model under lock. */
    modelPatch?: ConfigPatch<ModelConfig>;
    fieldBaselines?: Readonly<Record<string, unknown>>;
    payload?: Record<string, unknown> | null;
    migrateLegacyExtraPayload?: Record<string, unknown>;
    payloadCollisionResolution?: PayloadCollisionResolution;
    legacyDiscardResolution?: LegacyDiscardResolution;
  }
  | {
    kind: "copy";
    providerId: string;
    modelId: string;
    targetModelId: string;
    modelPatch?: ConfigPatch<ModelConfig>;
    payloadCollisionResolution?: PayloadCollisionResolution;
    legacyDiscardResolution?: LegacyDiscardResolution;
  }
  | { kind: "delete"; providerId: string; modelId: string };

export interface FieldPatchOptions {
  /** Exact per-field baselines captured when the editor opened. Drift on an edited field conflicts. */
  fieldBaselines?: Readonly<Record<string, unknown>>;
  /** Required to strip malformed native legacy rows during a field save. */
  legacyDiscardResolution?: LegacyDiscardResolution;
}

export interface PreviewSchedulerHandle {
  id: unknown;
}

export interface ModelConfigActionsOptions extends PayloadCoordinatorOptions {
  validation?: ValidationOptions;
  commitMutation?: (request: MutationRequest, options?: PayloadCoordinatorOptions) => Promise<CommitResult>;
  /** Injectable clock for deterministic preview TTL tests (epoch ms). */
  now?: () => number;
  /** Bound preview time-to-live. Default 5 minutes. */
  previewTtlMs?: number;
  /** Max retained bound previews. Default 32. */
  maxPreviews?: number;
  /** Injectable timer schedule (default setTimeout). */
  schedule?: (fn: () => void, delayMs: number) => PreviewSchedulerHandle;
  /** Injectable timer cancel (default clearTimeout). */
  cancel?: (handle: PreviewSchedulerHandle) => void;
}

interface BoundIdentityPreview {
  scope: "provider" | "model";
  request: ProviderIdentityRequest | ModelIdentityRequest;
  nativeHash: string;
  payloadHash: string;
  identitySet: string[];
  collisions: ModelIdentity[];
  affectedIdentities: ModelIdentity[];
  descriptor: IdentityPreviewDescriptor;
  createdAt: number;
}

const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PREVIEWS = 32;

type BuildOutcome =
  | { type: "mutation"; native: ModelsConfig; payload: PayloadConfig; affectedIdentities: ModelIdentity[] }
  | { type: "stale-target"; path?: string }
  | { type: "validation-error"; issues: ValidationIssue[] }
  | { type: "subtree-conflict"; path: string }
  | { type: "native-collision"; target: string }
  | {
    type: "payload-collision";
    collisions: ModelIdentity[];
    affectedIdentities: ModelIdentity[];
    scope: "provider" | "model";
    kind: "rename" | "copy" | "delete" | "create";
  }
  | { type: "unchanged" };

function cloneModels(config: ModelsConfig): ModelsConfig {
  return deepCloneJson(config);
}

function identityKey(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId]);
}

function getProvider(config: ModelsConfig, providerId: string): ProviderConfig | undefined {
  return getOwnValue(config.providers as Record<string, ProviderConfig>, providerId);
}

function hasProvider(config: ModelsConfig, providerId: string): boolean {
  return hasOwnKey(config.providers, providerId);
}

function setProvider(config: ModelsConfig, providerId: string, provider: ProviderConfig): void {
  setOwnValue(config.providers as Record<string, ProviderConfig>, providerId, provider);
}

function deleteProvider(config: ModelsConfig, providerId: string): void {
  deleteOwnKey(config.providers, providerId);
}

function providerIdentitySet(config: ModelsConfig): string[] {
  return Object.keys(config.providers).filter((key) => hasOwnKey(config.providers, key)).sort();
}

function modelIdentitySet(config: ModelsConfig): string[] {
  const ids: string[] = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    for (const entry of provider.models ?? []) ids.push(identityKey(providerId, entry.id));
  }
  return ids.sort();
}

function findModelIndex(provider: ProviderConfig, modelId: string): number {
  return (provider.models ?? []).findIndex((entry) => entry.id === modelId);
}

function stripLegacyExtraPayload(model: ModelConfig): ModelConfig {
  const next = deepCloneJson(model);
  deleteOwnKey(next as object, "extraPayload");
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Legacy native extraPayload is an array of { key, type, value } rows
 * (type: string | bool | json; value always a string). Object shapes are invalid.
 */
export function parseLegacyExtraPayload(value: unknown): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string } {
  // Reasons must stay non-secret and free of private field names (no "extraPayload" / values).
  if (!Array.isArray(value)) return { ok: false, reason: "legacy rows must be an array" };
  const payload: Record<string, unknown> = {};
  for (const row of value) {
    if (
      !isPlainObject(row)
      || typeof row.key !== "string"
      || !row.key.trim()
      || typeof row.type !== "string"
      || typeof row.value !== "string"
    ) {
      return { ok: false, reason: "legacy row is malformed" };
    }
    if (row.type === "string") {
      setOwnValue(payload, row.key, row.value);
    } else if (row.type === "bool" && (row.value === "true" || row.value === "false")) {
      setOwnValue(payload, row.key, row.value === "true");
    } else if (row.type === "json") {
      try {
        setOwnValue(payload, row.key, JSON.parse(row.value));
      } catch {
        return { ok: false, reason: "legacy json row is invalid" };
      }
    } else {
      return { ok: false, reason: "legacy row type is unsupported" };
    }
  }
  return { ok: true, payload };
}

type LegacyRead =
  | { kind: "none" }
  | { kind: "valid"; payload: Record<string, unknown> }
  | { kind: "invalid"; reason: string };

function readLegacyExtraPayload(model: ModelConfig): LegacyRead {
  if (!hasOwnKey(model as object, "extraPayload")) return { kind: "none" };
  const legacy = getOwnValue(model as Record<string, unknown>, "extraPayload");
  const parsed = parseLegacyExtraPayload(legacy);
  if (!parsed.ok) return { kind: "invalid", reason: parsed.reason };
  return { kind: "valid", payload: parsed.payload };
}

function mapLockResult(result: CommitResult): ActionResult | undefined {
  if (result.type === "busy") return { type: "lock-busy" };
  if (result.type === "collision") return { type: "lock-collision" };
  if (result.type === "unsupported") return { type: "lock-unsupported" };
  if (result.type === "recovery-required") return { type: "recovery-required" };
  return undefined;
}

function coordinatorOptions(options: ModelConfigActionsOptions): PayloadCoordinatorOptions {
  const { validation: _validation, commitMutation: _commit, ...rest } = options;
  return rest;
}

function snapshotFrom(coordinated: CoordinatedSnapshot): EditorSnapshot {
  return {
    type: "snapshot",
    native: cloneModels(coordinated.native.document ?? { providers: {} }),
    payload: clonePayloadDocument(coordinated.payload.document ?? emptyPayloadDocument()),
    nativeHash: coordinated.native.hash,
    payloadHash: coordinated.payload.hash,
  };
}

function validateOrIssues(candidate: ModelsConfig, options?: ValidationOptions): ValidationIssue[] {
  return validateModelsCandidate(candidate, options);
}

function ensureReady(snapshot: CoordinatedSnapshot): ActionResult | undefined {
  if (
    snapshot.native.parseState === "malformed"
    || snapshot.payload.parseState === "malformed"
    || snapshot.journal.parseState !== "missing"
  ) {
    return { type: "recovery-required" };
  }
  return undefined;
}

/** Re-export authoritative private identity enumerator (tuples + unambiguous legacy delimiter keys). */
export function providerPayloadIdentities(payload: PayloadConfig, providerId: string): ModelIdentity[] {
  return listProviderPayloadIdentities(payload, providerId);
}

function collectProviderModelIds(provider: ProviderConfig): string[] {
  return (provider.models ?? []).map((entry) => entry.id);
}

/** Union of native model IDs and all private payload identities the commit can move/copy/delete. */
function collectProviderSourceIdentities(
  providerId: string,
  provider: ProviderConfig,
  payload: PayloadConfig,
): ModelIdentity[] {
  const map = new Map<string, ModelIdentity>();
  for (const modelId of collectProviderModelIds(provider)) {
    map.set(identityKey(providerId, modelId), [providerId, modelId]);
  }
  for (const identity of listProviderPayloadIdentities(payload, providerId)) {
    map.set(identityKey(identity[0], identity[1]), identity);
  }
  return [...map.values()].sort((a, b) => identityKey(a[0], a[1]).localeCompare(identityKey(b[0], b[1])));
}

function targetPayloadCollisions(
  payload: PayloadConfig,
  targets: ModelIdentity[],
  sources: ReadonlySet<string>,
): ModelIdentity[] {
  const collisions: ModelIdentity[] = [];
  for (const [provider, modelId] of targets) {
    const key = identityKey(provider, modelId);
    if (sources.has(key)) continue;
    if (lookupModelPayload(payload, provider, modelId) !== undefined) collisions.push([provider, modelId]);
  }
  return collisions;
}

function fieldValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function assertFieldBaselines(
  current: Record<string, unknown>,
  baselines: Readonly<Record<string, unknown>> | undefined,
  pathPrefix: string,
): BuildOutcome | undefined {
  if (!baselines) return undefined;
  for (const [key, baseline] of Object.entries(baselines)) {
    const actual = fieldValue(current, key);
    if (!deepEqualJson(actual, baseline)) {
      return { type: "subtree-conflict", path: `${pathPrefix}.${key}` };
    }
  }
  return undefined;
}

function stripModelsFromProviderPatch(patch: ConfigPatch<ProviderConfig>): ConfigPatch<ProviderConfig> {
  const next = { ...patch };
  delete (next as Record<string, unknown>).models;
  return next;
}

function applyPayloadDisposition(args: {
  payload: PayloadConfig;
  kind: "rename" | "copy";
  fromProvider: string;
  fromModelId: string;
  toProvider: string;
  toModelId: string;
  resolution?: PayloadCollisionResolution;
  explicitPayload?: Record<string, unknown> | null;
  migrateLegacy?: Record<string, unknown>;
  sourceHadPrivate: boolean;
}): PayloadConfig {
  let payload = args.payload;
  const targetExists = lookupModelPayload(payload, args.toProvider, args.toModelId) !== undefined;

  if (args.resolution === "reuse-target" && targetExists) {
    // Preserve target absolutely; rename still removes source.
    if (args.kind === "rename") {
      payload = removePayloadDocumentValue(payload, args.fromProvider, args.fromModelId);
    }
    return payload;
  }

  // replace-target or no target collision path.
  if (args.explicitPayload !== undefined) {
    if (args.kind === "rename") {
      payload = removePayloadDocumentValue(payload, args.fromProvider, args.fromModelId);
    }
    if (args.explicitPayload === null) {
      payload = removePayloadDocumentValue(payload, args.toProvider, args.toModelId);
    } else {
      payload = setPayloadDocumentValue(payload, args.toProvider, args.toModelId, args.explicitPayload);
    }
    return payload;
  }

  if (args.sourceHadPrivate) {
    payload = args.kind === "rename"
      ? movePayloadDocumentValue(payload, args.fromProvider, args.fromModelId, args.toProvider, args.toModelId)
      : copyPayloadDocumentValue(payload, args.fromProvider, args.fromModelId, args.toProvider, args.toModelId);
    return payload;
  }

  if (args.migrateLegacy) {
    if (args.kind === "rename") {
      payload = removePayloadDocumentValue(payload, args.fromProvider, args.fromModelId);
    }
    if (!targetExists || args.resolution === "replace-target") {
      payload = setPayloadDocumentValue(payload, args.toProvider, args.toModelId, args.migrateLegacy);
    }
    return payload;
  }

  // No source/new payload: rename removes source; replace-target clears collided target.
  if (args.kind === "rename") {
    payload = removePayloadDocumentValue(payload, args.fromProvider, args.fromModelId);
  }
  if (args.resolution === "replace-target" && targetExists) {
    payload = removePayloadDocumentValue(payload, args.toProvider, args.toModelId);
  }
  return payload;
}

function stripExtraPayloadFromProviderModels(provider: ProviderConfig): ProviderConfig {
  const next = deepCloneJson(provider);
  if (next.models) {
    next.models = next.models.map((model) => stripLegacyExtraPayload(model));
  }
  return next;
}

function malformedLegacyIssue(path: string, reason: string): ValidationIssue {
  return { path, message: reason };
}

function rejectMalformedLegacyUnlessDiscarded(
  model: ModelConfig,
  path: string,
  discard?: LegacyDiscardResolution,
): ValidationIssue | undefined {
  const legacy = readLegacyExtraPayload(model);
  if (legacy.kind === "invalid" && discard !== "discard-malformed-legacy") {
    return malformedLegacyIssue(path, legacy.reason);
  }
  return undefined;
}

function collectProviderMalformedLegacyIssues(
  provider: ProviderConfig,
  pathPrefix: string,
  discard?: LegacyDiscardResolution,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const model of provider.models ?? []) {
    const issue = rejectMalformedLegacyUnlessDiscarded(
      model,
      `${pathPrefix}.models[id=${model.id}].legacy`,
      discard,
    );
    if (issue) issues.push(issue);
  }
  return issues;
}

function migrateProviderLegacyPayloads(
  provider: ProviderConfig,
  fromProviderId: string,
  toProviderId: string,
  payload: PayloadConfig,
  kind: "rename" | "copy",
  resolution: PayloadCollisionResolution | undefined,
  modelIds: readonly string[],
): PayloadConfig {
  let next = payload;
  const handled = new Set<string>();
  for (const modelId of modelIds) {
    handled.add(modelId);
    const sourceModel = (provider.models ?? []).find((entry) => entry.id === modelId);
    const legacyRead = sourceModel ? readLegacyExtraPayload(sourceModel) : { kind: "none" as const };
    const legacy = legacyRead.kind === "valid" ? legacyRead.payload : undefined;
    const sourcePrivate = lookupModelPayload(next, fromProviderId, modelId);
    const targetExists = lookupModelPayload(next, toProviderId, modelId) !== undefined;

    if (resolution === "reuse-target" && targetExists) {
      if (kind === "rename") next = removePayloadDocumentValue(next, fromProviderId, modelId);
      continue;
    }

    next = applyPayloadDisposition({
      payload: next,
      kind,
      fromProvider: fromProviderId,
      fromModelId: modelId,
      toProvider: toProviderId,
      toModelId: modelId,
      resolution,
      migrateLegacy: legacy,
      sourceHadPrivate: sourcePrivate !== undefined,
    });
  }
  // Payload-only identities (no native model) still move/copy/remove per resolution.
  for (const [, modelId] of listProviderPayloadIdentities(next, fromProviderId)) {
    if (handled.has(modelId)) continue;
    const targetExists = lookupModelPayload(next, toProviderId, modelId) !== undefined;
    if (resolution === "reuse-target" && targetExists) {
      if (kind === "rename") next = removePayloadDocumentValue(next, fromProviderId, modelId);
      continue;
    }
    const sourcePrivate = lookupModelPayload(next, fromProviderId, modelId);
    next = applyPayloadDisposition({
      payload: next,
      kind,
      fromProvider: fromProviderId,
      fromModelId: modelId,
      toProvider: toProviderId,
      toModelId: modelId,
      resolution,
      sourceHadPrivate: sourcePrivate !== undefined,
    });
  }
  if (kind === "rename") {
    next = removeProviderPayloadDocumentValues(next, fromProviderId);
  }
  return next;
}

export class ModelConfigActions {
  private readonly options: ModelConfigActionsOptions;
  private readonly commit: (request: MutationRequest, options?: PayloadCoordinatorOptions) => Promise<CommitResult>;
  private readonly previews = new Map<string, BoundIdentityPreview>();
  private readonly now: () => number;
  private readonly previewTtlMs: number;
  private readonly maxPreviews: number;
  private readonly schedule: (fn: () => void, delayMs: number) => PreviewSchedulerHandle;
  private readonly cancelTimer: (handle: PreviewSchedulerHandle) => void;
  private expiryTimer: PreviewSchedulerHandle | undefined;

  constructor(options: ModelConfigActionsOptions = {}) {
    this.options = options;
    this.commit = options.commitMutation ?? commitCoordinatedMutation;
    this.now = options.now ?? (() => Date.now());
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.maxPreviews = options.maxPreviews ?? DEFAULT_MAX_PREVIEWS;
    this.schedule = options.schedule ?? ((fn, delayMs) => {
      const id = setTimeout(fn, delayMs);
      if (typeof (id as NodeJS.Timeout).unref === "function") (id as NodeJS.Timeout).unref();
      return { id };
    });
    this.cancelTimer = options.cancel ?? ((handle) => {
      clearTimeout(handle.id as NodeJS.Timeout);
    });
  }

  /** Explicitly discard a bound identity preview (cancel / final completion). */
  discardIdentityPreview(token: IdentityPreviewToken): void {
    this.previews.delete(token);
    this.rescheduleExpiry();
  }

  /** Test/introspection: number of currently retained bound previews (does not force prune). */
  boundPreviewCount(): number {
    return this.previews.size;
  }

  /** Test helper: force prune using current clock (does not fire scheduled callbacks). */
  forcePruneExpiredPreviews(): void {
    this.prunePreviews();
  }

  readEditorSnapshot(): EditorSnapshot | { type: "recovery-required" } {
    let coordinated: CoordinatedSnapshot;
    try {
      coordinated = readCoordinatedSnapshot(coordinatorOptions(this.options));
    } catch {
      return { type: "recovery-required" };
    }
    if (coordinated.native.parseState === "malformed" || coordinated.payload.parseState === "malformed") {
      return { type: "recovery-required" };
    }
    return snapshotFrom(coordinated);
  }

  async patchProvider(
    providerId: string,
    patch: ConfigPatch<ProviderConfig>,
    options?: FieldPatchOptions,
  ): Promise<ActionResult> {
    return this.run((snapshot) => {
      const existing = getProvider(snapshot.native.document!, providerId);
      if (!existing) return { type: "stale-target", path: `providers.${providerId}` };
      const safePatch = stripModelsFromProviderPatch(patch);
      // Allow explicit models only when the caller intentionally patches models (endpoint flows).
      const effectivePatch = hasOwnKey(patch, "models") ? patch : safePatch;
      const baselineConflict = assertFieldBaselines(
        existing as Record<string, unknown>,
        options?.fieldBaselines,
        `providers.${providerId}`,
      );
      if (baselineConflict) return baselineConflict;
      const next = cloneModels(snapshot.native.document!);
      setProvider(next, providerId, mergeProviderConfig(existing, effectivePatch));
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      return {
        type: "mutation",
        native: next,
        payload: clonePayloadDocument(snapshot.payload.document!),
        affectedIdentities: [],
      };
    });
  }

  async patchModel(
    providerId: string,
    modelId: string,
    patch: ConfigPatch<ModelConfig>,
    options?: FieldPatchOptions & { payload?: Record<string, unknown> | null },
  ): Promise<ActionResult> {
    return this.run((snapshot) => {
      const provider = getProvider(snapshot.native.document!, providerId);
      if (!provider) return { type: "stale-target", path: `providers.${providerId}` };
      const index = findModelIndex(provider, modelId);
      if (index < 0) return { type: "stale-target", path: `providers.${providerId}.models:${modelId}` };
      const existing = provider.models![index]!;
      if (typeof patch.id === "string" && patch.id !== modelId) {
        return {
          type: "validation-error",
          issues: [{ path: `$.providers.${providerId}.models`, message: "model identity changes require identity actions" }],
        };
      }
      const baselineConflict = assertFieldBaselines(
        existing as Record<string, unknown>,
        options?.fieldBaselines,
        `providers.${providerId}.models.${modelId}`,
      );
      if (baselineConflict) return baselineConflict;
      const malformed = rejectMalformedLegacyUnlessDiscarded(
        existing,
        `$.providers.${providerId}.models[id=${modelId}].legacy`,
        options?.legacyDiscardResolution,
      );
      if (malformed) return { type: "validation-error", issues: [malformed] };
      const next = cloneModels(snapshot.native.document!);
      const nextProvider = getProvider(next, providerId)!;
      const merged = mergeModelConfig(existing, patch);
      nextProvider.models = [...(nextProvider.models ?? [])];
      nextProvider.models[index] = stripLegacyExtraPayload(merged);
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      let payload = clonePayloadDocument(snapshot.payload.document!);
      const affected: ModelIdentity[] = [];
      if (options && hasOwnKey(options, "payload")) {
        if (options.payload === null || options.payload === undefined) {
          payload = removePayloadDocumentValue(payload, providerId, modelId);
        } else {
          payload = setPayloadDocumentValue(payload, providerId, modelId, options.payload);
        }
        affected.push([providerId, modelId]);
      }
      return { type: "mutation", native: next, payload, affectedIdentities: affected };
    });
  }

  async createProvider(
    providerId: string,
    config: ProviderConfig,
    options?: {
      payloadCollisionResolution?: PayloadCollisionResolution;
      legacyDiscardResolution?: LegacyDiscardResolution;
    },
  ): Promise<ActionResult> {
    return this.run((snapshot) => {
      if (hasProvider(snapshot.native.document!, providerId)) {
        return { type: "native-collision", target: providerId };
      }
      const legacyIssues = collectProviderMalformedLegacyIssues(
        config,
        `$.providers.${providerId}`,
        options?.legacyDiscardResolution,
      );
      if (legacyIssues.length > 0) return { type: "validation-error", issues: legacyIssues };
      const introduced = (config.models ?? []).map((entry) => [providerId, entry.id] as ModelIdentity);
      const collisions = targetPayloadCollisions(snapshot.payload.document!, introduced, new Set());
      const collisionKeys = new Set(collisions.map(([p, m]) => identityKey(p, m)));
      if (
        collisions.length > 0
        && options?.payloadCollisionResolution !== "replace-target"
        && options?.payloadCollisionResolution !== "reuse-target"
      ) {
        return {
          type: "payload-collision",
          collisions,
          affectedIdentities: introduced,
          scope: "provider",
          kind: "create",
        };
      }
      const next = cloneModels(snapshot.native.document!);
      setProvider(next, providerId, stripExtraPayloadFromProviderModels(deepCloneJson(config)));
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      let payload = clonePayloadDocument(snapshot.payload.document!);
      const affected: ModelIdentity[] = [];
      for (const model of config.models ?? []) {
        const key = identityKey(providerId, model.id);
        const targetExists = collisionKeys.has(key);
        const legacyRead = readLegacyExtraPayload(model);
        const legacy = legacyRead.kind === "valid" ? legacyRead.payload : undefined;
        if (options?.payloadCollisionResolution === "reuse-target" && targetExists) {
          affected.push([providerId, model.id]);
          continue;
        }
        if (options?.payloadCollisionResolution === "replace-target" && targetExists) {
          if (legacy) {
            payload = setPayloadDocumentValue(payload, providerId, model.id, legacy);
          } else {
            payload = removePayloadDocumentValue(payload, providerId, model.id);
          }
          affected.push([providerId, model.id]);
          continue;
        }
        if (!targetExists && legacy) {
          payload = setPayloadDocumentValue(payload, providerId, model.id, legacy);
          affected.push([providerId, model.id]);
        }
      }
      return {
        type: "mutation",
        native: next,
        payload,
        affectedIdentities: affected,
      };
    });
  }

  async createModel(
    providerId: string,
    model: ModelConfig,
    options?: {
      payload?: Record<string, unknown>;
      payloadCollisionResolution?: PayloadCollisionResolution;
      legacyDiscardResolution?: LegacyDiscardResolution;
    },
  ): Promise<ActionResult> {
    return this.run((snapshot) => {
      const provider = getProvider(snapshot.native.document!, providerId);
      if (!provider) return { type: "stale-target", path: `providers.${providerId}` };
      if (findModelIndex(provider, model.id) >= 0) return { type: "native-collision", target: model.id };
      const malformed = rejectMalformedLegacyUnlessDiscarded(
        model,
        `$.providers.${providerId}.models[id=${model.id}].legacy`,
        options?.legacyDiscardResolution,
      );
      if (malformed) return { type: "validation-error", issues: [malformed] };
      const legacyRead = readLegacyExtraPayload(model);
      const collisions = targetPayloadCollisions(
        snapshot.payload.document!,
        [[providerId, model.id]],
        new Set(),
      );
      if (
        collisions.length > 0
        && options?.payloadCollisionResolution !== "replace-target"
        && options?.payloadCollisionResolution !== "reuse-target"
      ) {
        return {
          type: "payload-collision",
          collisions,
          affectedIdentities: [[providerId, model.id]],
          scope: "model",
          kind: "create",
        };
      }
      const next = cloneModels(snapshot.native.document!);
      const nextProvider = getProvider(next, providerId)!;
      nextProvider.models = [...(nextProvider.models ?? []), stripLegacyExtraPayload(deepCloneJson(model))];
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      let payload = clonePayloadDocument(snapshot.payload.document!);
      const affected: ModelIdentity[] = [];
      const targetExists = collisions.length > 0;
      if (options?.payloadCollisionResolution === "reuse-target" && targetExists) {
        affected.push([providerId, model.id]);
      } else if (options?.payload !== undefined) {
        payload = setPayloadDocumentValue(payload, providerId, model.id, options.payload);
        affected.push([providerId, model.id]);
      } else if (options?.payloadCollisionResolution === "replace-target" && targetExists) {
        if (legacyRead.kind === "valid") {
          payload = setPayloadDocumentValue(payload, providerId, model.id, legacyRead.payload);
        } else {
          payload = removePayloadDocumentValue(payload, providerId, model.id);
        }
        affected.push([providerId, model.id]);
      } else if (legacyRead.kind === "valid" && !targetExists) {
        payload = setPayloadDocumentValue(payload, providerId, model.id, legacyRead.payload);
        affected.push([providerId, model.id]);
      }
      return { type: "mutation", native: next, payload, affectedIdentities: affected };
    });
  }

  async saveProviderSubtree(
    providerId: string,
    key: ProviderSubtreeKey,
    baseline: unknown,
    nextValue: unknown,
  ): Promise<ActionResult> {
    return this.run((snapshot) => {
      const provider = getProvider(snapshot.native.document!, providerId);
      if (!provider) return { type: "stale-target", path: `providers.${providerId}` };
      const current = readProviderSubtree(provider, key);
      const normalizedCurrent = current === undefined || current === null ? {} : current;
      const normalizedBaseline = baseline === undefined || baseline === null ? {} : baseline;
      if (!deepEqualJson(normalizedCurrent, normalizedBaseline)) {
        return { type: "subtree-conflict", path: `providers.${providerId}.${key}` };
      }
      const next = cloneModels(snapshot.native.document!);
      setProvider(next, providerId, writeProviderSubtree(provider, key, nextValue));
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      return {
        type: "mutation",
        native: next,
        payload: clonePayloadDocument(snapshot.payload.document!),
        affectedIdentities: [],
      };
    });
  }

  async saveModelSubtree(
    providerId: string,
    modelId: string,
    key: ModelSubtreeKey,
    baseline: unknown,
    nextValue: unknown,
  ): Promise<ActionResult> {
    return this.run((snapshot) => {
      const provider = getProvider(snapshot.native.document!, providerId);
      if (!provider) return { type: "stale-target", path: `providers.${providerId}` };
      const index = findModelIndex(provider, modelId);
      if (index < 0) return { type: "stale-target", path: `providers.${providerId}.models:${modelId}` };
      const model = provider.models![index]!;
      const current = readModelSubtree(model, key);
      if (key === "cost") {
        if (!deepEqualJson(normalizeSubtreeBaseline(current), normalizeSubtreeBaseline(baseline))) {
          return { type: "subtree-conflict", path: `providers.${providerId}.models.${modelId}.${key}` };
        }
      } else {
        const normalizedCurrent = current === undefined || current === null ? {} : current;
        const normalizedBaseline = baseline === undefined || baseline === null ? {} : baseline;
        if (!deepEqualJson(normalizedCurrent, normalizedBaseline)) {
          return { type: "subtree-conflict", path: `providers.${providerId}.models.${modelId}.${key}` };
        }
      }
      const next = cloneModels(snapshot.native.document!);
      const nextProvider = getProvider(next, providerId)!;
      nextProvider.models = [...(nextProvider.models ?? [])];
      nextProvider.models[index] = writeModelSubtree(model, key, nextValue);
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      return {
        type: "mutation",
        native: next,
        payload: clonePayloadDocument(snapshot.payload.document!),
        affectedIdentities: [],
      };
    });
  }

  async saveModelPayload(
    providerId: string,
    modelId: string,
    baseline: Record<string, unknown> | undefined,
    nextValue: Record<string, unknown> | undefined,
  ): Promise<ActionResult> {
    return this.run((snapshot) => {
      const provider = getProvider(snapshot.native.document!, providerId);
      if (!provider) return { type: "stale-target", path: `providers.${providerId}` };
      if (findModelIndex(provider, modelId) < 0) {
        return { type: "stale-target", path: `providers.${providerId}.models:${modelId}` };
      }
      const current = lookupModelPayload(snapshot.payload.document!, providerId, modelId);
      if (!deepEqualJson(current, baseline)) {
        return { type: "subtree-conflict", path: `payloads.${providerId}.${modelId}` };
      }
      let payload = clonePayloadDocument(snapshot.payload.document!);
      if (nextValue === undefined || Object.keys(nextValue).length === 0) {
        payload = removePayloadDocumentValue(payload, providerId, modelId);
      } else {
        payload = setPayloadDocumentValue(payload, providerId, modelId, nextValue);
      }
      return {
        type: "mutation",
        native: cloneModels(snapshot.native.document!),
        payload,
        affectedIdentities: [[providerId, modelId]],
      };
    });
  }

  async previewProviderIdentityAction(request: ProviderIdentityRequest): Promise<ActionResult> {
    return this.previewIdentity("provider", request);
  }

  async commitProviderIdentityAction(token: IdentityPreviewToken): Promise<ActionResult> {
    return this.commitIdentity(token);
  }

  async previewModelIdentityAction(request: ModelIdentityRequest): Promise<ActionResult> {
    return this.previewIdentity("model", request);
  }

  async commitModelIdentityAction(token: IdentityPreviewToken): Promise<ActionResult> {
    return this.commitIdentity(token);
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === undefined) return;
    this.cancelTimer(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private rescheduleExpiry(): void {
    this.clearExpiryTimer();
    if (this.previews.size === 0) return;
    const now = this.now();
    let nearest = Number.POSITIVE_INFINITY;
    for (const bound of this.previews.values()) {
      const expiresAt = bound.createdAt + this.previewTtlMs;
      if (expiresAt < nearest) nearest = expiresAt;
    }
    if (!Number.isFinite(nearest)) return;
    const delayMs = Math.max(0, nearest - now);
    this.expiryTimer = this.schedule(() => {
      this.expiryTimer = undefined;
      this.prunePreviews();
      this.rescheduleExpiry();
    }, delayMs);
  }

  private prunePreviews(): void {
    const now = this.now();
    for (const [token, bound] of this.previews) {
      if (now - bound.createdAt >= this.previewTtlMs) this.previews.delete(token);
    }
    while (this.previews.size > this.maxPreviews) {
      let oldestToken: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [token, bound] of this.previews) {
        if (bound.createdAt < oldestAt) {
          oldestAt = bound.createdAt;
          oldestToken = token;
        }
      }
      if (oldestToken === undefined) break;
      this.previews.delete(oldestToken);
    }
  }

  private bindPreview(bound: Omit<BoundIdentityPreview, "createdAt">): IdentityPreviewToken {
    this.prunePreviews();
    const token = randomUUID();
    this.previews.set(token, {
      ...bound,
      request: deepCloneJson(bound.request),
      collisions: bound.collisions.map((entry) => [entry[0], entry[1]] as ModelIdentity),
      affectedIdentities: bound.affectedIdentities.map((entry) => [entry[0], entry[1]] as ModelIdentity),
      identitySet: [...bound.identitySet],
      descriptor: deepCloneJson(bound.descriptor),
      createdAt: this.now(),
    });
    this.prunePreviews();
    this.rescheduleExpiry();
    return token;
  }

  private takeBound(token: IdentityPreviewToken): BoundIdentityPreview | undefined {
    this.prunePreviews();
    this.rescheduleExpiry();
    const bound = this.previews.get(token);
    if (!bound) return undefined;
    if (this.now() - bound.createdAt >= this.previewTtlMs) {
      this.previews.delete(token);
      this.rescheduleExpiry();
      return undefined;
    }
    return {
      ...bound,
      request: deepCloneJson(bound.request),
      collisions: bound.collisions.map((entry) => [entry[0], entry[1]] as ModelIdentity),
      affectedIdentities: bound.affectedIdentities.map((entry) => [entry[0], entry[1]] as ModelIdentity),
      identitySet: [...bound.identitySet],
      descriptor: deepCloneJson(bound.descriptor),
    };
  }

  private forgetPreview(token: IdentityPreviewToken): void {
    this.previews.delete(token);
    this.rescheduleExpiry();
  }

  private async previewIdentity(
    scope: "provider" | "model",
    request: ProviderIdentityRequest | ModelIdentityRequest,
  ): Promise<ActionResult> {
    let coordinated: CoordinatedSnapshot;
    try {
      coordinated = readCoordinatedSnapshot(coordinatorOptions(this.options));
    } catch {
      return { type: "recovery-required" };
    }
    const blocked = ensureReady(coordinated);
    if (blocked) return blocked;

    const built = scope === "provider"
      ? this.buildProviderIdentity(coordinated, request as ProviderIdentityRequest)
      : this.buildModelIdentity(coordinated, request as ModelIdentityRequest);

    if (built.type === "payload-collision") {
      return {
        type: "payload-collision",
        collisions: built.collisions,
        affectedIdentities: built.affectedIdentities,
        nativeHash: coordinated.native.hash,
        payloadHash: coordinated.payload.hash,
        scope: built.scope,
        kind: built.kind,
      };
    }
    if (built.type !== "mutation" && built.type !== "unchanged") {
      return this.mapBuildFailure(built, coordinated);
    }

    const affected = built.type === "mutation" ? built.affectedIdentities : this.previewAffected(scope, request, coordinated);
    const collisions = this.resolvedCollisions(scope, request, coordinated);
    const identitySet = scope === "provider"
      ? providerIdentitySet(coordinated.native.document!)
      : modelIdentitySet(coordinated.native.document!);
    const descriptor = this.descriptorFor(scope, request, coordinated.native.hash, coordinated.payload.hash, affected, collisions);
    const token = this.bindPreview({
      scope,
      request: deepCloneJson(request),
      nativeHash: coordinated.native.hash,
      payloadHash: coordinated.payload.hash,
      identitySet,
      collisions,
      affectedIdentities: affected,
      descriptor,
    });
    return {
      type: "preview",
      token,
      affectedIdentities: affected,
      collisions,
      descriptor,
    };
  }

  private previewAffected(
    scope: "provider" | "model",
    request: ProviderIdentityRequest | ModelIdentityRequest,
    coordinated: CoordinatedSnapshot,
  ): ModelIdentity[] {
    if (scope === "provider") {
      const req = request as ProviderIdentityRequest;
      const source = getProvider(coordinated.native.document!, req.providerId);
      if (!source) return [];
      const sourceIds = collectProviderSourceIdentities(req.providerId, source, coordinated.payload.document!);
      if (req.kind === "delete") return sourceIds;
      const targetIds = sourceIds.map(([, modelId]) => [req.targetProviderId, modelId] as ModelIdentity);
      return [...sourceIds, ...targetIds];
    }
    const req = request as ModelIdentityRequest;
    if (req.kind === "delete") return [[req.providerId, req.modelId]];
    return [[req.providerId, req.modelId], [req.providerId, req.targetModelId]];
  }

  private resolvedCollisions(
    scope: "provider" | "model",
    request: ProviderIdentityRequest | ModelIdentityRequest,
    coordinated: CoordinatedSnapshot,
  ): ModelIdentity[] {
    if (scope === "provider") {
      const req = request as ProviderIdentityRequest;
      if (req.kind === "delete") return [];
      const source = getProvider(coordinated.native.document!, req.providerId);
      if (!source) return [];
      const sourceIds = collectProviderSourceIdentities(req.providerId, source, coordinated.payload.document!);
      const sourceKeys = new Set(sourceIds.map(([p, m]) => identityKey(p, m)));
      const targets = sourceIds.map(([, modelId]) => [req.targetProviderId, modelId] as ModelIdentity);
      return targetPayloadCollisions(coordinated.payload.document!, targets, sourceKeys);
    }
    const req = request as ModelIdentityRequest;
    if (req.kind === "delete") return [];
    return targetPayloadCollisions(
      coordinated.payload.document!,
      [[req.providerId, req.targetModelId]],
      new Set([identityKey(req.providerId, req.modelId)]),
    );
  }

  private descriptorFor(
    scope: "provider" | "model",
    request: ProviderIdentityRequest | ModelIdentityRequest,
    nativeHash: string,
    payloadHash: string,
    affected: ModelIdentity[],
    collisions: ModelIdentity[],
  ): IdentityPreviewDescriptor {
    if (scope === "provider") {
      const req = request as ProviderIdentityRequest;
      return {
        scope,
        kind: req.kind,
        sourceProviderId: req.providerId,
        targetProviderId: req.kind === "delete" ? undefined : req.targetProviderId,
        nativeHash,
        payloadHash,
        affectedIdentities: affected,
        collisions,
        resolution: req.kind === "delete" ? undefined : req.payloadCollisionResolution,
      };
    }
    const req = request as ModelIdentityRequest;
    return {
      scope,
      kind: req.kind,
      sourceProviderId: req.providerId,
      sourceModelId: req.modelId,
      targetModelId: req.kind === "delete" ? undefined : req.targetModelId,
      nativeHash,
      payloadHash,
      affectedIdentities: affected,
      collisions,
      resolution: req.kind === "delete" ? undefined : req.payloadCollisionResolution,
    };
  }

  private async commitIdentity(token: IdentityPreviewToken): Promise<ActionResult> {
    const bound = this.takeBound(token);
    if (!bound) {
      return { type: "stale-target", path: "identity-preview" };
    }

    let refreshedOnDrift: ActionResult | undefined;

    try {
    const result = await this.run((snapshot) => {
      const identitySet = bound.scope === "provider"
        ? providerIdentitySet(snapshot.native.document!)
        : modelIdentitySet(snapshot.native.document!);
      if (
        snapshot.native.hash !== bound.nativeHash
        || snapshot.payload.hash !== bound.payloadHash
        || !deepEqualJson(identitySet, bound.identitySet)
      ) {
        // Rebuild a refreshed preview from the bound request under the live snapshot.
        const rebuilt = bound.scope === "provider"
          ? this.buildProviderIdentity(snapshot, bound.request as ProviderIdentityRequest)
          : this.buildModelIdentity(snapshot, bound.request as ModelIdentityRequest);
        if (rebuilt.type === "payload-collision") {
          refreshedOnDrift = {
            type: "payload-collision",
            collisions: rebuilt.collisions,
            affectedIdentities: rebuilt.affectedIdentities,
            nativeHash: snapshot.native.hash,
            payloadHash: snapshot.payload.hash,
            scope: rebuilt.scope,
            kind: rebuilt.kind,
          };
          return { type: "stale-target", path: "identity-preview" };
        }
        if (rebuilt.type === "mutation" || rebuilt.type === "unchanged") {
          const affected = rebuilt.type === "mutation"
            ? rebuilt.affectedIdentities
            : this.previewAffected(bound.scope, bound.request, snapshot);
          const collisions = this.resolvedCollisions(bound.scope, bound.request, snapshot);
          const identitySetNow = bound.scope === "provider"
            ? providerIdentitySet(snapshot.native.document!)
            : modelIdentitySet(snapshot.native.document!);
          const descriptor = this.descriptorFor(
            bound.scope,
            bound.request,
            snapshot.native.hash,
            snapshot.payload.hash,
            affected,
            collisions,
          );
          const newToken = this.bindPreview({
            scope: bound.scope,
            request: deepCloneJson(bound.request),
            nativeHash: snapshot.native.hash,
            payloadHash: snapshot.payload.hash,
            identitySet: identitySetNow,
            collisions,
            affectedIdentities: affected,
            descriptor,
          });
          refreshedOnDrift = {
            type: "stale-target",
            nativeHash: snapshot.native.hash,
            payloadHash: snapshot.payload.hash,
            path: "identity-preview",
            preview: { ...descriptor, token: newToken },
          };
          return { type: "stale-target", path: "identity-preview" };
        }
        refreshedOnDrift = this.mapBuildFailure(rebuilt, snapshot);
        return { type: "stale-target", path: "identity-preview" };
      }

      return bound.scope === "provider"
        ? this.buildProviderIdentity(snapshot, bound.request as ProviderIdentityRequest)
        : this.buildModelIdentity(snapshot, bound.request as ModelIdentityRequest);
    });

    // Consume the committed token even when coordinator/fault exceptions escape run().
    // Refreshed drift tokens are newly bound and must survive.
      if (refreshedOnDrift) return refreshedOnDrift;
      return result;
    } finally {
      this.forgetPreview(token);
    }
  }

  private buildProviderIdentity(snapshot: CoordinatedSnapshot, request: ProviderIdentityRequest): BuildOutcome {
    const native = snapshot.native.document!;
    const source = getProvider(native, request.providerId);
    if (!source) return { type: "stale-target", path: `providers.${request.providerId}` };

    if (request.kind === "rename" && request.fieldBaselines) {
      const conflict = assertFieldBaselines(
        source as Record<string, unknown>,
        request.fieldBaselines,
        `providers.${request.providerId}`,
      );
      if (conflict) return conflict;
    }

    // Provider rename/copy: malformed legacy never vanishes without explicit discard (even with private present).
    if (request.kind !== "delete") {
      const issues = collectProviderMalformedLegacyIssues(
        source,
        `$.providers.${request.providerId}`,
        request.legacyDiscardResolution,
      );
      if (issues.length > 0) return { type: "validation-error", issues };
    }

    let next = cloneModels(native);
    let payload = clonePayloadDocument(snapshot.payload.document!);
    const sourceIdentities = collectProviderSourceIdentities(request.providerId, source, snapshot.payload.document!);
    const modelIds = sourceIdentities.map(([, modelId]) => modelId);
    let affected: ModelIdentity[] = [...sourceIdentities];

    if (request.kind === "delete") {
      deleteProvider(next, request.providerId);
      payload = removeProviderPayloadDocumentValues(payload, request.providerId);
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      return { type: "mutation", native: next, payload, affectedIdentities: affected };
    }

    if (hasProvider(native, request.targetProviderId)) {
      return { type: "native-collision", target: request.targetProviderId };
    }

    const targetIdentities = sourceIdentities.map(([, modelId]) => [request.targetProviderId, modelId] as ModelIdentity);
    const sourceKeys = new Set(sourceIdentities.map(([p, m]) => identityKey(p, m)));
    const collisions = targetPayloadCollisions(payload, targetIdentities, sourceKeys);
    if (
      collisions.length > 0
      && request.payloadCollisionResolution !== "replace-target"
      && request.payloadCollisionResolution !== "reuse-target"
    ) {
      return {
        type: "payload-collision",
        collisions,
        affectedIdentities: [...sourceIdentities, ...targetIdentities],
        scope: "provider",
        kind: request.kind,
      };
    }

    // Start from fresh source; apply managed patch without replacing models from stale controller state.
    let providerBody = deepCloneJson(source);
    if (request.kind === "rename" && request.providerPatch) {
      providerBody = mergeProviderConfig(providerBody, stripModelsFromProviderPatch(request.providerPatch));
    }
    providerBody = stripExtraPayloadFromProviderModels(providerBody);
    setProvider(next, request.targetProviderId, providerBody);
    if (request.kind === "rename") deleteProvider(next, request.providerId);

    payload = migrateProviderLegacyPayloads(
      source,
      request.providerId,
      request.targetProviderId,
      payload,
      request.kind,
      request.payloadCollisionResolution,
      modelIds,
    );

    affected = [...sourceIdentities, ...targetIdentities];
    const issues = validateOrIssues(next, this.options.validation);
    if (issues.length > 0) return { type: "validation-error", issues };
    return { type: "mutation", native: next, payload, affectedIdentities: affected };
  }

  private buildModelIdentity(snapshot: CoordinatedSnapshot, request: ModelIdentityRequest): BuildOutcome {
    const native = snapshot.native.document!;
    const provider = getProvider(native, request.providerId);
    if (!provider) return { type: "stale-target", path: `providers.${request.providerId}` };
    const index = findModelIndex(provider, request.modelId);
    if (index < 0) return { type: "stale-target", path: `providers.${request.providerId}.models:${request.modelId}` };
    const existing = provider.models![index]!;

    if ((request.kind === "rename" || request.kind === "copy") && request.kind === "rename" && request.fieldBaselines) {
      const conflict = assertFieldBaselines(
        existing as Record<string, unknown>,
        request.fieldBaselines,
        `providers.${request.providerId}.models.${request.modelId}`,
      );
      if (conflict) return conflict;
    }

    let next = cloneModels(native);
    let payload = clonePayloadDocument(snapshot.payload.document!);
    const nextProvider = next.providers[request.providerId]!;
    nextProvider.models = [...(nextProvider.models ?? [])];

    if (request.kind === "delete") {
      nextProvider.models.splice(index, 1);
      payload = removePayloadDocumentValue(payload, request.providerId, request.modelId);
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      return {
        type: "mutation",
        native: next,
        payload,
        affectedIdentities: [[request.providerId, request.modelId]],
      };
    }

    if (findModelIndex(provider, request.targetModelId) >= 0) {
      return { type: "native-collision", target: request.targetModelId };
    }

    const sourceKey = identityKey(request.providerId, request.modelId);
    const collisions = targetPayloadCollisions(
      payload,
      [[request.providerId, request.targetModelId]],
      new Set([sourceKey]),
    );
    if (
      collisions.length > 0
      && request.payloadCollisionResolution !== "replace-target"
      && request.payloadCollisionResolution !== "reuse-target"
    ) {
      return {
        type: "payload-collision",
        collisions,
        affectedIdentities: [[request.providerId, request.modelId], [request.providerId, request.targetModelId]],
        scope: "model",
        kind: request.kind,
      };
    }

    const patched = request.modelPatch
      ? mergeModelConfig(existing, request.modelPatch)
      : deepCloneJson(existing);
    const body = stripLegacyExtraPayload(patched);
    body.id = request.targetModelId;

    const sourcePrivate = lookupModelPayload(snapshot.payload.document!, request.providerId, request.modelId);
    const legacyRead = readLegacyExtraPayload(existing);
    const discard = request.kind === "delete" ? undefined : request.legacyDiscardResolution;
    if (request.kind !== "delete") {
      const malformed = rejectMalformedLegacyUnlessDiscarded(
        existing,
        `$.providers.${request.providerId}.models[id=${request.modelId}].legacy`,
        discard,
      );
      if (malformed) return { type: "validation-error", issues: [malformed] };
    }
    const migrateLegacy = request.kind === "rename" && request.migrateLegacyExtraPayload !== undefined
      ? request.migrateLegacyExtraPayload
      : legacyRead.kind === "valid" ? legacyRead.payload : undefined;

    if (request.kind === "rename") {
      nextProvider.models[index] = body;
    } else {
      nextProvider.models.push(body);
    }

    payload = applyPayloadDisposition({
      payload,
      kind: request.kind,
      fromProvider: request.providerId,
      fromModelId: request.modelId,
      toProvider: request.providerId,
      toModelId: request.targetModelId,
      resolution: request.payloadCollisionResolution,
      explicitPayload: request.kind === "rename" && hasOwnKey(request, "payload") ? request.payload : undefined,
      migrateLegacy,
      sourceHadPrivate: sourcePrivate !== undefined,
    });

    const issues = validateOrIssues(next, this.options.validation);
    if (issues.length > 0) return { type: "validation-error", issues };
    return {
      type: "mutation",
      native: next,
      payload,
      affectedIdentities: [[request.providerId, request.modelId], [request.providerId, request.targetModelId]],
    };
  }

  private mapBuildFailure(
    built: Exclude<BuildOutcome, { type: "mutation" } | { type: "unchanged" }>,
    coordinated: CoordinatedSnapshot,
  ): ActionResult {
    if (built.type === "stale-target") {
      return {
        type: "stale-target",
        nativeHash: coordinated.native.hash,
        payloadHash: coordinated.payload.hash,
        path: built.path,
      };
    }
    if (built.type === "validation-error") return built;
    if (built.type === "subtree-conflict") {
      return {
        type: "subtree-conflict",
        path: built.path,
        nativeHash: coordinated.native.hash,
        payloadHash: coordinated.payload.hash,
      };
    }
    if (built.type === "native-collision") return built;
    return {
      type: "payload-collision",
      collisions: built.collisions,
      affectedIdentities: built.affectedIdentities,
      nativeHash: coordinated.native.hash,
      payloadHash: coordinated.payload.hash,
      scope: built.scope,
      kind: built.kind,
    };
  }

  private async run(build: (snapshot: CoordinatedSnapshot) => BuildOutcome): Promise<ActionResult> {
    let buildError: BuildOutcome | undefined;
    let result: CommitResult;
    try {
      result = await this.commit({
        build: (snapshot) => {
          const blocked = ensureReady(snapshot);
          if (blocked) {
            buildError = { type: "stale-target", path: "recovery" };
            throw new Error("ACTION_BUILD_BLOCKED");
          }
          const outcome = build(snapshot);
          if (outcome.type !== "mutation") {
            buildError = outcome;
            throw new Error("ACTION_BUILD_REJECTED");
          }
          try {
            assertValidModelsCandidate(outcome.native, this.options.validation);
          } catch {
            buildError = { type: "validation-error", issues: validateOrIssues(outcome.native, this.options.validation) };
            throw new Error("ACTION_BUILD_REJECTED");
          }
          return {
            native: outcome.native,
            payload: outcome.payload,
            affectedIdentities: outcome.affectedIdentities,
          };
        },
      }, coordinatorOptions(this.options));
    } catch (error) {
      if (buildError) {
        let coordinated: CoordinatedSnapshot | undefined;
        try {
          coordinated = readCoordinatedSnapshot(coordinatorOptions(this.options));
        } catch {
          coordinated = undefined;
        }
        if (buildError.type === "stale-target") {
          return {
            type: "stale-target",
            nativeHash: coordinated?.native.hash,
            payloadHash: coordinated?.payload.hash,
            path: buildError.path,
          };
        }
        if (buildError.type === "validation-error") return buildError;
        if (buildError.type === "subtree-conflict") {
          return {
            type: "subtree-conflict",
            path: buildError.path,
            nativeHash: coordinated?.native.hash ?? "",
            payloadHash: coordinated?.payload.hash ?? "",
          };
        }
        if (buildError.type === "native-collision") return buildError;
        if (buildError.type === "payload-collision") {
          return {
            type: "payload-collision",
            collisions: buildError.collisions,
            affectedIdentities: buildError.affectedIdentities,
            nativeHash: coordinated?.native.hash ?? "",
            payloadHash: coordinated?.payload.hash ?? "",
            scope: buildError.scope,
            kind: buildError.kind,
          };
        }
        return { type: "stale-target" };
      }
      throw error;
    }

    const lockMapped = mapLockResult(result);
    if (lockMapped) return lockMapped;
    if (result.type === "committed" || result.type === "unchanged") {
      const snapshot = this.readEditorSnapshot();
      if (snapshot.type === "recovery-required") return snapshot;
      return { type: "success", snapshot };
    }
    return { type: "recovery-required" };
  }
}
