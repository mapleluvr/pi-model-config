// ── models.json 配置读写 ──
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ModelsConfig, ProviderConfig } from "./types";

/** 获取 models.json 的完整路径 */
export function getModelsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "models.json");
}

/** 读取 models.json */
export function readModelsConfig(): ModelsConfig {
  const filePath = getModelsPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        providers: parsed.providers || {},
      };
    }
  } catch (err) {
    console.error(`[model-config] Failed to read models.json: ${err}`);
  }
  return { providers: {} };
}

/** 写入 models.json (合并已有配置) */
export function writeModelsConfig(config: ModelsConfig): void {
  const filePath = getModelsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // 先读取已有文件，保留未知字段
  let existing: any = {};
  try {
    if (fs.existsSync(filePath)) {
      existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    // 忽略
  }

  // 合并：保留 existing 中除 providers 之外的字段
  const merged: any = { ...existing, providers: config.providers };
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
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
  const config = readModelsConfig();
  return Object.keys(config.providers);
}

/** 获取指定 provider 配置 */
export function getProvider(providerId: string): ProviderConfig | undefined {
  const config = readModelsConfig();
  return config.providers[providerId];
}
