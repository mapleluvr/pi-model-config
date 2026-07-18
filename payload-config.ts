import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cloneOwnMap, deleteOwnKey, emptyOwnMap, getOwnValue, hasOwnKey, ownKeys, setOwnValue } from "./own-keys.ts";

export interface PayloadConfig {
  version: 1;
  extraPayloads: Record<string, Record<string, unknown>>;
}

export type ModelPayloadIdentity = readonly [provider: string, modelId: string];

const EMPTY_CONFIG: PayloadConfig = { version: 1, extraPayloads: emptyOwnMap() };

export function isPlainPayloadObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function clonePayloadDocument(config: PayloadConfig): PayloadConfig {
  const extraPayloads = emptyOwnMap<Record<string, unknown>>();
  for (const key of ownKeys(config.extraPayloads)) {
    const value = getOwnValue(config.extraPayloads, key);
    if (value === undefined) continue;
    setOwnValue(extraPayloads, key, cloneJson(value));
  }
  return { version: 1, extraPayloads };
}

export function getPayloadConfigPath(agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")): string {
  return path.join(agentDir, "model-config-payloads.json");
}

export function modelPayloadKey(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId] satisfies ModelPayloadIdentity);
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
  if (!isPlainPayloadObject(parsed) || parsed.version !== 1 || !isPlainPayloadObject(parsed.extraPayloads)) {
    throw new PayloadConfigError(filePath, "expected versioned payload document");
  }
  const extraPayloads = emptyOwnMap<Record<string, unknown>>();
  for (const key of ownKeys(parsed.extraPayloads)) {
    const value = getOwnValue(parsed.extraPayloads, key);
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
  const validated = parsePayloadDocument(JSON.stringify(config), "payload document");
  return Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
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
      map.set(JSON.stringify(identity), identity);
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
      map.set(JSON.stringify(entry), entry);
    }
  }
  return [...map.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
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
  return { ...payload, ...cloneJson(extraPayload) };
}

export { cloneOwnMap, emptyOwnMap, getOwnValue, hasOwnKey, setOwnValue, deleteOwnKey };
