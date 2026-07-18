import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface PayloadConfig {
  version: 1;
  extraPayloads: Record<string, Record<string, unknown>>;
}

const EMPTY_CONFIG: PayloadConfig = { version: 1, extraPayloads: {} };
type ModelPayloadIdentity = readonly [provider: string, modelId: string];

export function isPlainPayloadObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function clonePayloadDocument(config: PayloadConfig): PayloadConfig {
  return cloneJson(config);
}

export function getPayloadConfigPath(agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")): string {
  return path.join(agentDir, "model-config-payloads.json");
}

export function modelPayloadKey(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId] satisfies ModelPayloadIdentity);
}

function parseModelPayloadKey(key: string): ModelPayloadIdentity | undefined {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((part) => typeof part !== "string")) return undefined;
    return parsed as unknown as ModelPayloadIdentity;
  } catch {
    return undefined;
  }
}

function legacyModelPayloadKey(provider: string, modelId: string): string | undefined {
  if (provider.includes("/") || modelId.includes("/")) return undefined;
  return `${provider}/${modelId}`;
}

function isUnambiguousLegacyModelPayloadKey(key: string): boolean {
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
  const extraPayloads: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(parsed.extraPayloads)) {
    if (!isPlainPayloadObject(value)) throw new PayloadConfigError(filePath, "payload entry must be an object");
    try {
      extraPayloads[key] = cloneJson(value);
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
  const exact = config.extraPayloads[modelPayloadKey(provider, modelId)];
  if (exact) return cloneJson(exact);
  const legacyKey = legacyModelPayloadKey(provider, modelId);
  const legacy = legacyKey === undefined ? undefined : config.extraPayloads[legacyKey];
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
  next.extraPayloads[modelPayloadKey(provider, modelId)] = cloneJson(payload);
  const legacyKey = legacyModelPayloadKey(provider, modelId);
  if (legacyKey !== undefined) delete next.extraPayloads[legacyKey];
  return next;
}

export function removePayloadDocumentValue(config: PayloadConfig, provider: string, modelId: string): PayloadConfig {
  const next = clonePayloadDocument(config);
  delete next.extraPayloads[modelPayloadKey(provider, modelId)];
  const legacyKey = legacyModelPayloadKey(provider, modelId);
  if (legacyKey !== undefined) delete next.extraPayloads[legacyKey];
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

export function removeProviderPayloadDocumentValues(config: PayloadConfig, provider: string): PayloadConfig {
  const next = clonePayloadDocument(config);
  const legacyPrefix = provider.includes("/") ? undefined : `${provider}/`;
  for (const key of Object.keys(next.extraPayloads)) {
    const identity = parseModelPayloadKey(key);
    if (identity?.[0] === provider || (
      !identity && legacyPrefix !== undefined && isUnambiguousLegacyModelPayloadKey(key) && key.startsWith(legacyPrefix)
    )) delete next.extraPayloads[key];
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
