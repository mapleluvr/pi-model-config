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
  lookupModelPayload,
  movePayloadDocumentValue,
  removePayloadDocumentValue,
  removeProviderPayloadDocumentValues,
  setPayloadDocumentValue,
  type PayloadConfig,
} from "./payload-config.ts";
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

export type ProviderIdentityRequest =
  | {
    kind: "rename";
    providerId: string;
    targetProviderId: string;
    /** Managed-field patch merged into the fresh source Provider under lock. Never replaces models implicitly. */
    providerPatch?: ConfigPatch<ProviderConfig>;
    fieldBaselines?: Readonly<Record<string, unknown>>;
    payloadCollisionResolution?: PayloadCollisionResolution;
  }
  | {
    kind: "copy";
    providerId: string;
    targetProviderId: string;
    payloadCollisionResolution?: PayloadCollisionResolution;
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
  }
  | {
    kind: "copy";
    providerId: string;
    modelId: string;
    targetModelId: string;
    modelPatch?: ConfigPatch<ModelConfig>;
    payloadCollisionResolution?: PayloadCollisionResolution;
  }
  | { kind: "delete"; providerId: string; modelId: string };

export interface FieldPatchOptions {
  /** Exact per-field baselines captured when the editor opened. Drift on an edited field conflicts. */
  fieldBaselines?: Readonly<Record<string, unknown>>;
}

export interface ModelConfigActionsOptions extends PayloadCoordinatorOptions {
  validation?: ValidationOptions;
  commitMutation?: (request: MutationRequest, options?: PayloadCoordinatorOptions) => Promise<CommitResult>;
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
}

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

function providerIdentitySet(config: ModelsConfig): string[] {
  return Object.keys(config.providers).sort();
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
  delete (next as Record<string, unknown>)["extraPayload"];
  return next;
}

