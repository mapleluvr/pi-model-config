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
import {
  cloneOwnJsonData,
  deleteOwnKey,
  getOwnValue,
  hasOwnKey,
  OwnJsonDataError,
  setOwnValue,
  stringifyOwnJsonData,
} from "./own-keys.ts";
import {
  deepEqualJson,
  describeSubtreePresence,
  mergeModelConfig,
  mergeProviderConfig,
  readModelSubtree,
  readProviderSubtree,
  subtreePresenceEqual,
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
import {
  mergeDiscoveredModels,
  normalizeEndpointModels,
  replaceDiscoveredModels,
  summarizeEndpointIds,
  type EndpointDiscoverySuccess,
  type EndpointIdSummary,
} from "./endpoint-models.ts";
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
  | { type: "success" }
  | {
    type: "stale-target";
    nativeHash?: string;
    payloadHash?: string;
    path?: string;
    preview?: IdentityPreviewDescriptor & { token: IdentityPreviewToken };
    endpointPreview?: EndpointPreviewDescriptor & { token: IdentityPreviewToken };
    /** Fresh simple-action resolution token when drift still requires user review. */
    resolutionToken?: IdentityPreviewToken;
    collisions?: ModelIdentity[];
    malformedIdentities?: ModelIdentity[];
  }
  | {
    type: "validation-error";
    issues: ValidationIssue[];
    /** Opaque token when malformed legacy requires explicit discard review. */
    resolutionToken?: IdentityPreviewToken;
    nativeHash?: string;
    payloadHash?: string;
    malformedIdentities?: ModelIdentity[];
  }
  | { type: "subtree-conflict"; path: string; nativeHash: string; payloadHash: string }
  | { type: "native-collision"; target: string }
  | {
    type: "payload-collision";
    collisions: ModelIdentity[];
    affectedIdentities: ModelIdentity[];
    nativeHash: string;
    payloadHash: string;
    scope: "provider" | "model";
    kind: "rename" | "copy" | "delete" | "create" | "models-patch" | "endpoint";
    /** Opaque token bound to the exact collision/legacy set under review. */
    resolutionToken?: IdentityPreviewToken;
    malformedIdentities?: ModelIdentity[];
  }
  | {
    type: "preview";
    token: IdentityPreviewToken;
    affectedIdentities: ModelIdentity[];
    collisions: ModelIdentity[];
    descriptor: IdentityPreviewDescriptor;
  }
  | {
    type: "endpoint-preview";
    token: IdentityPreviewToken;
    descriptor: EndpointPreviewDescriptor;
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

export type EndpointChangeMode = "merge" | "replace";

export interface EndpointChangeRequest {
  providerId: string;
  mode: EndpointChangeMode;
  discovery: EndpointDiscoverySuccess;
}

export interface EndpointPreviewDescriptor {
  source: string;
  mode: EndpointChangeMode;
  validCount: number;
  skippedCount: number;
  duplicateCount: number;
  idSummary: EndpointIdSummary;
  introduced: EndpointIdSummary;
  removed: EndpointIdSummary;
  collisions: ModelIdentity[];
  malformedIdentities: ModelIdentity[];
  nativeHash: string;
  payloadHash: string;
}

export interface EndpointCommitOptions {
  payloadCollisionResolution?: PayloadCollisionResolution;
  legacyDiscardResolution?: LegacyDiscardResolution;
}

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
  | {
    kind: "delete";
    providerId: string;
    legacyDiscardResolution?: LegacyDiscardResolution;
  };

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
  | {
    kind: "delete";
    providerId: string;
    modelId: string;
    legacyDiscardResolution?: LegacyDiscardResolution;
  };

export interface FieldPatchOptions {
  /** Exact per-field baselines captured when the editor opened. Drift on an edited field conflicts. */
  fieldBaselines?: Readonly<Record<string, unknown>>;
  /**
   * Opaque bound token from a prior collision/malformed result.
   * Required together with any payload/legacy resolution; bare resolutions without a token are rejected.
   */
  resolutionToken?: IdentityPreviewToken;
  /** Selected after reviewing a bound collision preview (requires resolutionToken). */
  legacyDiscardResolution?: LegacyDiscardResolution;
  /** Selected after reviewing a bound collision preview (requires resolutionToken). */
  payloadCollisionResolution?: PayloadCollisionResolution;
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
  binding: "identity";
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

type SimpleActionKind = "create-provider" | "create-model" | "patch-provider-models" | "patch-model";

type SimpleBoundRequest =
  | { action: "create-provider"; providerId: string; config: ProviderConfig }
  | {
    action: "create-model";
    providerId: string;
    model: ModelConfig;
    payload?: Record<string, unknown>;
  }
  | {
    action: "patch-provider-models";
    providerId: string;
    patch: ConfigPatch<ProviderConfig>;
    fieldBaselines?: Readonly<Record<string, unknown>>;
  }
  | {
    action: "patch-model";
    providerId: string;
    modelId: string;
    patch: ConfigPatch<ModelConfig>;
    fieldBaselines?: Readonly<Record<string, unknown>>;
    payload?: Record<string, unknown> | null;
    hasExplicitPayload: boolean;
  };

interface BoundSimpleResolution {
  binding: "simple";
  request: SimpleBoundRequest;
  nativeHash: string;
  payloadHash: string;
  collisionSet: string[];
  malformedSet: string[];
  createdAt: number;
}

interface BoundEndpointPreview {
  binding: "endpoint";
  request: EndpointChangeRequest;
  nativeHash: string;
  payloadHash: string;
  introducedSet: string[];
  removedSet: string[];
  collisionSet: string[];
  malformedSet: string[];
  descriptor: EndpointPreviewDescriptor;
  createdAt: number;
}

type BoundBinding = BoundIdentityPreview | BoundSimpleResolution | BoundEndpointPreview;

const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PREVIEWS = 32;

type BuildOutcome =
  | { type: "mutation"; native: ModelsConfig; payload: PayloadConfig; affectedIdentities: ModelIdentity[] }
  | {
    type: "stale-target";
    path?: string;
    simpleBind?: Omit<BoundSimpleResolution, "createdAt" | "binding">;
    collisions?: ModelIdentity[];
    malformedIdentities?: ModelIdentity[];
  }
  | {
    type: "validation-error";
    issues: ValidationIssue[];
    simpleBind?: Omit<BoundSimpleResolution, "createdAt" | "binding">;
  }
  | { type: "subtree-conflict"; path: string }
  | { type: "native-collision"; target: string }
  | {
    type: "payload-collision";
    collisions: ModelIdentity[];
    affectedIdentities: ModelIdentity[];
    scope: "provider" | "model";
    kind: "rename" | "copy" | "delete" | "create" | "models-patch" | "endpoint";
    simpleBind?: Omit<BoundSimpleResolution, "createdAt" | "binding">;
    malformedIdentities?: ModelIdentity[];
  }
  | { type: "unchanged" };

interface EndpointLiveChange {
  candidate: ModelConfig[];
  introducedIds: string[];
  removedIds: string[];
  collisions: ModelIdentity[];
  malformedIdentities: ModelIdentity[];
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function boundedEndpointSource(source: string): string {
  const limit = 512;
  return source.length <= limit ? source : `${source.slice(0, limit - 3)}...`;
}

function normalizedEndpointRequest(request: EndpointChangeRequest): EndpointChangeRequest | undefined {
  if (
    typeof request.providerId !== "string"
    || (request.mode !== "merge" && request.mode !== "replace")
    || !request.discovery
    || typeof request.discovery !== "object"
    || request.discovery.type !== "success"
    || request.discovery.supported !== true
    || typeof request.discovery.source !== "string"
    || !request.discovery.source
    || !Array.isArray(request.discovery.models)
  ) return undefined;

  const normalized = normalizeEndpointModels(request.discovery.models);
  const counts = [
    request.discovery.receivedCount,
    request.discovery.validCount,
    request.discovery.skippedCount,
    request.discovery.duplicateCount,
  ];
  if (
    !normalized.supported
    || normalized.models.length === 0
    || normalized.models.length !== request.discovery.models.length
    || normalized.validCount !== request.discovery.validCount
    || counts.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) return undefined;

  return {
    providerId: request.providerId,
    mode: request.mode,
    discovery: {
      type: "success",
      source: request.discovery.source,
      supported: true,
      receivedCount: request.discovery.receivedCount,
      validCount: normalized.validCount,
      skippedCount: request.discovery.skippedCount,
      duplicateCount: request.discovery.duplicateCount,
      models: normalized.models,
      idSummary: normalized.idSummary,
    },
  };
}

function sortedIdentityKeys(identities: readonly ModelIdentity[]): string[] {
  return identities.map(([p, m]) => identityKey(p, m)).sort();
}

function identitiesFromKeys(keys: readonly string[]): ModelIdentity[] {
  const out: ModelIdentity[] = [];
  for (const key of keys) {
    try {
      const parsed: unknown = JSON.parse(key);
      if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
        out.push([parsed[0], parsed[1]]);
      }
    } catch {
      // ignore
    }
  }
  return out;
}

function setsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface OwnResolutionFields {
  resolutionToken?: IdentityPreviewToken;
  payloadCollisionResolution?: PayloadCollisionResolution;
  legacyDiscardResolution?: LegacyDiscardResolution;
}

/** Read retry choices only from own data properties; inherited/accessor state is never authoritative. */
function ownResolutionFields(options?: object): OwnResolutionFields {
  const own = Object.create(null) as OwnResolutionFields;
  if (!options) return own;
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const copy = (key: keyof OwnResolutionFields): void => {
    const descriptor = descriptors[key];
    if (descriptor?.enumerable && "value" in descriptor) setOwnValue(own, key, descriptor.value);
  };
  copy("resolutionToken");
  copy("payloadCollisionResolution");
  copy("legacyDiscardResolution");
  return own;
}

function cloneOwnOnlyJson<T>(value: T): T {
  return cloneOwnJsonData(value);
}

/** Internal bindings retain explicit undefined baselines without reading hooks. */
function cloneBoundData<T>(value: T, ancestors = new Set<object>()): T {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OwnJsonDataError();
    return value;
  }
  if (typeof value !== "object") throw new OwnJsonDataError();
  if (ancestors.has(value)) throw new OwnJsonDataError();
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).some((symbol) => descriptors[symbol]?.enumerable)) {
      throw new OwnJsonDataError();
    }
    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)) throw new OwnJsonDataError();
      const length = lengthDescriptor.value as number;
      const output: unknown[] = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) throw new OwnJsonDataError();
        output[index] = cloneBoundData(descriptor.value, ancestors);
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length" || /^(0|[1-9]\d*)$/.test(key) || !descriptor.enumerable) continue;
        if (!("value" in descriptor)) throw new OwnJsonDataError();
        setOwnValue(output as unknown as Record<string, unknown>, key, cloneBoundData(descriptor.value, ancestors));
      }
      return output as T;
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new OwnJsonDataError();
      setOwnValue(output, key, cloneBoundData(descriptor.value, ancestors));
    }
    return output as T;
  } finally {
    ancestors.delete(value);
  }
}

