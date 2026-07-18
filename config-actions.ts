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

export type ActionResult =
  | { type: "success"; snapshot: EditorSnapshot }
  | { type: "stale-target"; snapshot?: EditorSnapshot }
  | { type: "validation-error"; issues: ValidationIssue[] }
  | { type: "subtree-conflict"; snapshot: EditorSnapshot }
  | { type: "native-collision"; target: string }
  | {
    type: "payload-collision";
    collisions: ModelIdentity[];
    affectedIdentities: ModelIdentity[];
    nativeHash: string;
    payloadHash: string;
  }
  | { type: "preview"; token: IdentityPreviewToken; affectedIdentities: ModelIdentity[]; collisions: ModelIdentity[] }
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
  | { kind: "rename"; providerId: string; targetProviderId: string; provider?: ProviderConfig; payloadCollisionResolution?: PayloadCollisionResolution }
  | { kind: "copy"; providerId: string; targetProviderId: string; payloadCollisionResolution?: PayloadCollisionResolution }
  | { kind: "delete"; providerId: string };

export type ModelIdentityRequest =
  | {
    kind: "rename";
    providerId: string;
    modelId: string;
    targetModelId: string;
    model?: ModelConfig;
    payload?: Record<string, unknown> | null;
    migrateLegacyExtraPayload?: Record<string, unknown>;
    payloadCollisionResolution?: PayloadCollisionResolution;
  }
  | {
    kind: "copy";
    providerId: string;
    modelId: string;
    targetModelId: string;
    model?: ModelConfig;
    payloadCollisionResolution?: PayloadCollisionResolution;
  }
  | { kind: "delete"; providerId: string; modelId: string };

export interface IdentityPreviewToken {
  scope: "provider" | "model";
  request: ProviderIdentityRequest | ModelIdentityRequest;
  nativeHash: string;
  payloadHash: string;
  identitySet: string[];
  collisions: ModelIdentity[];
  affectedIdentities: ModelIdentity[];
}

export interface ModelConfigActionsOptions extends PayloadCoordinatorOptions {
  validation?: ValidationOptions;
  commitMutation?: (request: MutationRequest, options?: PayloadCoordinatorOptions) => Promise<CommitResult>;
}

type BuildOutcome =
  | { type: "mutation"; native: ModelsConfig; payload: PayloadConfig; affectedIdentities: ModelIdentity[] }
  | { type: "stale-target" }
  | { type: "validation-error"; issues: ValidationIssue[] }
  | { type: "subtree-conflict" }
  | { type: "native-collision"; target: string }
  | { type: "payload-collision"; collisions: ModelIdentity[]; affectedIdentities: ModelIdentity[] }
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

function providerPayloadIdentities(payload: PayloadConfig, providerId: string): ModelIdentity[] {
  const identities: ModelIdentity[] = [];
  for (const [key, value] of Object.entries(payload.extraPayloads)) {
    void value;
    try {
      const parsed: unknown = JSON.parse(key);
      if (Array.isArray(parsed) && parsed.length === 2 && parsed[0] === providerId && typeof parsed[1] === "string") {
        identities.push([providerId, parsed[1]]);
      }
    } catch {
      // ignore non-tuple keys; provider moves use model list as source of truth
    }
  }
  return identities;
}

