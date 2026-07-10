import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface PayloadConfig {
  version: 1;
  extraPayloads: Record<string, Record<string, unknown>>;
}

const EMPTY_CONFIG: PayloadConfig = { version: 1, extraPayloads: {} };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function clonePayload(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function getPayloadConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "model-config-payloads.json");
}

export function modelPayloadKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export class PayloadConfigError extends Error {
  public readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`Failed to read Model Config payloads at ${filePath}: ${message}`);
    this.name = "PayloadConfigError";
    this.filePath = filePath;
  }
}

function parsePayloadConfig(filePath: string, raw: string): PayloadConfig {
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.extraPayloads)) {
    throw new PayloadConfigError(filePath, "expected { version: 1, extraPayloads: object }");
  }
  const extraPayloads: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(parsed.extraPayloads)) {
    if (!isPlainObject(value)) throw new PayloadConfigError(filePath, `payload '${key}' must be an object`);
    extraPayloads[key] = clonePayload(value);
  }
  return { version: 1, extraPayloads };
}

export function readPayloadConfigForWrite(filePath = getPayloadConfigPath()): PayloadConfig {
  if (!fs.existsSync(filePath)) return { ...EMPTY_CONFIG, extraPayloads: {} };
  try {
    return parsePayloadConfig(filePath, fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof PayloadConfigError) throw error;
    throw new PayloadConfigError(filePath, error instanceof Error ? error.message : String(error));
  }
}

export function readPayloadConfig(filePath = getPayloadConfigPath()): PayloadConfig {
  try {
    return readPayloadConfigForWrite(filePath);
  } catch {
    return { ...EMPTY_CONFIG, extraPayloads: {} };
  }
}

function writePayloadConfig(config: PayloadConfig, filePath = getPayloadConfigPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function getModelPayload(provider: string, modelId: string): Record<string, unknown> | undefined {
  const value = readPayloadConfig().extraPayloads[modelPayloadKey(provider, modelId)];
  return value ? clonePayload(value) : undefined;
}

export function setModelPayload(provider: string, modelId: string, payload: Record<string, unknown>): void {
  if (!isPlainObject(payload)) throw new Error("Model payload must be a JSON object");
  const config = readPayloadConfigForWrite();
  config.extraPayloads[modelPayloadKey(provider, modelId)] = clonePayload(payload);
  writePayloadConfig(config);
}

export function removeModelPayload(provider: string, modelId: string): void {
  const config = readPayloadConfigForWrite();
  delete config.extraPayloads[modelPayloadKey(provider, modelId)];
  writePayloadConfig(config);
}

export function removeProviderPayloads(provider: string): void {
  const config = readPayloadConfigForWrite();
  const prefix = `${provider}/`;
  for (const key of Object.keys(config.extraPayloads)) if (key.startsWith(prefix)) delete config.extraPayloads[key];
  writePayloadConfig(config);
}

export function moveModelPayload(fromProvider: string, fromModelId: string, toProvider: string, toModelId: string): void {
  const config = readPayloadConfigForWrite();
  const value = config.extraPayloads[modelPayloadKey(fromProvider, fromModelId)];
  if (!value) return;
  config.extraPayloads[modelPayloadKey(toProvider, toModelId)] = clonePayload(value);
  delete config.extraPayloads[modelPayloadKey(fromProvider, fromModelId)];
  writePayloadConfig(config);
}

export function mergePayloadIntoRequest(payload: unknown, extraPayload: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(payload) || !isPlainObject(extraPayload)) return undefined;
  return { ...payload, ...clonePayload(extraPayload) };
}
