import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cloneOwnJsonData,
  cloneOwnMap,
  deleteOwnKey,
  emptyOwnMap,
  getOwnValue,
  hasOwnKey,
  ownKeys,
  setOwnValue,
  stringifyOwnJsonData,
} from "./own-keys.ts";

export interface PayloadConfig {
  version: 1;
  extraPayloads: Record<string, Record<string, unknown>>;
}

export type ModelPayloadIdentity = readonly [provider: string, modelId: string];

const EMPTY_CONFIG: PayloadConfig = { version: 1, extraPayloads: emptyOwnMap() };

export function isPlainPayloadObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson<T>(value: T): T {
  return cloneOwnJsonData(value, { objectPrototype: "ordinary" });
}

export function clonePayloadDocument(config: PayloadConfig): PayloadConfig {
  const normalized = cloneOwnJsonData(config);
  if (!isPlainPayloadObject(normalized) || getOwnValue(normalized, "version") !== 1) {
    throw new Error("Payload document must be versioned JSON data");
  }
  const source = getOwnValue<Record<string, Record<string, unknown>>>(normalized, "extraPayloads");
  if (!isPlainPayloadObject(source)) throw new Error("Payload document must be versioned JSON data");
  const extraPayloads = emptyOwnMap<Record<string, unknown>>();
  for (const key of ownKeys(source)) {
    const value = getOwnValue(source, key);
    if (!isPlainPayloadObject(value)) throw new Error("Payload entry must be JSON data");
    setOwnValue(extraPayloads, key, cloneJson(value));
  }
  return { version: 1, extraPayloads };
}

export function getPayloadConfigPath(agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")): string {
  return path.join(agentDir, "model-config-payloads.json");
}

export function modelPayloadKey(provider: string, modelId: string): string {
  return stringifyOwnJsonData([provider, modelId] satisfies ModelPayloadIdentity);
}

export function parseModelPayloadKey(key: string): ModelPayloadIdentity | undefined {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((part) => typeof part !== "string")) return undefined;
    return parsed as unknown as ModelPayloadIdentity;
  } catch {
    return undefined;
  }
}

export function legacyModelPayloadKey(provider: string, modelId: string): string | undefined {
  if (provider.includes("/") || modelId.includes("/")) return undefined;
  return `${provider}/${modelId}`;
}

export function isUnambiguousLegacyModelPayloadKey(key: string): boolean {
  const separator = key.indexOf("/");
  return separator >= 0 && separator === key.lastIndexOf("/");
}

export class PayloadConfigError extends Error {
  public readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`Failed to read Model Config payloads at ${filePath}: ${message}`);
    this.name = "PayloadConfigError";
    this.filePath = filePath;
  }
}

export function parsePayloadDocument(raw: string | Uint8Array, filePath = getPayloadConfigPath()): PayloadConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new PayloadConfigError(filePath, "invalid JSON document");
  }
  try {
    parsed = cloneOwnJsonData(parsed);
  } catch {
    throw new PayloadConfigError(filePath, "payload document must be JSON data");
  }
  if (!isPlainPayloadObject(parsed)) {
    throw new PayloadConfigError(filePath, "expected versioned payload document");
  }
  // Own-key only: inherited Object.prototype.version/extraPayloads must never satisfy the schema.
  if (!hasOwnKey(parsed, "version") || getOwnValue(parsed, "version") !== 1) {
    throw new PayloadConfigError(filePath, "expected versioned payload document");
  }
  const rawExtra = hasOwnKey(parsed, "extraPayloads") ? getOwnValue(parsed, "extraPayloads") : undefined;
  if (!isPlainPayloadObject(rawExtra)) {
    throw new PayloadConfigError(filePath, "expected versioned payload document");
  }
  const extraPayloads = emptyOwnMap<Record<string, unknown>>();
  for (const key of ownKeys(rawExtra)) {
    if (!hasOwnKey(rawExtra, key)) continue;
    const value = getOwnValue(rawExtra, key);
    if (!isPlainPayloadObject(value)) throw new PayloadConfigError(filePath, "payload entry must be an object");
    try {
      setOwnValue(extraPayloads, key, cloneJson(value));
    } catch {
      throw new PayloadConfigError(filePath, "payload entry must be JSON data");
    }
  }
  return { version: 1, extraPayloads };
}

