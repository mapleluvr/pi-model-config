// ── models.json 配置读写 ──
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { atomicReplace, readArtifact } from "./atomic-file.ts";
import { assertValidModelsCandidate } from "./config-validation.ts";
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
export function getModelsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "models.json");
}

export function parseModelsDocument(filePath: string, raw: string | Uint8Array): ModelsConfig {
  const document = Buffer.from(raw).toString("utf8");
  const errors: ParseError[] = [];
  const parsed = parse(document, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new ModelsConfigError(filePath, errors.map((error) => `offset ${error.offset}: ${error.error}`).join("; "));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelsConfigError(filePath, "root must be a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  if (root.providers !== undefined && (!root.providers || typeof root.providers !== "object" || Array.isArray(root.providers))) {
    throw new ModelsConfigError(filePath, "providers must be a JSON object when present");
  }
  return { ...root, providers: (root.providers as Record<string, ProviderConfig> | undefined) ?? {} } as ModelsConfig;
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
  modelsConfig.providers[providerId] = config;
  writeModelsConfig(modelsConfig);
}

/** 删除一个 provider */
export function deleteProvider(providerId: string): void {
  const modelsConfig = readModelsConfig();
  delete modelsConfig.providers[providerId];
  writeModelsConfig(modelsConfig);
}

/** 列出所有 provider id */
export function listProviderIds(): string[] {
  return Object.keys(readModelsConfig().providers);
}

/** 获取指定 provider 配置 */
export function getProvider(providerId: string): ProviderConfig | undefined {
  return readModelsConfig().providers[providerId];
}