function invalidActionInput(): ActionResult {
  return {
    type: "validation-error",
    issues: [{ path: "$", message: "input must contain only own JSON data properties" }],
  };
}

function enumerableDataDescriptors(value: object): Record<PropertyKey, PropertyDescriptor> {
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable) continue;
    if (typeof key === "symbol" || !("value" in descriptor)) throw new OwnJsonDataError();
  }
  return descriptors;
}

/** Baselines use explicit undefined as the sole non-JSON sentinel for absent fields. */
function cloneFieldBaselines(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OwnJsonDataError();
  const descriptors = enumerableDataDescriptors(value);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable) continue;
    const child = descriptor.value;
    setOwnValue(out, key, child === undefined ? undefined : cloneOwnOnlyJson(child));
  }
  return out;
}

function cloneActionOptions<T extends object>(options: T | undefined): T | undefined {
  if (options === undefined) return undefined;
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new OwnJsonDataError();
  const descriptors = enumerableDataDescriptors(options);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable) continue;
    if (key === "fieldBaselines") {
      setOwnValue(out, key, cloneFieldBaselines(descriptor.value));
    } else {
      setOwnValue(out, key, cloneOwnOnlyJson(descriptor.value));
    }
  }
  return out as T;
}

function cloneOptionalActionValue<T>(value: T): T {
  return value === undefined ? value : cloneOwnOnlyJson(value);
}

function presentedResolutionToken(options: unknown): IdentityPreviewToken | undefined {
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(options, "resolutionToken");
  return descriptor?.enumerable === true && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function rejectBareSimpleResolution(options?: object): BuildOutcome | undefined {
  const resolution = ownResolutionFields(options);
  const hasSelected = resolution.payloadCollisionResolution !== undefined
    || resolution.legacyDiscardResolution !== undefined;
  if (hasSelected && !resolution.resolutionToken) {
    return { type: "stale-target", path: "resolution-token" };
  }
  return undefined;
}

/** Strip every prior retry choice onto an own-only request before binding a refreshed preview. */
function clearIdentityResolutions(
  request: ProviderIdentityRequest | ModelIdentityRequest,
): ProviderIdentityRequest | ModelIdentityRequest {
  const next = cloneBoundData(request) as ProviderIdentityRequest | ModelIdentityRequest;
  deleteOwnKey(next, "resolutionToken");
  deleteOwnKey(next, "payloadCollisionResolution");
  deleteOwnKey(next, "legacyDiscardResolution");
  return next;
}

function cloneModels(config: ModelsConfig): ModelsConfig {
  return cloneOwnOnlyJson(config);
}

function identityKey(provider: string, modelId: string): string {
  return stringifyOwnJsonData([provider, modelId]);
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

function providerModels(provider: ProviderConfig): ModelConfig[] {
  const value = getOwnValue<unknown>(provider as Record<string, unknown>, "models");
  return Array.isArray(value) ? value as ModelConfig[] : [];
}

function ownModelId(model: ModelConfig): unknown {
  return getOwnValue<unknown>(model as Record<string, unknown>, "id");
}

function modelIdentitySet(config: ModelsConfig): string[] {
  const ids: string[] = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!hasOwnKey(config.providers, providerId)) continue;
    for (const entry of providerModels(provider)) {
      const id = ownModelId(entry);
      if (typeof id === "string") ids.push(identityKey(providerId, id));
    }
  }
  return ids.sort();
}

function findModelIndex(provider: ProviderConfig, modelId: string): number {
  return providerModels(provider).findIndex((entry) => ownModelId(entry) === modelId);
}

function stripLegacyExtraPayload(model: ModelConfig): ModelConfig {
  const next = cloneOwnOnlyJson(model);
  deleteOwnKey(next as object, "extraPayload");
  return next;
}

/**
 * Legacy native extraPayload is an array of { key, type, value } rows
 * (type: string | bool | json; value always a string). Object shapes are invalid.
 */
export function parseLegacyExtraPayload(
  value: unknown,
): { ok: true; payload: Record<string, unknown>; empty: boolean } | { ok: false; reason: string } {
  // Reasons must stay non-secret and free of private field names (no "extraPayload" / values).
  if (!Array.isArray(value)) return { ok: false, reason: "legacy rows must be an array" };
  // Valid empty row array: strip-only cleanup, never create an empty private identity.
  if (value.length === 0) return { ok: true, payload: {}, empty: true };
  const payload: Record<string, unknown> = {};
  for (const row of value) {
    // Require own key/type/value — never inherit from Object.prototype under polluted {}.row.
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, reason: "legacy row is malformed" };
    }
    if (!hasOwnKey(row, "key") || !hasOwnKey(row, "type") || !hasOwnKey(row, "value")) {
      return { ok: false, reason: "legacy row is malformed" };
    }
    const key = getOwnValue(row as Record<string, unknown>, "key");
    const type = getOwnValue(row as Record<string, unknown>, "type");
    const rowValue = getOwnValue(row as Record<string, unknown>, "value");
    if (typeof key !== "string" || !key.trim() || typeof type !== "string" || typeof rowValue !== "string") {
      return { ok: false, reason: "legacy row is malformed" };
    }
    if (type === "string") {
      setOwnValue(payload, key, rowValue);
    } else if (type === "bool" && (rowValue === "true" || rowValue === "false")) {
      setOwnValue(payload, key, rowValue === "true");
    } else if (type === "json") {
      try {
        setOwnValue(payload, key, JSON.parse(rowValue));
      } catch {
        return { ok: false, reason: "legacy json row is invalid" };
      }
    } else {
      return { ok: false, reason: "legacy row type is unsupported" };
    }
  }
  const keys = Object.keys(payload);
  return { ok: true, payload, empty: keys.length === 0 };
}

type LegacyRead =
  | { kind: "none" }
  | { kind: "empty" }
  | { kind: "valid"; payload: Record<string, unknown> }
  | { kind: "invalid"; reason: string };

