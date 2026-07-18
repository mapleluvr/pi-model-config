// ── models.json 配置读写 ──
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { atomicReplace, readArtifact } from "./atomic-file.ts";
import { assertValidModelsCandidate } from "./config-validation.ts";
import { deleteOwnKey, getOwnValue, hasOwnKey, setOwnValue } from "./own-keys.ts";
import type { ModelsConfig, ProviderConfig } from "./types.ts";

export class ModelsConfigError extends Error {
  public readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`Failed to read models.json at ${filePath}: ${message}`);
    this.name = "ModelsConfigError";
    this.filePath = filePath;
  }
}

/** 获取 models.json 的完整路径 */
export function getModelsPath(agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")): string {
  return path.join(agentDir, "models.json");
}

/** jsonc-parser treats `__proto__` keys as prototype assignment; shield then restore as own keys. */
const PROTO_KEY_SENTINEL = "__mc_own_proto__";

function shieldProtoKeys(document: string): string {
  return document.replace(/"__proto__"(\s*:)/g, `"${PROTO_KEY_SENTINEL}"$1`);
}

function restoreOwnKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => restoreOwnKeys(entry));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const restoredKey = key === PROTO_KEY_SENTINEL ? "__proto__" : key;
    setOwnValue(out, restoredKey, restoreOwnKeys(source[key]) as never);
  }
  return out;
}

export function parseModelsDocument(filePath: string, raw: string | Uint8Array): ModelsConfig {
  const document = Buffer.from(raw).toString("utf8");
  const errors: ParseError[] = [];
  const parsed = parse(shieldProtoKeys(document), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new ModelsConfigError(filePath, errors.map((error) => `offset ${error.offset}: ${error.error}`).join("; "));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelsConfigError(filePath, "root must be a JSON object");
  }
  const root = restoreOwnKeys(parsed) as Record<string, unknown>;
  if (root.providers !== undefined && (!root.providers || typeof root.providers !== "object" || Array.isArray(root.providers))) {
    throw new ModelsConfigError(filePath, "providers must be a JSON object when present");
  }
  const providers = (root.providers as Record<string, ProviderConfig> | undefined) ?? {};
  // Ensure providers map is an own-key bag even when empty.
  const ownProviders: Record<string, ProviderConfig> = {};
  for (const key of Object.keys(providers)) {
    setOwnValue(ownProviders, key, providers[key]!);
  }
  const config = { ...root, providers: ownProviders } as ModelsConfig;
  try {
    assertValidModelsCandidate(config);
  } catch {
    throw new ModelsConfigError(filePath, "document does not satisfy the Pi models schema");
  }
  return config;
}

/** 读取 models.json */
export function readModelsConfig(filePath = getModelsPath()): ModelsConfig {
  if (!fs.existsSync(filePath)) return { providers: {} };
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) throw new ModelsConfigError(filePath, "file is blank");
  return parseModelsDocument(filePath, raw);
}

export function serializeModelsDocument(config: ModelsConfig): Buffer {
  assertValidModelsCandidate(config);
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** 写入 models.json */
export function writeModelsConfig(config: ModelsConfig, filePath = getModelsPath()): void {
  const snapshot = readArtifact(filePath);
  const existing = snapshot.exists
    ? parseModelsDocument(filePath, snapshot.bytes!.toString("utf8"))
    : { providers: {} };
  const merged = { ...existing, ...config, providers: config.providers };
  assertValidModelsCandidate(merged);
  atomicReplace(filePath, serializeModelsDocument(merged), { expectedHash: snapshot.hash });
}

/** 添加或更新一个 provider */
export function upsertProvider(providerId: string, config: ProviderConfig): void {
  const modelsConfig = readModelsConfig();
  setOwnValue(modelsConfig.providers as Record<string, ProviderConfig>, providerId, config);
  writeModelsConfig(modelsConfig);
}

/** 删除一个 provider */
export function deleteProvider(providerId: string): void {
  const modelsConfig = readModelsConfig();
  if (!hasOwnKey(modelsConfig.providers, providerId)) return;
  deleteOwnKey(modelsConfig.providers, providerId);
  writeModelsConfig(modelsConfig);
}

/** 列出所有 provider id */
export function listProviderIds(): string[] {
  const providers = readModelsConfig().providers;
  return Object.keys(providers).filter((id) => hasOwnKey(providers, id));
}

/** 获取指定 provider 配置 */
export function getProvider(providerId: string): ProviderConfig | undefined {
  return getOwnValue(readModelsConfig().providers as Record<string, ProviderConfig>, providerId);
}