function collectProviderModelIds(provider: ProviderConfig): string[] {
  return (provider.models ?? []).map((entry) => entry.id);
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

export class ModelConfigActions {
  private readonly options: ModelConfigActionsOptions;
  private readonly commit: (request: MutationRequest, options?: PayloadCoordinatorOptions) => Promise<CommitResult>;

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

  async patchProvider(providerId: string, patch: ConfigPatch<ProviderConfig>): Promise<ActionResult> {
    return this.run((snapshot) => {
      const existing = snapshot.native.document!.providers[providerId];
      if (!existing) return { type: "stale-target" };
      const next = cloneModels(snapshot.native.document!);
      next.providers[providerId] = mergeProviderConfig(existing, patch);
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
    options?: { payload?: Record<string, unknown> | null },
  ): Promise<ActionResult> {
    return this.run((snapshot) => {
      const provider = snapshot.native.document!.providers[providerId];
      if (!provider) return { type: "stale-target" };
      const index = findModelIndex(provider, modelId);
      if (index < 0) return { type: "stale-target" };
      const existing = provider.models![index]!;
      if (typeof patch.id === "string" && patch.id !== modelId) {
        return { type: "validation-error", issues: [{ path: `$.providers.${providerId}.models`, message: "model identity changes require identity actions" }] };
      }
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
      next.providers[providerId] = deepCloneJson(config);
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
      if (!provider) return { type: "stale-target" };
      if (findModelIndex(provider, model.id) >= 0) return { type: "native-collision", target: model.id };
      const collisions = targetPayloadCollisions(
        snapshot.payload.document!,
        [[providerId, model.id]],
        new Set(),
      );
      if (collisions.length > 0 && options?.payloadCollisionResolution !== "replace-target" && options?.payloadCollisionResolution !== "reuse-target") {
        return { type: "payload-collision", collisions, affectedIdentities: [[providerId, model.id]] };
      }
      const next = cloneModels(snapshot.native.document!);
      const nextProvider = next.providers[providerId]!;
      nextProvider.models = [...(nextProvider.models ?? []), stripLegacyExtraPayload(deepCloneJson(model))];
      const issues = validateOrIssues(next, this.options.validation);
      if (issues.length > 0) return { type: "validation-error", issues };
      let payload = clonePayloadDocument(snapshot.payload.document!);
      const affected: ModelIdentity[] = [];
      if (options?.payload && (collisions.length === 0 || options.payloadCollisionResolution === "replace-target")) {
        payload = setPayloadDocumentValue(payload, providerId, model.id, options.payload);
        affected.push([providerId, model.id]);
      } else if (options?.payload && options.payloadCollisionResolution === "reuse-target") {
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
      if (!provider) return { type: "stale-target" };
      const current = readProviderSubtree(provider, key);
      const normalizedCurrent = current === undefined || current === null ? {} : current;
      const normalizedBaseline = baseline === undefined || baseline === null ? {} : baseline;
      if (!deepEqualJson(normalizedCurrent, normalizedBaseline)) return { type: "subtree-conflict" };
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
      if (!provider) return { type: "stale-target" };
      const index = findModelIndex(provider, modelId);
      if (index < 0) return { type: "stale-target" };
      const model = provider.models![index]!;
      const current = readModelSubtree(model, key);
      if (key === "cost") {
        if (!deepEqualJson(normalizeSubtreeBaseline(current), normalizeSubtreeBaseline(baseline))) return { type: "subtree-conflict" };
      } else {
        const normalizedCurrent = current === undefined || current === null ? {} : current;
        const normalizedBaseline = baseline === undefined || baseline === null ? {} : baseline;
        if (!deepEqualJson(normalizedCurrent, normalizedBaseline)) return { type: "subtree-conflict" };
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
      if (!provider) return { type: "stale-target" };
      if (findModelIndex(provider, modelId) < 0) return { type: "stale-target" };
      const current = lookupModelPayload(snapshot.payload.document!, providerId, modelId);
      if (!deepEqualJson(current, baseline)) return { type: "subtree-conflict" };
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
      };
    }
    if (built.type !== "mutation" && built.type !== "unchanged") {
      return this.mapBuildFailure(built, coordinated);
    }
    const affected = built.type === "mutation" ? built.affectedIdentities : [];
    const identitySet = scope === "provider"
      ? providerIdentitySet(coordinated.native.document!)
      : modelIdentitySet(coordinated.native.document!);
    const token: IdentityPreviewToken = {
      scope,
      request,
      nativeHash: coordinated.native.hash,
      payloadHash: coordinated.payload.hash,
      identitySet,
      collisions: [],
      affectedIdentities: affected,
    };
    return { type: "preview", token, affectedIdentities: affected, collisions: [] };
  }

  private async commitIdentity(token: IdentityPreviewToken): Promise<ActionResult> {
    return this.run((snapshot) => {
      const identitySet = token.scope === "provider"
        ? providerIdentitySet(snapshot.native.document!)
        : modelIdentitySet(snapshot.native.document!);
      if (
        snapshot.native.hash !== token.nativeHash
        || snapshot.payload.hash !== token.payloadHash
        || !deepEqualJson(identitySet, token.identitySet)
      ) {
        return { type: "stale-target" };
      }
      return token.scope === "provider"
        ? this.buildProviderIdentity(snapshot, token.request as ProviderIdentityRequest)
        : this.buildModelIdentity(snapshot, token.request as ModelIdentityRequest);
    }, { preferRefreshedStale: true });
  }

  private buildProviderIdentity(snapshot: CoordinatedSnapshot, request: ProviderIdentityRequest): BuildOutcome {
    const native = snapshot.native.document!;
    const source = native.providers[request.providerId];
    if (!source) return { type: "stale-target" };
    let next = cloneModels(native);
    let payload = clonePayloadDocument(snapshot.payload.document!);
    const modelIds = collectProviderModelIds(source);
    const sourceIdentities = modelIds.map((id) => [request.providerId, id] as ModelIdentity);
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
    const targetIdentities = modelIds.map((id) => [request.targetProviderId, id] as ModelIdentity);
    const sourceKeys = new Set(sourceIdentities.map(([p, m]) => identityKey(p, m)));
    const collisions = targetPayloadCollisions(payload, targetIdentities, sourceKeys);
    if (collisions.length > 0 && request.payloadCollisionResolution !== "replace-target" && request.payloadCollisionResolution !== "reuse-target") {
      return { type: "payload-collision", collisions, affectedIdentities: [...sourceIdentities, ...targetIdentities] };
    }

    const providerBody = request.kind === "rename" && request.provider
      ? deepCloneJson(request.provider)
      : deepCloneJson(source);
    next.providers[request.targetProviderId] = providerBody;
    if (request.kind === "rename") delete next.providers[request.providerId];

    for (const modelId of modelIds) {
      if (request.payloadCollisionResolution === "reuse-target" && lookupModelPayload(payload, request.targetProviderId, modelId)) {
        if (request.kind === "rename") payload = removePayloadDocumentValue(payload, request.providerId, modelId);
        continue;
      }
      payload = request.kind === "rename"
        ? movePayloadDocumentValue(payload, request.providerId, modelId, request.targetProviderId, modelId)
        : copyPayloadDocumentValue(payload, request.providerId, modelId, request.targetProviderId, modelId);
    }
    if (request.kind === "rename") {
      payload = removeProviderPayloadDocumentValues(payload, request.providerId);
    }
    affected = [...sourceIdentities, ...targetIdentities];
    const issues = validateOrIssues(next, this.options.validation);
    if (issues.length > 0) return { type: "validation-error", issues };
    return { type: "mutation", native: next, payload, affectedIdentities: affected };
  }

  private buildModelIdentity(snapshot: CoordinatedSnapshot, request: ModelIdentityRequest): BuildOutcome {
    const native = snapshot.native.document!;
    const provider = native.providers[request.providerId];
    if (!provider) return { type: "stale-target" };
    const index = findModelIndex(provider, request.modelId);
    if (index < 0) return { type: "stale-target" };
    const existing = provider.models![index]!;
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
    if (collisions.length > 0 && request.payloadCollisionResolution !== "replace-target" && request.payloadCollisionResolution !== "reuse-target") {
      return {
        type: "payload-collision",
        collisions,
        affectedIdentities: [[request.providerId, request.modelId], [request.providerId, request.targetModelId]],
      };
    }

    const body = stripLegacyExtraPayload(deepCloneJson(request.model ?? existing));
    body.id = request.targetModelId;

    if (request.kind === "rename") {
      nextProvider.models[index] = body;
      if (request.payload !== undefined) {
        if (request.payload === null) {
          payload = removePayloadDocumentValue(payload, request.providerId, request.modelId);
          payload = removePayloadDocumentValue(payload, request.providerId, request.targetModelId);
        } else {
          payload = removePayloadDocumentValue(payload, request.providerId, request.modelId);
          payload = setPayloadDocumentValue(payload, request.providerId, request.targetModelId, request.payload);
        }
      } else if (request.migrateLegacyExtraPayload) {
        payload = removePayloadDocumentValue(payload, request.providerId, request.modelId);
        if (!(request.payloadCollisionResolution === "reuse-target" && lookupModelPayload(snapshot.payload.document!, request.providerId, request.targetModelId))) {
          payload = setPayloadDocumentValue(payload, request.providerId, request.targetModelId, request.migrateLegacyExtraPayload);
        }
      } else if (request.payloadCollisionResolution === "reuse-target" && lookupModelPayload(payload, request.providerId, request.targetModelId)) {
        payload = removePayloadDocumentValue(payload, request.providerId, request.modelId);
      } else {
        payload = movePayloadDocumentValue(payload, request.providerId, request.modelId, request.providerId, request.targetModelId);
      }
    } else {
      nextProvider.models.push(body);
      if (!(request.payloadCollisionResolution === "reuse-target" && lookupModelPayload(payload, request.providerId, request.targetModelId))) {
        payload = copyPayloadDocumentValue(payload, request.providerId, request.modelId, request.providerId, request.targetModelId);
      }
    }

    const issues = validateOrIssues(next, this.options.validation);
    if (issues.length > 0) return { type: "validation-error", issues };
    return {
      type: "mutation",
      native: next,
      payload,
      affectedIdentities: [[request.providerId, request.modelId], [request.providerId, request.targetModelId]],
    };
  }

  private mapBuildFailure(built: Exclude<BuildOutcome, { type: "mutation" } | { type: "unchanged" }>, coordinated: CoordinatedSnapshot): ActionResult {
    if (built.type === "stale-target") return { type: "stale-target", snapshot: snapshotFrom(coordinated) };
    if (built.type === "validation-error") return built;
    if (built.type === "subtree-conflict") return { type: "subtree-conflict", snapshot: snapshotFrom(coordinated) };
    if (built.type === "native-collision") return built;
    return {
      type: "payload-collision",
      collisions: built.collisions,
      affectedIdentities: built.affectedIdentities,
      nativeHash: coordinated.native.hash,
      payloadHash: coordinated.payload.hash,
    };
  }

  private async run(
    build: (snapshot: CoordinatedSnapshot) => BuildOutcome,
    _options?: { preferRefreshedStale?: boolean },
  ): Promise<ActionResult> {
    let buildError: BuildOutcome | undefined;
    let result: CommitResult;
    try {
      result = await this.commit({
        build: (snapshot) => {
          const blocked = ensureReady(snapshot);
          if (blocked) {
            buildError = { type: "stale-target" };
            // Force recovery path by throwing generic failure after coordinator checks;
            // coordinator already guards parse states; return unchanged native/payload if somehow called.
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
          return { type: "stale-target", snapshot: coordinated ? snapshotFrom(coordinated) : undefined };
        }
        if (buildError.type === "validation-error") return buildError;
        if (buildError.type === "subtree-conflict") {
          return { type: "subtree-conflict", snapshot: coordinated ? snapshotFrom(coordinated) : { type: "snapshot", native: { providers: {} }, payload: emptyPayloadDocument(), nativeHash: "", payloadHash: "" } };
        }
        if (buildError.type === "native-collision") return buildError;
        if (buildError.type === "payload-collision") {
          return {
            type: "payload-collision",
            collisions: buildError.collisions,
            affectedIdentities: buildError.affectedIdentities,
            nativeHash: coordinated?.native.hash ?? "",
            payloadHash: coordinated?.payload.hash ?? "",
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