function readLegacyExtraPayload(model: ModelConfig): LegacyRead {
  if (!hasOwnKey(model as object, "extraPayload")) return { kind: "none" };
  const legacy = getOwnValue(model as Record<string, unknown>, "extraPayload");
  const parsed = parseLegacyExtraPayload(legacy);
  if (!parsed.ok) return { kind: "invalid", reason: parsed.reason };
  if (parsed.empty) return { kind: "empty" };
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

function ownOnlyActionSnapshot(coordinated: CoordinatedSnapshot): CoordinatedSnapshot {
  return {
    ...coordinated,
    native: {
      ...coordinated.native,
      document: coordinated.native.document === undefined ? undefined : cloneModels(coordinated.native.document),
    },
    payload: {
      ...coordinated.payload,
      document: coordinated.payload.document === undefined
        ? undefined
        : clonePayloadDocument(coordinated.payload.document),
    },
  };
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
  const ids: string[] = [];
  for (const entry of providerModels(provider)) {
    const id = ownModelId(entry);
    if (typeof id === "string") ids.push(id);
  }
  return ids;
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
      payload = setPayloadDocumentValue(payload, args.toProvider, args.toModelId, cloneOwnOnlyJson(args.explicitPayload));
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
      payload = setPayloadDocumentValue(payload, args.toProvider, args.toModelId, cloneOwnOnlyJson(args.migrateLegacy));
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
  const next = cloneOwnOnlyJson(provider);
  if (hasOwnKey(next as object, "models")) {
    setOwnValue(
      next as Record<string, unknown>,
      "models",
      providerModels(next).map((model) => stripLegacyExtraPayload(model)),
    );
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
  for (const model of providerModels(provider)) {
    const issue = rejectMalformedLegacyUnlessDiscarded(
      model,
      `${pathPrefix}.models[id=${String(ownModelId(model) ?? "")}].legacy`,
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
    const sourceModel = providerModels(provider).find((entry) => ownModelId(entry) === modelId);
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
  private readonly previews = new Map<string, BoundBinding>();
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

  /** Test/introspection: number of currently retained bound previews/resolutions (does not force prune). */
  boundPreviewCount(): number {
    return this.previews.size;
  }

  /** Explicit discard for simple-action resolution tokens (alias of discardIdentityPreview). */
  discardResolutionToken(token: IdentityPreviewToken): void {
    this.discardIdentityPreview(token);
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
    if (
      coordinated.native.parseState === "malformed"
      || coordinated.payload.parseState === "malformed"
      || coordinated.journal.parseState !== "missing"
    ) {
      return { type: "recovery-required" };
    }
    return snapshotFrom(coordinated);
  }

  async previewEndpointChange(request: EndpointChangeRequest): Promise<ActionResult> {
    try {
      request = cloneActionOptions(request)!;
    } catch {
      return invalidActionInput();
    }
    const normalized = normalizedEndpointRequest(request);
    if (!normalized) return invalidActionInput();

    let snapshot: CoordinatedSnapshot;
    try {
      snapshot = ownOnlyActionSnapshot(readCoordinatedSnapshot(coordinatorOptions(this.options)));
    } catch {
      return { type: "recovery-required" };
    }
    const blocked = ensureReady(snapshot);
    if (blocked) return blocked;
    const live = this.inspectEndpointChange(snapshot, normalized);
    if (!live) {
      return {
        type: "stale-target",
        nativeHash: snapshot.native.hash,
        payloadHash: snapshot.payload.hash,
        path: `providers.${normalized.providerId}`,
      };
    }
    const descriptor = this.endpointDescriptor(snapshot, normalized, live);
    const token = this.bindEndpoint({
      request: normalized,
      nativeHash: snapshot.native.hash,
      payloadHash: snapshot.payload.hash,
      introducedSet: sortedStrings(live.introducedIds),
      removedSet: sortedStrings(live.removedIds),
      collisionSet: sortedIdentityKeys(live.collisions),
      malformedSet: sortedIdentityKeys(live.malformedIdentities),
      descriptor,
    });
    return { type: "endpoint-preview", token, descriptor };
  }

  async commitEndpointChange(
    token: IdentityPreviewToken,
    options?: EndpointCommitOptions,
  ): Promise<ActionResult> {
    const bound = this.takeEndpoint(token);
    if (!bound) return { type: "stale-target", path: "endpoint-preview" };

    try {
      options = cloneActionOptions(options);
    } catch {
      return invalidActionInput();
    }
    if (
      options?.payloadCollisionResolution !== undefined
      && options.payloadCollisionResolution !== "reuse-target"
      && options.payloadCollisionResolution !== "replace-target"
    ) return invalidActionInput();
    if (
      options?.legacyDiscardResolution !== undefined
      && options.legacyDiscardResolution !== "discard-malformed-legacy"
    ) return invalidActionInput();

    let refreshed: ActionResult | undefined;
    try {
      const result = await this.run((snapshot) => {
        const live = this.inspectEndpointChange(snapshot, bound.request);
        if (!live) return { type: "stale-target", path: `providers.${bound.request.providerId}` };
        const introducedSet = sortedStrings(live.introducedIds);
        const removedSet = sortedStrings(live.removedIds);
        const collisionSet = sortedIdentityKeys(live.collisions);
        const malformedSet = sortedIdentityKeys(live.malformedIdentities);
        if (
          snapshot.native.hash !== bound.nativeHash
          || snapshot.payload.hash !== bound.payloadHash
          || !setsEqual(introducedSet, bound.introducedSet)
          || !setsEqual(removedSet, bound.removedSet)
          || !setsEqual(collisionSet, bound.collisionSet)
          || !setsEqual(malformedSet, bound.malformedSet)
        ) {
          const descriptor = this.endpointDescriptor(snapshot, bound.request, live);
          const nextToken = this.bindEndpoint({
            request: bound.request,
            nativeHash: snapshot.native.hash,
            payloadHash: snapshot.payload.hash,
            introducedSet,
            removedSet,
            collisionSet,
            malformedSet,
            descriptor,
          });
          refreshed = {
            type: "stale-target",
            nativeHash: snapshot.native.hash,
            payloadHash: snapshot.payload.hash,
            path: "endpoint-preview",
            endpointPreview: { ...descriptor, token: nextToken },
          };
          return { type: "stale-target", path: "endpoint-preview" };
        }
        return this.buildEndpointMutation(snapshot, bound.request, live, options);
      });
      return refreshed ?? result;
    } finally {
      this.forgetPreview(token);
    }
  }

  private inspectEndpointChange(
    snapshot: CoordinatedSnapshot,
    request: EndpointChangeRequest,
  ): EndpointLiveChange | undefined {
    const provider = getProvider(snapshot.native.document!, request.providerId);
    if (!provider) return undefined;
    const existing = providerModels(provider);
    const candidate = request.mode === "merge"
      ? mergeDiscoveredModels(existing, request.discovery.models)
      : replaceDiscoveredModels(existing, request.discovery.models);
    const oldIds = new Set(existing.map((model) => model.id));
    const candidateIds = new Set(candidate.map((model) => model.id));
    const introducedIds = candidate.filter((model) => !oldIds.has(model.id)).map((model) => model.id);
    const removedIds = request.mode === "replace"
      ? existing.filter((model) => !candidateIds.has(model.id)).map((model) => model.id)
      : [];
    const collisions = targetPayloadCollisions(
      snapshot.payload.document!,
      introducedIds.map((id) => [request.providerId, id] as ModelIdentity),
      new Set(),
    );
    const removedSet = new Set(removedIds);
    const malformedIdentities: ModelIdentity[] = [];
    for (const model of existing) {
      if (!removedSet.has(model.id)) continue;
      if (readLegacyExtraPayload(model).kind === "invalid") {
        malformedIdentities.push([request.providerId, model.id]);
      }
    }
    return { candidate, introducedIds, removedIds, collisions, malformedIdentities };
  }

  private endpointDescriptor(
    snapshot: CoordinatedSnapshot,
    request: EndpointChangeRequest,
    live: EndpointLiveChange,
  ): EndpointPreviewDescriptor {
    return {
      source: boundedEndpointSource(request.discovery.source),
      mode: request.mode,
      validCount: request.discovery.validCount,
      skippedCount: request.discovery.skippedCount,
      duplicateCount: request.discovery.duplicateCount,
      idSummary: summarizeEndpointIds(request.discovery.models.map((model) => model.id)),
      introduced: summarizeEndpointIds(live.introducedIds),
      removed: summarizeEndpointIds(live.removedIds),
      collisions: live.collisions.map((identity) => [identity[0], identity[1]] as ModelIdentity),
      malformedIdentities: live.malformedIdentities.map((identity) => [identity[0], identity[1]] as ModelIdentity),
      nativeHash: snapshot.native.hash,
      payloadHash: snapshot.payload.hash,
    };
  }

  private buildEndpointMutation(
    snapshot: CoordinatedSnapshot,
    request: EndpointChangeRequest,
    live: EndpointLiveChange,
    options?: EndpointCommitOptions,
  ): BuildOutcome {
    if (
      live.collisions.length > 0
      && options?.payloadCollisionResolution !== "reuse-target"
      && options?.payloadCollisionResolution !== "replace-target"
    ) {
      return {
        type: "payload-collision",
        collisions: live.collisions,
        affectedIdentities: live.collisions,
        scope: "provider",
        kind: "endpoint",
      };
    }
    if (
      live.malformedIdentities.length > 0
      && options?.legacyDiscardResolution !== "discard-malformed-legacy"
    ) {
      return {
        type: "validation-error",
        issues: live.malformedIdentities.map(([providerId, modelId]) => ({
          path: `$.providers.${providerId}.models[id=${modelId}].legacy`,
          message: "malformed legacy rows require explicit discard",
        })),
      };
    }

    const next = cloneModels(snapshot.native.document!);
    const nextProvider = getProvider(next, request.providerId);
    if (!nextProvider) return { type: "stale-target", path: `providers.${request.providerId}` };
    nextProvider.models = live.candidate.map((model) => cloneOwnOnlyJson(model));
    const issues = validateOrIssues(next, this.options.validation);
    if (issues.length > 0) return { type: "validation-error", issues };

    let payload = clonePayloadDocument(snapshot.payload.document!);
    for (const modelId of live.removedIds) {
      payload = removePayloadDocumentValue(payload, request.providerId, modelId);
    }
    if (options?.payloadCollisionResolution === "replace-target") {
      for (const [, modelId] of live.collisions) {
        payload = removePayloadDocumentValue(payload, request.providerId, modelId);
      }
    }
    const affected = new Map<string, ModelIdentity>();
    for (const modelId of [...live.introducedIds, ...live.removedIds]) {
      affected.set(identityKey(request.providerId, modelId), [request.providerId, modelId]);
    }
    return { type: "mutation", native: next, payload, affectedIdentities: [...affected.values()] };
  }

  async patchProvider(
    providerId: string,
    patch: ConfigPatch<ProviderConfig>,
    options?: FieldPatchOptions,
  ): Promise<ActionResult> {
    const terminalToken = presentedResolutionToken(options);
    const terminalBound = terminalToken ? this.takeSimple(terminalToken) : undefined;
    try {
      patch = cloneOwnOnlyJson(patch);
      options = cloneActionOptions(options);
    } catch {
      return invalidActionInput();
    }
    return this.run((snapshot) => {
      const existing = getProvider(snapshot.native.document!, providerId);
      if (!existing) return { type: "stale-target", path: `providers.${providerId}` };
      const baselineConflict = assertFieldBaselines(
        existing as Record<string, unknown>,
        options?.fieldBaselines,
        `providers.${providerId}`,
      );
      if (baselineConflict) return baselineConflict;

      if (hasOwnKey(patch, "models")) {
        return this.buildProviderModelsPatch(snapshot, providerId, existing, patch, options, terminalBound);
      }

      // Ordinary non-models patch must never accept own simple resolution flags/tokens.
      const resolution = ownResolutionFields(options);
      if (
        resolution.resolutionToken !== undefined
        || resolution.payloadCollisionResolution !== undefined
        || resolution.legacyDiscardResolution !== undefined
      ) {
        return { type: "stale-target", path: "resolution-token" };
      }

      const next = cloneModels(snapshot.native.document!);
      setProvider(next, providerId, mergeProviderConfig(existing, stripModelsFromProviderPatch(patch)));
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
    const terminalToken = presentedResolutionToken(options);
    const terminalBound = terminalToken ? this.takeSimple(terminalToken) : undefined;
    try {
      patch = cloneOwnOnlyJson(patch);
      options = cloneActionOptions(options);
    } catch {
      return invalidActionInput();
    }
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

      const bare = rejectBareSimpleResolution(options);
      if (bare) return bare;
      const resolution = ownResolutionFields(options);

      let effectiveProviderId = providerId;
      let effectiveModelId = modelId;
      let effectivePatch = patch;
      let effectiveExisting = existing;
      let effectiveIndex = index;
      let hasExplicitPayload = options !== undefined && hasOwnKey(options, "payload");
      let explicitPayload = options !== undefined && hasOwnKey(options, "payload")
        ? getOwnValue<Record<string, unknown> | null>(options, "payload")
        : undefined;
      let legacyResolution = resolution.legacyDiscardResolution;

      if (resolution.resolutionToken) {
        const bound = terminalBound;
        if (!bound || bound.request.action !== "patch-model") {
          return { type: "stale-target", path: "resolution-token" };
        }
        effectiveProviderId = bound.request.providerId;
        effectiveModelId = bound.request.modelId;
        effectivePatch = bound.request.patch;
        hasExplicitPayload = bound.request.hasExplicitPayload;
        explicitPayload = bound.request.payload;
        const providerNow = getProvider(snapshot.native.document!, effectiveProviderId);
        if (!providerNow) return { type: "stale-target", path: `providers.${effectiveProviderId}` };
        const idxNow = findModelIndex(providerNow, effectiveModelId);
        if (idxNow < 0) return { type: "stale-target", path: `providers.${effectiveProviderId}.models:${effectiveModelId}` };
        effectiveExisting = providerNow.models![idxNow]!;
        effectiveIndex = idxNow;
        const live = this.inspectPatchModel(snapshot, effectiveProviderId, effectiveModelId, effectiveExisting);
        if (
          snapshot.native.hash !== bound.nativeHash
          || snapshot.payload.hash !== bound.payloadHash
          || !setsEqual(live.malformedSet, bound.malformedSet)
        ) {
          return this.simpleDriftResult(snapshot, {
            action: "patch-model",
            providerId: effectiveProviderId,
            modelId: effectiveModelId,
            patch: effectivePatch,
            fieldBaselines: bound.request.fieldBaselines,
            payload: explicitPayload,
            hasExplicitPayload,
          }, live);
        }
        if (live.malformedSet.length > 0 && legacyResolution !== "discard-malformed-legacy") {
          return this.simpleDriftResult(snapshot, {
            action: "patch-model",
            providerId: effectiveProviderId,
            modelId: effectiveModelId,
            patch: effectivePatch,
            payload: explicitPayload,
            hasExplicitPayload,
          }, live);
        }
      } else {
        const live = this.inspectPatchModel(snapshot, providerId, modelId, existing);
        if (live.malformedSet.length > 0) {
          return this.simpleNeedsResolution(snapshot, {
            action: "patch-model",
            providerId,
            modelId,
            patch,
            fieldBaselines: options?.fieldBaselines,
            payload: options?.payload,
            hasExplicitPayload,
          }, live, "model", "create");
        }
      }

      const legacyRead = readLegacyExtraPayload(effectiveExisting);
      const next = cloneModels(snapshot.native.document!);
      const nextProvider = getProvider(next, effectiveProviderId)!;
      const merged = mergeModelConfig(effectiveExisting, effectivePatch);
      nextProvider.models = [...(nextProvider.models ?? [])];
      nextProvider.models[effectiveIndex] = stripLegacyExtraPayload(merged);
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      let payload = clonePayloadDocument(snapshot.payload.document!);
      const affected: ModelIdentity[] = [];
      const privateExists = lookupModelPayload(payload, effectiveProviderId, effectiveModelId) !== undefined;
      if (hasExplicitPayload) {
        if (explicitPayload === null || explicitPayload === undefined) {
          payload = removePayloadDocumentValue(payload, effectiveProviderId, effectiveModelId);
        } else {
          payload = setPayloadDocumentValue(payload, effectiveProviderId, effectiveModelId, explicitPayload);
        }
        affected.push([effectiveProviderId, effectiveModelId]);
      } else if (legacyRead.kind === "valid" && !privateExists) {
        payload = setPayloadDocumentValue(payload, effectiveProviderId, effectiveModelId, legacyRead.payload);
        affected.push([effectiveProviderId, effectiveModelId]);
      } else if (legacyRead.kind === "valid" || legacyRead.kind === "empty" || legacyRead.kind === "invalid") {
        affected.push([effectiveProviderId, effectiveModelId]);
      }
      return { type: "mutation", native: next, payload, affectedIdentities: affected };
    });
  }

  async createProvider(
    providerId: string,
    config: ProviderConfig,
    options?: {
      resolutionToken?: IdentityPreviewToken;
      payloadCollisionResolution?: PayloadCollisionResolution;
      legacyDiscardResolution?: LegacyDiscardResolution;
    },
  ): Promise<ActionResult> {
    const terminalToken = presentedResolutionToken(options);
    const terminalBound = terminalToken ? this.takeSimple(terminalToken) : undefined;
    try {
      config = cloneOwnOnlyJson(config);
      options = cloneActionOptions(options);
    } catch {
      return invalidActionInput();
    }
    return this.run((snapshot) => {
      const bare = rejectBareSimpleResolution(options);
      if (bare) return bare;
      const resolution = ownResolutionFields(options);

      let effectiveProviderId = providerId;
      let effectiveConfig = config;
      let payloadResolution = resolution.payloadCollisionResolution;
      let legacyResolution = resolution.legacyDiscardResolution;

      if (resolution.resolutionToken) {
        const bound = terminalBound;
        if (!bound || bound.request.action !== "create-provider") {
          return { type: "stale-target", path: "resolution-token" };
        }
        effectiveProviderId = bound.request.providerId;
        effectiveConfig = bound.request.config;
        const live = this.inspectCreateProvider(snapshot, effectiveProviderId, effectiveConfig);
        if (
          snapshot.native.hash !== bound.nativeHash
          || snapshot.payload.hash !== bound.payloadHash
          || !setsEqual(live.collisionSet, bound.collisionSet)
          || !setsEqual(live.malformedSet, bound.malformedSet)
        ) {
          return this.simpleDriftResult(snapshot, {
            action: "create-provider",
            providerId: effectiveProviderId,
            config: effectiveConfig,
          }, live);
        }
        if (live.malformedSet.length > 0 && legacyResolution !== "discard-malformed-legacy") {
          return this.simpleDriftResult(snapshot, {
            action: "create-provider",
            providerId: effectiveProviderId,
            config: effectiveConfig,
          }, live);
        }
        if (live.collisionSet.length > 0 && payloadResolution !== "replace-target" && payloadResolution !== "reuse-target") {
          return this.simpleDriftResult(snapshot, {
            action: "create-provider",
            providerId: effectiveProviderId,
            config: effectiveConfig,
          }, live);
        }
      } else {
        const live = this.inspectCreateProvider(snapshot, effectiveProviderId, effectiveConfig);
        if (live.malformedSet.length > 0 || live.collisionSet.length > 0) {
          return this.simpleNeedsResolution(snapshot, {
            action: "create-provider",
            providerId: effectiveProviderId,
            config: effectiveConfig,
          }, live, "provider", "create");
        }
      }

      if (hasProvider(snapshot.native.document!, effectiveProviderId)) {
        return { type: "native-collision", target: effectiveProviderId };
      }
      const introduced = (effectiveConfig.models ?? []).map((entry) => [effectiveProviderId, entry.id] as ModelIdentity);
      const collisions = targetPayloadCollisions(snapshot.payload.document!, introduced, new Set());
      const collisionKeys = new Set(collisions.map(([p, m]) => identityKey(p, m)));
      const next = cloneModels(snapshot.native.document!);
      setProvider(next, effectiveProviderId, stripExtraPayloadFromProviderModels(cloneOwnOnlyJson(effectiveConfig)));
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      let payload = clonePayloadDocument(snapshot.payload.document!);
      const affected: ModelIdentity[] = [];
      for (const model of effectiveConfig.models ?? []) {
        const key = identityKey(effectiveProviderId, model.id);
        const targetExists = collisionKeys.has(key);
        const legacyRead = readLegacyExtraPayload(model);
        const legacy = legacyRead.kind === "valid" ? legacyRead.payload : undefined;
        if (payloadResolution === "reuse-target" && targetExists) {
          affected.push([effectiveProviderId, model.id]);
          continue;
        }
        if (payloadResolution === "replace-target" && targetExists) {
          if (legacy) {
            payload = setPayloadDocumentValue(payload, effectiveProviderId, model.id, legacy);
          } else {
            payload = removePayloadDocumentValue(payload, effectiveProviderId, model.id);
          }
          affected.push([effectiveProviderId, model.id]);
          continue;
        }
        if (!targetExists && legacy) {
          payload = setPayloadDocumentValue(payload, effectiveProviderId, model.id, legacy);
          affected.push([effectiveProviderId, model.id]);
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
      resolutionToken?: IdentityPreviewToken;
      payloadCollisionResolution?: PayloadCollisionResolution;
      legacyDiscardResolution?: LegacyDiscardResolution;
    },
  ): Promise<ActionResult> {
    const terminalToken = presentedResolutionToken(options);
    const terminalBound = terminalToken ? this.takeSimple(terminalToken) : undefined;
    try {
      model = cloneOwnOnlyJson(model);
      options = cloneActionOptions(options);
    } catch {
      return invalidActionInput();
    }
    return this.run((snapshot) => {
      const bare = rejectBareSimpleResolution(options);
      if (bare) return bare;
      const resolution = ownResolutionFields(options);

      let effectiveProviderId = providerId;
      let effectiveModel = model;
      let explicitPayload = options !== undefined && hasOwnKey(options, "payload")
        ? getOwnValue<Record<string, unknown>>(options, "payload")
        : undefined;
      let hasExplicitPayload = options !== undefined && hasOwnKey(options, "payload");
      let payloadResolution = resolution.payloadCollisionResolution;
      let legacyResolution = resolution.legacyDiscardResolution;

      if (resolution.resolutionToken) {
        const bound = terminalBound;
        if (!bound || bound.request.action !== "create-model") {
          return { type: "stale-target", path: "resolution-token" };
        }
        effectiveProviderId = bound.request.providerId;
        effectiveModel = bound.request.model;
        hasExplicitPayload = bound.request.payload !== undefined;
        explicitPayload = bound.request.payload;
        const live = this.inspectCreateModel(snapshot, effectiveProviderId, effectiveModel);
        if (
          snapshot.native.hash !== bound.nativeHash
          || snapshot.payload.hash !== bound.payloadHash
          || !setsEqual(live.collisionSet, bound.collisionSet)
          || !setsEqual(live.malformedSet, bound.malformedSet)
        ) {
          return this.simpleDriftResult(snapshot, {
            action: "create-model",
            providerId: effectiveProviderId,
            model: effectiveModel,
            payload: explicitPayload,
          }, live);
        }
        if (live.malformedSet.length > 0 && legacyResolution !== "discard-malformed-legacy") {
          return this.simpleDriftResult(snapshot, {
            action: "create-model",
            providerId: effectiveProviderId,
            model: effectiveModel,
            payload: explicitPayload,
          }, live);
        }
        if (live.collisionSet.length > 0 && payloadResolution !== "replace-target" && payloadResolution !== "reuse-target") {
          return this.simpleDriftResult(snapshot, {
            action: "create-model",
            providerId: effectiveProviderId,
            model: effectiveModel,
            payload: explicitPayload,
          }, live);
        }
      } else {
        const live = this.inspectCreateModel(snapshot, effectiveProviderId, effectiveModel);
        if (live.malformedSet.length > 0 || live.collisionSet.length > 0) {
          return this.simpleNeedsResolution(snapshot, {
            action: "create-model",
            providerId: effectiveProviderId,
            model: effectiveModel,
            payload: explicitPayload,
          }, live, "model", "create");
        }
      }

      const provider = getProvider(snapshot.native.document!, effectiveProviderId);
      if (!provider) return { type: "stale-target", path: `providers.${effectiveProviderId}` };
      if (findModelIndex(provider, effectiveModel.id) >= 0) {
        return { type: "native-collision", target: effectiveModel.id };
      }
      const legacyRead = readLegacyExtraPayload(effectiveModel);
      const collisions = targetPayloadCollisions(
        snapshot.payload.document!,
        [[effectiveProviderId, effectiveModel.id]],
        new Set(),
      );
      const next = cloneModels(snapshot.native.document!);
      const nextProvider = getProvider(next, effectiveProviderId)!;
      nextProvider.models = [...providerModels(nextProvider), stripLegacyExtraPayload(cloneOwnOnlyJson(effectiveModel))];
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      let payload = clonePayloadDocument(snapshot.payload.document!);
      const affected: ModelIdentity[] = [];
      const targetExists = collisions.length > 0;
      if (payloadResolution === "reuse-target" && targetExists) {
        affected.push([effectiveProviderId, effectiveModel.id]);
      } else if (hasExplicitPayload) {
        if (explicitPayload === undefined) {
          payload = removePayloadDocumentValue(payload, effectiveProviderId, effectiveModel.id);
        } else {
          payload = setPayloadDocumentValue(payload, effectiveProviderId, effectiveModel.id, explicitPayload);
        }
        affected.push([effectiveProviderId, effectiveModel.id]);
      } else if (payloadResolution === "replace-target" && targetExists) {
        if (legacyRead.kind === "valid") {
          payload = setPayloadDocumentValue(payload, effectiveProviderId, effectiveModel.id, legacyRead.payload);
        } else {
          payload = removePayloadDocumentValue(payload, effectiveProviderId, effectiveModel.id);
        }
        affected.push([effectiveProviderId, effectiveModel.id]);
      } else if (legacyRead.kind === "valid" && !targetExists) {
        payload = setPayloadDocumentValue(payload, effectiveProviderId, effectiveModel.id, legacyRead.payload);
        affected.push([effectiveProviderId, effectiveModel.id]);
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
    try {
      baseline = cloneOptionalActionValue(baseline);
      nextValue = cloneOptionalActionValue(nextValue);
    } catch {
      return invalidActionInput();
    }
    return this.run((snapshot) => {
      const provider = getProvider(snapshot.native.document!, providerId);
      if (!provider) return { type: "stale-target", path: `providers.${providerId}` };
      const current = Object.hasOwn(provider as object, key)
        ? (provider as Record<string, unknown>)[key]
        : undefined;
      if (!subtreePresenceEqual(describeSubtreePresence(current), describeSubtreePresence(baseline))) {
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
    try {
      baseline = cloneOptionalActionValue(baseline);
      nextValue = cloneOptionalActionValue(nextValue);
    } catch {
      return invalidActionInput();
    }
    return this.run((snapshot) => {
      const provider = getProvider(snapshot.native.document!, providerId);
      if (!provider) return { type: "stale-target", path: `providers.${providerId}` };
      const index = findModelIndex(provider, modelId);
      if (index < 0) return { type: "stale-target", path: `providers.${providerId}.models:${modelId}` };
      const model = provider.models![index]!;
      const current = Object.hasOwn(model as object, key)
        ? (model as Record<string, unknown>)[key]
        : undefined;
      if (!subtreePresenceEqual(describeSubtreePresence(current), describeSubtreePresence(baseline))) {
        return { type: "subtree-conflict", path: `providers.${providerId}.models.${modelId}.${key}` };
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
    try {
      baseline = cloneOptionalActionValue(baseline);
      nextValue = cloneOptionalActionValue(nextValue);
    } catch {
      return invalidActionInput();
    }
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
    return this.commitIdentity("provider", token);
  }

  async previewModelIdentityAction(request: ModelIdentityRequest): Promise<ActionResult> {
    return this.previewIdentity("model", request);
  }

  async commitModelIdentityAction(token: IdentityPreviewToken): Promise<ActionResult> {
    return this.commitIdentity("model", token);
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

  private bindPreview(bound: Omit<BoundIdentityPreview, "createdAt" | "binding">): IdentityPreviewToken {
    this.prunePreviews();
    const token = randomUUID();
    this.previews.set(token, {
      binding: "identity",
      ...bound,
      request: cloneBoundData(bound.request),
      collisions: bound.collisions.map((entry) => [entry[0], entry[1]] as ModelIdentity),
      affectedIdentities: bound.affectedIdentities.map((entry) => [entry[0], entry[1]] as ModelIdentity),
      identitySet: [...bound.identitySet],
      descriptor: cloneBoundData(bound.descriptor),
      createdAt: this.now(),
    });
    this.prunePreviews();
    this.rescheduleExpiry();
    return token;
  }

  private bindSimple(bound: Omit<BoundSimpleResolution, "createdAt" | "binding">): IdentityPreviewToken {
    this.prunePreviews();
    const token = randomUUID();
    this.previews.set(token, {
      binding: "simple",
      request: cloneBoundData(bound.request),
      nativeHash: bound.nativeHash,
      payloadHash: bound.payloadHash,
      collisionSet: [...bound.collisionSet],
      malformedSet: [...bound.malformedSet],
      createdAt: this.now(),
    });
    this.prunePreviews();
    this.rescheduleExpiry();
    return token;
  }

  private bindEndpoint(
    bound: Omit<BoundEndpointPreview, "createdAt" | "binding">,
  ): IdentityPreviewToken {
    this.prunePreviews();
    const token = randomUUID();
    this.previews.set(token, {
      binding: "endpoint",
      request: cloneBoundData(bound.request),
      nativeHash: bound.nativeHash,
      payloadHash: bound.payloadHash,
      introducedSet: [...bound.introducedSet],
      removedSet: [...bound.removedSet],
      collisionSet: [...bound.collisionSet],
      malformedSet: [...bound.malformedSet],
      descriptor: cloneBoundData(bound.descriptor),
      createdAt: this.now(),
    });
    this.prunePreviews();
    this.rescheduleExpiry();
    return token;
  }

  /** Consumes a token before checking whether it is an endpoint binding. */
  private takeEndpoint(token: IdentityPreviewToken): BoundEndpointPreview | undefined {
    this.prunePreviews();
    const bound = this.previews.get(token);
    this.previews.delete(token);
    this.rescheduleExpiry();
    if (!bound || bound.binding !== "endpoint") return undefined;
    if (this.now() - bound.createdAt >= this.previewTtlMs) return undefined;
    return {
      ...bound,
      request: cloneBoundData(bound.request),
      introducedSet: [...bound.introducedSet],
      removedSet: [...bound.removedSet],
      collisionSet: [...bound.collisionSet],
      malformedSet: [...bound.malformedSet],
      descriptor: cloneBoundData(bound.descriptor),
    };
  }

  private takeBound(
    token: IdentityPreviewToken,
    expectedScope: "provider" | "model",
  ): BoundIdentityPreview | undefined {
    this.prunePreviews();
    const bound = this.previews.get(token);
    // Every terminal attempt consumes atomically before binding/scope/type checks.
    this.previews.delete(token);
    this.rescheduleExpiry();
    if (!bound || bound.binding !== "identity" || bound.scope !== expectedScope) return undefined;
    if (this.now() - bound.createdAt >= this.previewTtlMs) return undefined;
    return {
      ...bound,
      request: cloneBoundData(bound.request),
      collisions: bound.collisions.map((entry) => [entry[0], entry[1]] as ModelIdentity),
      affectedIdentities: bound.affectedIdentities.map((entry) => [entry[0], entry[1]] as ModelIdentity),
      identitySet: [...bound.identitySet],
      descriptor: cloneBoundData(bound.descriptor),
    };
  }

  /** Consumes a token before checking whether it is a simple binding. */
  private takeSimple(token: IdentityPreviewToken): BoundSimpleResolution | undefined {
    this.prunePreviews();
    const bound = this.previews.get(token);
    this.previews.delete(token);
    this.rescheduleExpiry();
    if (!bound || bound.binding !== "simple") return undefined;
    if (this.now() - bound.createdAt >= this.previewTtlMs) return undefined;
    return {
      ...bound,
      request: cloneBoundData(bound.request),
      collisionSet: [...bound.collisionSet],
      malformedSet: [...bound.malformedSet],
    };
  }

  private forgetPreview(token: IdentityPreviewToken): void {
    this.previews.delete(token);
    this.rescheduleExpiry();
  }

  private attachSimpleToken(outcome: BuildOutcome): ActionResult {
    if (outcome.type === "payload-collision") {
      const token = outcome.simpleBind ? this.bindSimple(outcome.simpleBind) : undefined;
      return {
        type: "payload-collision",
        collisions: outcome.collisions,
        affectedIdentities: outcome.affectedIdentities,
        nativeHash: outcome.simpleBind?.nativeHash ?? "",
        payloadHash: outcome.simpleBind?.payloadHash ?? "",
        scope: outcome.scope,
        kind: outcome.kind,
        resolutionToken: token,
        malformedIdentities: outcome.malformedIdentities,
      };
    }
    if (outcome.type === "validation-error") {
      const token = outcome.simpleBind ? this.bindSimple(outcome.simpleBind) : undefined;
      return {
        type: "validation-error",
        issues: outcome.issues,
        resolutionToken: token,
        nativeHash: outcome.simpleBind?.nativeHash,
        payloadHash: outcome.simpleBind?.payloadHash,
        malformedIdentities: outcome.simpleBind
          ? identitiesFromKeys(outcome.simpleBind.malformedSet)
          : undefined,
      };
    }
    if (outcome.type === "stale-target") {
      const token = outcome.simpleBind ? this.bindSimple(outcome.simpleBind) : undefined;
      return {
        type: "stale-target",
        path: outcome.path,
        nativeHash: outcome.simpleBind?.nativeHash,
        payloadHash: outcome.simpleBind?.payloadHash,
        resolutionToken: token,
        collisions: outcome.collisions,
        malformedIdentities: outcome.malformedIdentities,
      };
    }
    if (outcome.type === "native-collision") return outcome;
    if (outcome.type === "subtree-conflict") {
      return { type: "subtree-conflict", path: outcome.path, nativeHash: "", payloadHash: "" };
    }
    return { type: "stale-target" };
  }

  private async previewIdentity(
    scope: "provider" | "model",
    request: ProviderIdentityRequest | ModelIdentityRequest,
  ): Promise<ActionResult> {
    try {
      request = cloneActionOptions(request)!;
    } catch {
      return invalidActionInput();
    }
    let coordinated: CoordinatedSnapshot;
    try {
      coordinated = ownOnlyActionSnapshot(readCoordinatedSnapshot(coordinatorOptions(this.options)));
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
      request: cloneBoundData(request),
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

  private async commitIdentity(
    expectedScope: "provider" | "model",
    token: IdentityPreviewToken,
  ): Promise<ActionResult> {
    const bound = this.takeBound(token, expectedScope);
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
        // Clear prior resolutions so a refreshed token cannot silently apply an old choice.
        const clearedRequest = clearIdentityResolutions(bound.request);
        const rebuilt = bound.scope === "provider"
          ? this.buildProviderIdentity(snapshot, clearedRequest as ProviderIdentityRequest)
          : this.buildModelIdentity(snapshot, clearedRequest as ModelIdentityRequest);
        const affected = rebuilt.type === "mutation"
          ? rebuilt.affectedIdentities
          : this.previewAffected(bound.scope, clearedRequest, snapshot);
        const collisions = this.resolvedCollisions(bound.scope, clearedRequest, snapshot);
        const identitySetNow = bound.scope === "provider"
          ? providerIdentitySet(snapshot.native.document!)
          : modelIdentitySet(snapshot.native.document!);
        const descriptor = this.descriptorFor(
          bound.scope,
          clearedRequest,
          snapshot.native.hash,
          snapshot.payload.hash,
          affected,
          collisions,
        );
        const newToken = this.bindPreview({
          scope: bound.scope,
          request: cloneOwnOnlyJson(clearedRequest),
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

  private inspectCreateProvider(
    snapshot: CoordinatedSnapshot,
    providerId: string,
    config: ProviderConfig,
  ): { collisionSet: string[]; malformedSet: string[]; collisions: ModelIdentity[]; malformed: ModelIdentity[]; issues: ValidationIssue[] } {
    const malformed: ModelIdentity[] = [];
    const issues: ValidationIssue[] = [];
    for (const model of config.models ?? []) {
      const legacy = readLegacyExtraPayload(model);
      if (legacy.kind === "invalid") {
        malformed.push([providerId, model.id]);
        issues.push(malformedLegacyIssue(`$.providers.${providerId}.models[id=${model.id}].legacy`, legacy.reason));
      }
    }
    const introduced = (config.models ?? []).map((entry) => [providerId, entry.id] as ModelIdentity);
    const collisions = targetPayloadCollisions(snapshot.payload.document!, introduced, new Set());
    return {
      collisionSet: sortedIdentityKeys(collisions),
      malformedSet: sortedIdentityKeys(malformed),
      collisions,
      malformed,
      issues,
    };
  }

  private inspectCreateModel(
    snapshot: CoordinatedSnapshot,
    providerId: string,
    model: ModelConfig,
  ): { collisionSet: string[]; malformedSet: string[]; collisions: ModelIdentity[]; malformed: ModelIdentity[]; issues: ValidationIssue[] } {
    const malformed: ModelIdentity[] = [];
    const issues: ValidationIssue[] = [];
    const legacy = readLegacyExtraPayload(model);
    if (legacy.kind === "invalid") {
      malformed.push([providerId, model.id]);
      issues.push(malformedLegacyIssue(`$.providers.${providerId}.models[id=${model.id}].legacy`, legacy.reason));
    }
    const collisions = targetPayloadCollisions(snapshot.payload.document!, [[providerId, model.id]], new Set());
    return {
      collisionSet: sortedIdentityKeys(collisions),
      malformedSet: sortedIdentityKeys(malformed),
      collisions,
      malformed,
      issues,
    };
  }

  private inspectProviderModelsPatch(
    snapshot: CoordinatedSnapshot,
    providerId: string,
    existing: ProviderConfig,
    newModels: ModelConfig[],
  ): { collisionSet: string[]; malformedSet: string[]; collisions: ModelIdentity[]; malformed: ModelIdentity[]; issues: ValidationIssue[] } {
    const oldModels = existing.models ?? [];
    const oldById = new Map(oldModels.map((entry) => [entry.id, entry]));
    const malformed: ModelIdentity[] = [];
    const issues: ValidationIssue[] = [];
    for (const model of oldModels) {
      const legacy = readLegacyExtraPayload(model);
      if (legacy.kind === "invalid") {
        malformed.push([providerId, model.id]);
        issues.push(malformedLegacyIssue(`$.providers.${providerId}.models[id=${model.id}].legacy`, legacy.reason));
      }
    }
    for (const model of newModels) {
      const legacy = readLegacyExtraPayload(model);
      if (legacy.kind === "invalid") {
        const id: ModelIdentity = [providerId, model.id];
        if (!malformed.some((m) => m[0] === id[0] && m[1] === id[1])) malformed.push(id);
        issues.push(malformedLegacyIssue(`$.providers.${providerId}.models[id=${model.id}].legacy`, legacy.reason));
      }
    }
    const collisions: ModelIdentity[] = [];
    for (const model of newModels) {
      if (oldById.has(model.id)) continue;
      if (lookupModelPayload(snapshot.payload.document!, providerId, model.id) !== undefined) {
        collisions.push([providerId, model.id]);
      }
    }
    return {
      collisionSet: sortedIdentityKeys(collisions),
      malformedSet: sortedIdentityKeys(malformed),
      collisions,
      malformed,
      issues,
    };
  }

  private inspectPatchModel(
    snapshot: CoordinatedSnapshot,
    providerId: string,
    modelId: string,
    existing: ModelConfig,
  ): { collisionSet: string[]; malformedSet: string[]; collisions: ModelIdentity[]; malformed: ModelIdentity[]; issues: ValidationIssue[] } {
    const malformed: ModelIdentity[] = [];
    const issues: ValidationIssue[] = [];
    const legacy = readLegacyExtraPayload(existing);
    if (legacy.kind === "invalid") {
      malformed.push([providerId, modelId]);
      issues.push(malformedLegacyIssue(`$.providers.${providerId}.models[id=${modelId}].legacy`, legacy.reason));
    }
    return {
      collisionSet: [],
      malformedSet: sortedIdentityKeys(malformed),
      collisions: [],
      malformed,
      issues,
    };
  }

  private simpleNeedsResolution(
    snapshot: CoordinatedSnapshot,
    request: SimpleBoundRequest,
    live: { collisionSet: string[]; malformedSet: string[]; collisions: ModelIdentity[]; malformed: ModelIdentity[]; issues: ValidationIssue[] },
    scope: "provider" | "model",
    kind: "create" | "models-patch",
  ): BuildOutcome {
    const simpleBind = {
      request,
      nativeHash: snapshot.native.hash,
      payloadHash: snapshot.payload.hash,
      collisionSet: live.collisionSet,
      malformedSet: live.malformedSet,
    };
    if (live.collisionSet.length > 0) {
      return {
        type: "payload-collision",
        collisions: live.collisions,
        affectedIdentities: live.collisions,
        scope,
        kind,
        simpleBind,
        malformedIdentities: live.malformed,
      };
    }
    return {
      type: "validation-error",
      issues: live.issues,
      simpleBind,
    };
  }

  private simpleDriftResult(
    snapshot: CoordinatedSnapshot,
    request: SimpleBoundRequest,
    live: { collisionSet: string[]; malformedSet: string[]; collisions: ModelIdentity[]; malformed: ModelIdentity[]; issues: ValidationIssue[] },
  ): BuildOutcome {
    // Drift always returns stale-target. If review is still required, bind a fresh token (never auto-apply).
    if (live.collisionSet.length > 0 || live.malformedSet.length > 0) {
      return {
        type: "stale-target",
        path: "resolution-token",
        simpleBind: {
          request,
          nativeHash: snapshot.native.hash,
          payloadHash: snapshot.payload.hash,
          collisionSet: live.collisionSet,
          malformedSet: live.malformedSet,
        },
        collisions: live.collisions,
        malformedIdentities: live.malformed,
      };
    }
    return {
      type: "stale-target",
      path: "resolution-token",
    };
  }

  /**
   * Explicit models array patch (endpoint discovery / list replace-or-merge).
   * Never silently attaches or destroys private payloads; migrates valid legacy; requires bound discard/collision resolution.
   */
  private buildProviderModelsPatch(
    snapshot: CoordinatedSnapshot,
    providerId: string,
    existing: ProviderConfig,
    patch: ConfigPatch<ProviderConfig>,
    options: FieldPatchOptions | undefined,
    terminalBound: BoundSimpleResolution | undefined,
  ): BuildOutcome {
    const bare = rejectBareSimpleResolution(options);
    if (bare) return bare;
    const resolution = ownResolutionFields(options);

    let effectiveProviderId = providerId;
    let effectivePatch = patch;
    let effectiveExisting = existing;
    let payloadResolution = resolution.payloadCollisionResolution;
    let legacyResolution = resolution.legacyDiscardResolution;

    const rawModels = (effectivePatch as { models?: unknown }).models;
    if (!Array.isArray(rawModels)) {
      return {
        type: "validation-error",
        issues: [{ path: `$.providers.${providerId}.models`, message: "models must be an array" }],
      };
    }

    if (resolution.resolutionToken) {
      const bound = terminalBound;
      if (!bound || bound.request.action !== "patch-provider-models") {
        return { type: "stale-target", path: "resolution-token" };
      }
      effectiveProviderId = bound.request.providerId;
      effectivePatch = bound.request.patch;
      const existingBound = getProvider(snapshot.native.document!, effectiveProviderId);
      if (!existingBound) return { type: "stale-target", path: `providers.${effectiveProviderId}` };
      const boundModels = (effectivePatch as { models?: unknown }).models;
      if (!Array.isArray(boundModels)) {
        return { type: "validation-error", issues: [{ path: `$.providers.${effectiveProviderId}.models`, message: "models must be an array" }] };
      }
      const live = this.inspectProviderModelsPatch(snapshot, effectiveProviderId, existingBound, boundModels as ModelConfig[]);
      if (
        snapshot.native.hash !== bound.nativeHash
        || snapshot.payload.hash !== bound.payloadHash
        || !setsEqual(live.collisionSet, bound.collisionSet)
        || !setsEqual(live.malformedSet, bound.malformedSet)
      ) {
        return this.simpleDriftResult(snapshot, {
          action: "patch-provider-models",
          providerId: effectiveProviderId,
          patch: effectivePatch,
          fieldBaselines: bound.request.fieldBaselines,
        }, live);
      }
      if (live.malformedSet.length > 0 && legacyResolution !== "discard-malformed-legacy") {
        return this.simpleDriftResult(snapshot, {
          action: "patch-provider-models",
          providerId: effectiveProviderId,
          patch: effectivePatch,
        }, live);
      }
      if (live.collisionSet.length > 0 && payloadResolution !== "replace-target" && payloadResolution !== "reuse-target") {
        return this.simpleDriftResult(snapshot, {
          action: "patch-provider-models",
          providerId: effectiveProviderId,
          patch: effectivePatch,
        }, live);
      }
      effectiveExisting = existingBound;
    } else {
      const live = this.inspectProviderModelsPatch(snapshot, providerId, existing, rawModels as ModelConfig[]);
      if (live.malformedSet.length > 0 || live.collisionSet.length > 0) {
        return this.simpleNeedsResolution(snapshot, {
          action: "patch-provider-models",
          providerId,
          patch,
          fieldBaselines: options?.fieldBaselines,
        }, live, "provider", "models-patch");
      }
    }

    const newModels = ((effectivePatch as { models?: unknown }).models as ModelConfig[]);
    const oldModels = effectiveExisting.models ?? [];
    const oldById = new Map(oldModels.map((entry) => [entry.id, entry]));
    const newById = new Map(newModels.map((entry) => [entry.id, entry]));

    let payload = clonePayloadDocument(snapshot.payload.document!);
    const affected: ModelIdentity[] = [];
    const stripped: ModelConfig[] = [];
    for (const model of newModels) {
      const old = oldById.get(model.id);
      const legacyNew = readLegacyExtraPayload(model);
      const legacyOld = old ? readLegacyExtraPayload(old) : { kind: "none" as const };
      const migrateLegacy = legacyNew.kind === "valid"
        ? legacyNew.payload
        : legacyOld.kind === "valid"
          ? legacyOld.payload
          : undefined;
      stripped.push(stripLegacyExtraPayload(cloneOwnOnlyJson(model)));

      const privateExists = lookupModelPayload(payload, effectiveProviderId, model.id) !== undefined;
      const isNew = !oldById.has(model.id);
      if (isNew && privateExists) {
        if (payloadResolution === "reuse-target") {
          affected.push([effectiveProviderId, model.id]);
          continue;
        }
        if (payloadResolution === "replace-target") {
          if (migrateLegacy) {
            payload = setPayloadDocumentValue(payload, effectiveProviderId, model.id, migrateLegacy);
          } else {
            payload = removePayloadDocumentValue(payload, effectiveProviderId, model.id);
          }
          affected.push([effectiveProviderId, model.id]);
          continue;
        }
      }
      if (migrateLegacy && !privateExists) {
        payload = setPayloadDocumentValue(payload, effectiveProviderId, model.id, migrateLegacy);
        affected.push([effectiveProviderId, model.id]);
      } else if (migrateLegacy || legacyNew.kind === "empty" || legacyOld.kind === "empty") {
        affected.push([effectiveProviderId, model.id]);
      }
    }

    for (const old of oldModels) {
      if (newById.has(old.id)) continue;
      const privateExists = lookupModelPayload(payload, effectiveProviderId, old.id) !== undefined;
      const legacyOld = readLegacyExtraPayload(old);
      if (legacyOld.kind === "valid" && !privateExists) {
        payload = setPayloadDocumentValue(payload, effectiveProviderId, old.id, legacyOld.payload);
        affected.push([effectiveProviderId, old.id]);
      }
    }

    const next = cloneModels(snapshot.native.document!);
    const merged = mergeProviderConfig(effectiveExisting, stripModelsFromProviderPatch(effectivePatch));
    merged.models = stripped;
    setProvider(next, effectiveProviderId, merged);
    const validation = validateOrIssues(next, this.options.validation);
    if (validation.length > 0) return { type: "validation-error", issues: validation };
    return { type: "mutation", native: next, payload, affectedIdentities: affected };
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

    // Provider rename/copy/delete: malformed legacy never vanishes without explicit discard.
    {
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
    let providerBody = cloneOwnOnlyJson(source);
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

    // Malformed legacy must be checked for every model identity op including delete, before mutation.
    const discard = request.legacyDiscardResolution;
    const malformed = rejectMalformedLegacyUnlessDiscarded(
      existing,
      `$.providers.${request.providerId}.models[id=${request.modelId}].legacy`,
      discard,
    );
    if (malformed) return { type: "validation-error", issues: [malformed] };

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
      : cloneOwnOnlyJson(existing);
    const body = stripLegacyExtraPayload(patched);
    body.id = request.targetModelId;

    const sourcePrivate = lookupModelPayload(snapshot.payload.document!, request.providerId, request.modelId);
    const legacyRead = readLegacyExtraPayload(existing);
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
          if (buildError.simpleBind) return this.attachSimpleToken(buildError);
          return {
            type: "stale-target",
            nativeHash: coordinated?.native.hash,
            payloadHash: coordinated?.payload.hash,
            path: buildError.path,
          };
        }
        if (buildError.type === "validation-error" || buildError.type === "payload-collision") {
          // Prefer hashes captured at build-time in simpleBind when present.
          if (buildError.simpleBind) return this.attachSimpleToken(buildError);
          if (buildError.type === "validation-error") return { type: "validation-error", issues: buildError.issues };
          return {
            type: "payload-collision",
            collisions: buildError.collisions,
            affectedIdentities: buildError.affectedIdentities,
            nativeHash: coordinated?.native.hash ?? "",
            payloadHash: coordinated?.payload.hash ?? "",
            scope: buildError.scope,
            kind: buildError.kind,
            malformedIdentities: buildError.malformedIdentities,
          };
        }
        if (buildError.type === "subtree-conflict") {
          return {
            type: "subtree-conflict",
            path: buildError.path,
            nativeHash: coordinated?.native.hash ?? "",
            payloadHash: coordinated?.payload.hash ?? "",
          };
        }
        if (buildError.type === "native-collision") return buildError;
        return { type: "stale-target" };
      }
      throw error;
    }

    const lockMapped = mapLockResult(result);
    if (lockMapped) return lockMapped;
    if (result.type === "committed" || result.type === "unchanged") {
      return { type: "success" };
    }
    return { type: "recovery-required" };
  }
}
