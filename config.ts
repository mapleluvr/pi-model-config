// ── models.json 配置读写 ──
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseTree, type Node, type ParseError } from "jsonc-parser";
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

/**
 * Structural JSONC materialization: build values from the parse tree with own-key-safe
 * property insertion. Never uses parse()/getNodeValue() assignment (which collapses `__proto__`).
 */
function materializeJsoncNode(node: Node): unknown {
  switch (node.type) {
    case "null":
      return null;
    case "boolean":
    case "number":
    case "string":
      return node.value;
    case "array": {
      const items: unknown[] = [];
      for (const child of node.children ?? []) items.push(materializeJsoncNode(child));
      return items;
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const prop of node.children ?? []) {
        if (prop.type !== "property" || !prop.children || prop.children.length < 2) continue;
        const keyNode = prop.children[0]!;
        const valueNode = prop.children[1]!;
        if (keyNode.type !== "string" || typeof keyNode.value !== "string") continue;
        setOwnValue(out, keyNode.value, materializeJsoncNode(valueNode));
      }
      return out;
    }
    default:
      return undefined;
  }
}

export function parseModelsDocument(filePath: string, raw: string | Uint8Array): ModelsConfig {
  const document = Buffer.from(raw).toString("utf8");
  const errors: ParseError[] = [];
  const tree = parseTree(document, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new ModelsConfigError(filePath, errors.map((error) => `offset ${error.offset}: ${error.error}`).join("; "));
  }
  if (!tree || tree.type !== "object") {
    throw new ModelsConfigError(filePath, "root must be a JSON object");
  }
  const root = materializeJsoncNode(tree) as Record<string, unknown>;
  if (root.providers !== undefined && (!root.providers || typeof root.providers !== "object" || Array.isArray(root.providers))) {
    throw new ModelsConfigError(filePath, "providers must be a JSON object when present");
  }
  const providersSource = (root.providers as Record<string, ProviderConfig> | undefined) ?? {};
  const ownProviders: Record<string, ProviderConfig> = {};
  for (const key of Object.keys(providersSource)) {
    if (!hasOwnKey(providersSource, key)) continue;
    setOwnValue(ownProviders, key, providersSource[key]!);
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