export function serializePayloadDocument(config: PayloadConfig): Buffer {
  const validated = clonePayloadDocument(config);
  return Buffer.from(`${stringifyOwnJsonData(validated, 2)}\n`, "utf8");
}

export function emptyPayloadDocument(): PayloadConfig {
  return clonePayloadDocument(EMPTY_CONFIG);
}

export function readPayloadConfigForWrite(filePath = getPayloadConfigPath()): PayloadConfig {
  if (!fs.existsSync(filePath)) return emptyPayloadDocument();
  return parsePayloadDocument(fs.readFileSync(filePath), filePath);
}

export function readPayloadConfig(filePath = getPayloadConfigPath()): PayloadConfig {
  try {
    return readPayloadConfigForWrite(filePath);
  } catch {
    return emptyPayloadDocument();
  }
}

export function lookupModelPayload(
  config: PayloadConfig,
  provider: string,
  modelId: string,
): Record<string, unknown> | undefined {
  const exact = getOwnValue(config.extraPayloads, modelPayloadKey(provider, modelId));
  if (exact) return cloneJson(exact);
  const legacyKey = legacyModelPayloadKey(provider, modelId);
  const legacy = legacyKey === undefined ? undefined : getOwnValue(config.extraPayloads, legacyKey);
  return legacy ? cloneJson(legacy) : undefined;
}

export function setPayloadDocumentValue(
  config: PayloadConfig,
  provider: string,
  modelId: string,
  payload: Record<string, unknown>,
): PayloadConfig {
  if (!isPlainPayloadObject(payload)) throw new Error("Model payload must be a JSON object");
  const next = clonePayloadDocument(config);
  setOwnValue(next.extraPayloads, modelPayloadKey(provider, modelId), cloneJson(payload));
  const legacyKey = legacyModelPayloadKey(provider, modelId);
  if (legacyKey !== undefined) deleteOwnKey(next.extraPayloads, legacyKey);
  return next;
}

export function removePayloadDocumentValue(config: PayloadConfig, provider: string, modelId: string): PayloadConfig {
  const next = clonePayloadDocument(config);
  deleteOwnKey(next.extraPayloads, modelPayloadKey(provider, modelId));
  const legacyKey = legacyModelPayloadKey(provider, modelId);
  if (legacyKey !== undefined) deleteOwnKey(next.extraPayloads, legacyKey);
  return next;
}

export function copyPayloadDocumentValue(
  config: PayloadConfig,
  fromProvider: string,
  fromModelId: string,
  toProvider: string,
  toModelId: string,
): PayloadConfig {
  if (fromProvider === toProvider && fromModelId === toModelId) return clonePayloadDocument(config);
  const value = lookupModelPayload(config, fromProvider, fromModelId);
  return value === undefined ? clonePayloadDocument(config) : setPayloadDocumentValue(config, toProvider, toModelId, value);
}

export function movePayloadDocumentValue(
  config: PayloadConfig,
  fromProvider: string,
  fromModelId: string,
  toProvider: string,
  toModelId: string,
): PayloadConfig {
  if (fromProvider === toProvider && fromModelId === toModelId) return clonePayloadDocument(config);
  const value = lookupModelPayload(config, fromProvider, fromModelId);
  if (value === undefined) return clonePayloadDocument(config);
  return removePayloadDocumentValue(setPayloadDocumentValue(config, toProvider, toModelId, value), fromProvider, fromModelId);
}

/**
 * Authoritative enumerator of private payload identities owned by a provider:
 * exact JSON tuple keys plus unambiguous legacy `provider/model` delimiter keys.
 * Ambiguous multi-slash legacy keys remain inert and are not listed.
 */
