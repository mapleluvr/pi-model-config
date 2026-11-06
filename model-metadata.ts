import { VERSION } from "@earendil-works/pi-coding-agent";
import { validateModelsCandidate } from "./config-validation.ts";
import { deepCloneJson, deepEqualJson, type ConfigPatch } from "./model-fields.ts";
import { getOwnValue, hasOwnKey, setOwnValue } from "./own-keys.ts";
import type { ModelConfig } from "./types.ts";

/** Complete replacement set; identity, connection settings and private payload are excluded. */
export const MODEL_METADATA_FIELDS = [
  "name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "thinkingLevelMap",
  "inputLimits", "promptCache", "samplingParams", "samplingParamsByThinkingLevel", "compat",
] as const;

export interface ModelMetadataEntry {
  provider: string;
  api: string;
  model: ModelConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

export function normalizeModelMetadataCatalog(raw: unknown): ModelMetadataEntry[] {
  if (!isRecord(raw)) throw new Error("pi.dev 模型目录格式无效");
  const entries: ModelMetadataEntry[] = [];
  for (const [provider, shard] of Object.entries(raw)) {
    if (!isIdentity(provider) || !isRecord(shard)) continue;
    for (const [id, value] of Object.entries(shard)) {
      if (!isRecord(value) || !isIdentity(id) || getOwnValue(value, "id") !== id) continue;
      if (hasOwnKey(value, "type") && getOwnValue(value, "type") !== "chat") continue;
      if (hasOwnKey(value, "provider") && getOwnValue(value, "provider") !== provider) continue;
      const api = getOwnValue(value, "api");
      const required = ["name", "reasoning", "input", "contextWindow", "maxTokens", "cost"];
      if (!isIdentity(api) || !required.every(key => hasOwnKey(value, key))) continue;
      const model = Object.fromEntries([
        ["id", id],
        ...MODEL_METADATA_FIELDS.filter(key => hasOwnKey(value, key)).map(key => [key, getOwnValue(value, key)]),
      ]) as ModelConfig;
      if (validateModelsCandidate({ providers: { catalog: { api, baseUrl: "https://pi.dev", models: [model] } } }).length > 0) continue;
      entries.push({ provider, api, model: deepCloneJson(model) });
    }
  }
  return entries;
}

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

async function readCatalogJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_CATALOG_BYTES) {
    await response.body?.cancel();
    throw new Error("pi.dev 模型目录响应过大");
  }
  if (!response.body) throw new Error("pi.dev 模型目录响应为空");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new Error("pi.dev 模型目录响应过大");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks, size);
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("pi.dev 模型目录不是有效 JSON");
  }
}

/** One public, version-scoped request per opened search; keystrokes filter locally. */
export async function loadModelMetadataCatalog(): Promise<ModelMetadataEntry[]> {
  const url = `https://pi.dev/api/models?pi-version=${encodeURIComponent(VERSION)}`;
  const response = await globalThis.fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "omit",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`pi.dev 模型目录请求失败 (HTTP ${response.status})`);
  const raw = await readCatalogJson(response);
  const entries = normalizeModelMetadataCatalog(raw);
  if (entries.length === 0) throw new Error("pi.dev 模型目录中没有可用的聊天模型元数据");
  return entries;
}

function previewValue(value: unknown): string {
  if (value === undefined) return "(未设置)";
  return JSON.stringify(value);
}

export function buildModelMetadataPatch(target: ModelConfig, source: ModelConfig): {
  patch: ConfigPatch<ModelConfig>;
  fieldBaselines: Record<string, unknown>;
  changes: string[];
} {
  const patch: ConfigPatch<ModelConfig> = {};
  const fieldBaselines: Record<string, unknown> = {};
  const changes: string[] = [];
  for (const key of MODEL_METADATA_FIELDS) {
    const before = getOwnValue(target, key);
    const after = getOwnValue(source, key);
    fieldBaselines[key] = deepCloneJson(before);
    if (deepEqualJson(before, after)) continue;
    setOwnValue(patch, key, after === undefined ? null : deepCloneJson(after));
    changes.push(`${key}: ${previewValue(before)} → ${after === undefined ? "清除（来源未设置）" : previewValue(after)}`);
  }
  return { patch, fieldBaselines, changes };
}