function readLegacyExtraPayload(model: ModelConfig): Record<string, unknown> | undefined {
  if (!Object.hasOwn(model as object, "extraPayload")) return undefined;
  const legacy = (model as Record<string, unknown>)["extraPayload"];
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return undefined;
  try {
    return deepCloneJson(legacy as Record<string, unknown>);
  } catch {
    return undefined;
  }
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

/** Exact JSON-tuple private payload identities for a provider (not legacy slash keys). */
export function providerPayloadIdentities(payload: PayloadConfig, providerId: string): ModelIdentity[] {
  const identities: ModelIdentity[] = [];
  for (const key of Object.keys(payload.extraPayloads)) {
    try {
      const parsed: unknown = JSON.parse(key);
      if (Array.isArray(parsed) && parsed.length === 2 && parsed[0] === providerId && typeof parsed[1] === "string") {
        identities.push([providerId, parsed[1]]);
      }
    } catch {
      // ignore non-tuple keys
    }
  }
  return identities;
}

function collectProviderModelIds(provider: ProviderConfig): string[] {
  return (provider.models ?? []).map((entry) => entry.id);
}

/** Union of native model IDs and exact payload-only tuple identities for a provider. */
function collectProviderSourceIdentities(
  providerId: string,
  provider: ProviderConfig,
  payload: PayloadConfig,
): ModelIdentity[] {
  const map = new Map<string, ModelIdentity>();
  for (const modelId of collectProviderModelIds(provider)) {
    map.set(identityKey(providerId, modelId), [providerId, modelId]);
  }
  for (const identity of providerPayloadIdentities(payload, providerId)) {
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

  if (args.resolution === "replace-target" || !targetExists) {
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

    if (args.migrateLegacy && !args.sourceHadPrivate) {
      if (args.kind === "rename") {
        payload = removePayloadDocumentValue(payload, args.fromProvider, args.fromModelId);
      }
      // Private existing target already handled by reuse; replace/absent: migrate legacy.
      if (!targetExists || args.resolution === "replace-target") {
        payload = setPayloadDocumentValue(payload, args.toProvider, args.toModelId, args.migrateLegacy);
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

    if (args.kind === "rename") {
      payload = removePayloadDocumentValue(payload, args.fromProvider, args.fromModelId);
    }
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
  for (const modelId of modelIds) {
    const sourceModel = (provider.models ?? []).find((entry) => entry.id === modelId);
    const legacy = sourceModel ? readLegacyExtraPayload(sourceModel) : undefined;
    const sourcePrivate = lookupModelPayload(next, fromProviderId, modelId);
    const targetExists = lookupModelPayload(next, toProviderId, modelId) !== undefined;

    if (resolution === "reuse-target" && targetExists) {
      if (kind === "rename") next = removePayloadDocumentValue(next, fromProviderId, modelId);
      continue;
    }

    if (sourcePrivate) {
      next = kind === "rename"
        ? movePayloadDocumentValue(next, fromProviderId, modelId, toProviderId, modelId)
        : copyPayloadDocumentValue(next, fromProviderId, modelId, toProviderId, modelId);
      continue;
    }

    if (legacy && (!targetExists || resolution === "replace-target")) {
      if (kind === "rename") next = removePayloadDocumentValue(next, fromProviderId, modelId);
      next = setPayloadDocumentValue(next, toProviderId, modelId, legacy);
      continue;
    }

    if (kind === "rename") {
      next = removePayloadDocumentValue(next, fromProviderId, modelId);
    }
  }
  // Payload-only identities (no native model) still move/copy.
  const remaining = providerPayloadIdentities(next, fromProviderId);
  for (const [, modelId] of remaining) {
    if (modelIds.includes(modelId)) continue;
    const targetExists = lookupModelPayload(next, toProviderId, modelId) !== undefined;
    if (resolution === "reuse-target" && targetExists) {
      if (kind === "rename") next = removePayloadDocumentValue(next, fromProviderId, modelId);
      continue;
    }
    next = kind === "rename"
      ? movePayloadDocumentValue(next, fromProviderId, modelId, toProviderId, modelId)
      : copyPayloadDocumentValue(next, fromProviderId, modelId, toProviderId, modelId);
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

  constructor(options: ModelConfigActionsOptions = {}) {
    this.options = options;
    this.commit = options.commitMutation ?? commitCoordinatedMutation;
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
      const existing = snapshot.native.document!.providers[providerId];
      if (!existing) return { type: "stale-target", path: `providers.${providerId}` };
      const safePatch = stripModelsFromProviderPatch(patch);
      // Allow explicit models only when the caller intentionally patches models (endpoint flows).
      const effectivePatch = Object.hasOwn(patch, "models") ? patch : safePatch;
      const baselineConflict = assertFieldBaselines(
        existing as Record<string, unknown>,
        options?.fieldBaselines,
        `providers.${providerId}`,
      );
      if (baselineConflict) return baselineConflict;
      const next = cloneModels(snapshot.native.document!);
      next.providers[providerId] = mergeProviderConfig(existing, effectivePatch);
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
      const provider = snapshot.native.document!.providers[providerId];
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
      const next = cloneModels(snapshot.native.document!);
      const nextProvider = next.providers[providerId]!;
      const merged = mergeModelConfig(existing, patch);
      nextProvider.models = [...(nextProvider.models ?? [])];
      nextProvider.models[index] = stripLegacyExtraPayload(merged);
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      let payload = clonePayloadDocument(snapshot.payload.document!);
      const affected: ModelIdentity[] = [];
      if (options && Object.hasOwn(options, "payload")) {
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

  async createProvider(providerId: string, config: ProviderConfig): Promise<ActionResult> {
    return this.run((snapshot) => {
      if (Object.hasOwn(snapshot.native.document!.providers, providerId)) {
        return { type: "native-collision", target: providerId };
      }
      const next = cloneModels(snapshot.native.document!);
      next.providers[providerId] = stripExtraPayloadFromProviderModels(deepCloneJson(config));
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

  async createModel(
    providerId: string,
    model: ModelConfig,
    options?: { payload?: Record<string, unknown>; payloadCollisionResolution?: PayloadCollisionResolution },
  ): Promise<ActionResult> {
    return this.run((snapshot) => {
      const provider = snapshot.native.document!.providers[providerId];
      if (!provider) return { type: "stale-target", path: `providers.${providerId}` };
      if (findModelIndex(provider, model.id) >= 0) return { type: "native-collision", target: model.id };
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
      const nextProvider = next.providers[providerId]!;
      nextProvider.models = [...(nextProvider.models ?? []), stripLegacyExtraPayload(deepCloneJson(model))];
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      let payload = clonePayloadDocument(snapshot.payload.document!);
      const affected: ModelIdentity[] = [];
      const targetExists = collisions.length > 0;
      if (options?.payloadCollisionResolution === "reuse-target" && targetExists) {
        affected.push([providerId, model.id]);
      } else if (options?.payload) {
        payload = setPayloadDocumentValue(payload, providerId, model.id, options.payload);
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
      const provider = snapshot.native.document!.providers[providerId];
      if (!provider) return { type: "stale-target", path: `providers.${providerId}` };
      const current = readProviderSubtree(provider, key);
      const normalizedCurrent = current === undefined || current === null ? {} : current;
      const normalizedBaseline = baseline === undefined || baseline === null ? {} : baseline;
      if (!deepEqualJson(normalizedCurrent, normalizedBaseline)) {
        return { type: "subtree-conflict", path: `providers.${providerId}.${key}` };
      }
      const next = cloneModels(snapshot.native.document!);
      next.providers[providerId] = writeProviderSubtree(provider, key, nextValue);
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
      const provider = snapshot.native.document!.providers[providerId];
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
      const nextProvider = next.providers[providerId]!;
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
      const provider = snapshot.native.document!.providers[providerId];
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

  private bindPreview(bound: BoundIdentityPreview): IdentityPreviewToken {
    const token = randomUUID();
    this.previews.set(token, {
      ...bound,
      request: deepCloneJson(bound.request),
      collisions: bound.collisions.map((entry) => [entry[0], entry[1]] as ModelIdentity),
      affectedIdentities: bound.affectedIdentities.map((entry) => [entry[0], entry[1]] as ModelIdentity),
      identitySet: [...bound.identitySet],
      descriptor: deepCloneJson(bound.descriptor),
    });
    return token;
  }

  private takeBound(token: IdentityPreviewToken): BoundIdentityPreview | undefined {
    const bound = this.previews.get(token);
    if (!bound) return undefined;
    // Keep token for retry of same commit until success; overwrite only on re-bind.
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
      const source = coordinated.native.document!.providers[req.providerId];
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
      const source = coordinated.native.document!.providers[req.providerId];
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

    if (refreshedOnDrift) {
      this.forgetPreview(token);
      return refreshedOnDrift;
    }
    if (result.type === "success") this.forgetPreview(token);
    return result;
  }

  private buildProviderIdentity(snapshot: CoordinatedSnapshot, request: ProviderIdentityRequest): BuildOutcome {
    const native = snapshot.native.document!;
    const source = native.providers[request.providerId];
    if (!source) return { type: "stale-target", path: `providers.${request.providerId}` };

    if (request.kind === "rename" && request.fieldBaselines) {
      const conflict = assertFieldBaselines(
        source as Record<string, unknown>,
        request.fieldBaselines,
        `providers.${request.providerId}`,
      );
      if (conflict) return conflict;
    }

    let next = cloneModels(native);
    let payload = clonePayloadDocument(snapshot.payload.document!);
    const sourceIdentities = collectProviderSourceIdentities(request.providerId, source, snapshot.payload.document!);
    const modelIds = sourceIdentities.map(([, modelId]) => modelId);
    let affected: ModelIdentity[] = [...sourceIdentities];

    if (request.kind === "delete") {
      delete next.providers[request.providerId];
      payload = removeProviderPayloadDocumentValues(payload, request.providerId);
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      return { type: "mutation", native: next, payload, affectedIdentities: affected };
    }

    if (Object.hasOwn(native.providers, request.targetProviderId)) {
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
    next.providers[request.targetProviderId] = providerBody;
    if (request.kind === "rename") delete next.providers[request.providerId];

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
    const provider = native.providers[request.providerId];
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
    const migrateLegacy = request.kind === "rename"
      ? request.migrateLegacyExtraPayload ?? readLegacyExtraPayload(existing)
      : readLegacyExtraPayload(existing);

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
      explicitPayload: request.kind === "rename" && Object.hasOwn(request, "payload") ? request.payload : undefined,
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