export function listProviderPayloadIdentities(config: PayloadConfig, providerId: string): ModelPayloadIdentity[] {
  const map = new Map<string, ModelPayloadIdentity>();
  const legacyPrefix = providerId.includes("/") ? undefined : `${providerId}/`;
  for (const key of ownKeys(config.extraPayloads)) {
    if (!hasOwnKey(config.extraPayloads, key)) continue;
    const identity = parseModelPayloadKey(key);
    if (identity && identity[0] === providerId) {
      map.set(stringifyOwnJsonData(identity), identity);
      continue;
    }
    if (
      !identity
      && legacyPrefix !== undefined
      && isUnambiguousLegacyModelPayloadKey(key)
      && key.startsWith(legacyPrefix)
    ) {
      // Empty model id is supported: key `provider/` maps to [provider, ""].
      const modelId = key.slice(legacyPrefix.length);
      const entry: ModelPayloadIdentity = [providerId, modelId];
      map.set(stringifyOwnJsonData(entry), entry);
    }
  }
  return [...map.values()].sort((a, b) => stringifyOwnJsonData(a).localeCompare(stringifyOwnJsonData(b)));
}

export function removeProviderPayloadDocumentValues(config: PayloadConfig, provider: string): PayloadConfig {
  const next = clonePayloadDocument(config);
  for (const [providerId, modelId] of listProviderPayloadIdentities(next, provider)) {
    next.extraPayloads = removePayloadDocumentValue(next, providerId, modelId).extraPayloads;
  }
  // Defensive: drop any remaining exact-tuple or unambiguous-legacy keys for the provider.
  const legacyPrefix = provider.includes("/") ? undefined : `${provider}/`;
  for (const key of ownKeys(next.extraPayloads)) {
    const identity = parseModelPayloadKey(key);
    if (identity?.[0] === provider || (
      !identity && legacyPrefix !== undefined && isUnambiguousLegacyModelPayloadKey(key) && key.startsWith(legacyPrefix)
    )) deleteOwnKey(next.extraPayloads, key);
  }
  return next;
}

export function copyProviderPayloadDocumentValues(
  config: PayloadConfig,
  fromProvider: string,
  toProvider: string,
  modelIds: readonly string[],
): PayloadConfig {
  if (fromProvider === toProvider) return clonePayloadDocument(config);
  let next = clonePayloadDocument(config);
  for (const modelId of modelIds) next = copyPayloadDocumentValue(next, fromProvider, modelId, toProvider, modelId);
  return next;
}

export function moveProviderPayloadDocumentValues(
  config: PayloadConfig,
  fromProvider: string,
  toProvider: string,
  modelIds: readonly string[],
): PayloadConfig {
  if (fromProvider === toProvider) return clonePayloadDocument(config);
  let next = clonePayloadDocument(config);
  for (const modelId of modelIds) next = movePayloadDocumentValue(next, fromProvider, modelId, toProvider, modelId);
  return next;
}

export function mergePayloadIntoRequest(payload: unknown, extraPayload: unknown): Record<string, unknown> | undefined {
  if (!isPlainPayloadObject(payload) || !isPlainPayloadObject(extraPayload)) return undefined;
  let normalizedPayload: Record<string, unknown>;
  let normalizedExtra: Record<string, unknown>;
  try {
    normalizedPayload = cloneJson(payload);
    normalizedExtra = cloneJson(extraPayload);
  } catch {
    return undefined;
  }
  const merged: Record<string, unknown> = {};
  for (const key of ownKeys(normalizedPayload)) setOwnValue(merged, key, getOwnValue(normalizedPayload, key));
  for (const key of ownKeys(normalizedExtra)) setOwnValue(merged, key, getOwnValue(normalizedExtra, key));
  return merged;
}

export { cloneOwnMap, emptyOwnMap, getOwnValue, hasOwnKey, setOwnValue, deleteOwnKey };
