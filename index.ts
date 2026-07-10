// ── Pi 模型配置可视化编辑器 v2 ──
/**
 * 核心机制：
 * - Pi 的 /model 命令直接从 ~/.pi/agent/models.json 读取自定义模型
 * - 每次打开 /model 时自动重新加载该文件（无需 /reload）
 * - 本插件负责：可视化编辑 → 写入 models.json → 通知用户重开 /model
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getModelsPath, readModelsConfig, writeModelsConfig } from "./config.ts";
import {
  getModelPayload, mergePayloadIntoRequest, moveModelPayload, removeModelPayload,
  removeProviderPayloads, setModelPayload,
} from "./payload-config.ts";
import {
  applyCompatBooleanChoice, applyCompatObjectChoice, COMPAT_BOOLEAN_FIELDS,
  COMPAT_JSON_OBJECT_FIELDS, THINKING_FORMATS, type CompatBooleanChoice,
} from "./compat-settings.ts";
import { mergeModelConfig, mergeProviderConfig, replaceCostTiers, validateCostTier } from "./model-fields.ts";
import { THINKING_LEVELS, type ModelCostTier, type ModelsConfig, type ProviderConfig, type ModelConfig } from "./types.ts";
import { searchableSelect, type SearchableSelectOption } from "./searchable-select.ts";
import { searchableMultiSelect } from "./searchable-multi-select.ts";
import { buildToolSelectionOptions, normalizeToolList } from "./tool-options.ts";
import {
  formatSubagentOverrideSummary,
  formatToolsOverride,
  getInitialToolsSelection,
} from "./subagent-ui.ts";
import {
  BUILTIN_SUBAGENT_NAMES,
  SUBAGENT_THINKING_LEVELS,
  clearManagedSubagentModelFields,
  clearManagedSubagentToolFields,
  deleteSubagentAgentOverride,
  ensureSubagentAgentOverrides,
  appendSubagentFallbackModel,
  getActiveSubagentSettingsTargetForCwd,
  pullUserSubagentOverridesToProject,
  pushProjectSubagentOverridesToUser,
  readSubagentAgentOverrides,
  settingsHasSubagentAgentOverrides,
  updateSubagentAgentOverride,
  type SubagentAgentOverride,
} from "./subagent-settings.ts";

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

/** 从 OpenAI 兼容的 API 端点自动拉取模型列表 */
async function fetchModelsFromProvider(
  ctx: ExtensionCommandContext,
  providerId: string,
  provider: ProviderConfig,
): Promise<ModelConfig[] | null> {
  if (!provider.baseUrl) {
    ctx.ui.notify("请先设置 Provider 的 Base URL", "error");
    return null;
  }

  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  if (!provider.apiKey) {
    ctx.ui.notify("请先设置 API Key（即使是 Ollama 也需要填任意值如 'ollama'）", "warning");
    return null;
  }

  // 确定 model list endpoint
  // OpenAI-compatible: {baseUrl}/models
  // 有些: {baseUrl}/v1/models
  const candidates = [
    `${baseUrl}/models`,
    `${baseUrl}/v1/models`,
  ];

  // 尝试解析 API key（支持 $VAR 和 !cmd 格式）
  let actualKey = provider.apiKey;
  if (provider.apiKey.startsWith("$")) {
    const envVar = provider.apiKey.slice(1);
    actualKey = process.env[envVar] || "";
  }
  // !cmd 格式暂不在 fetch 时展开（安全问题），使用原始 key

  ctx.ui.notify(`正在拉取模型列表...\n${baseUrl}`, "info");

  let lastError: string | null = null;

  for (const endpoint of candidates) {
    try {
      const headers: Record<string, string> = {};
      if (actualKey && actualKey !== "ollama") {
        headers["Authorization"] = `Bearer ${actualKey}`;
      }

      const response = await fetch(endpoint, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status} @ ${endpoint}`;
        continue;
      }

      const data = await response.json() as any;

      // 解析不同格式的 model list
      let models: Array<{ id: string; name?: string }> = [];
      if (data.data && Array.isArray(data.data)) {
        // OpenAI 格式: { data: [{ id, ... }, ...] }
        models = data.data;
      } else if (Array.isArray(data)) {
        // 纯数组格式
        models = data;
      } else if (data.models && Array.isArray(data.models)) {
        // 其他格式: { models: [...] }
        models = data.models;
      }

      if (models.length === 0) {
        lastError = `服务器返回了空模型列表 @ ${endpoint}`;
        continue;
      }

      // 映射为 ModelConfig
      const result: ModelConfig[] = models.map((m: any) => ({
        id: m.id || m.name || "unknown",
        name: m.name || m.id || undefined,
      }));

      ctx.ui.notify(
        `成功拉取 ${result.length} 个模型\n` +
        `来源: ${endpoint}\n` +
        result.slice(0, 10).map((m) => m.id).join(", ") +
        (result.length > 10 ? `... 等 ${result.length - 10} 个` : ""),
        "success",
      );

      return result;
    } catch (err: any) {
      lastError = `${endpoint}: ${err.message || err}`;
      continue;
    }
  }

  ctx.ui.notify(`拉取失败: ${lastError}`, "error");
  return null;
}

function providerSummary(p: ProviderConfig): string {
  const name = p.name || "(未命名)";
  const api = p.api || "?";
  const count = p.models?.length ?? 0;
  return `${name}  [${api}]  ${count} models`;
}

function modelSummary(m: ModelConfig): string {
  const name = m.name || m.id;
  const r = m.reasoning ? " reasoning" : "";
  const ctx = m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k` : "?";
  const max = m.maxTokens ? `${(m.maxTokens / 1000).toFixed(0)}k` : "?";
  return `${name}${r}  ctx=${ctx}  max=${max}`;
}

const ACTION_ADD_MODEL = "__pi_model_config_action:add_model";
const ACTION_BACK = "__pi_model_config_action:back";
const ACTION_MANUAL_MODEL = "__pi_model_config_action:manual_model";
const ACTION_CLEAR_MODEL = "__pi_model_config_action:clear_model";
const ACTION_CURRENT_MODEL = "__pi_model_config_action:current_model";

function providerModelOptions(models: ModelConfig[]): SearchableSelectOption[] {
  return models.map((model, index) => ({
    value: `model:${index}`,
    label: `${index + 1}. Model ${model.id}`,
    description: modelSummary(model),
    searchText: [model.id, model.name, modelSummary(model)].filter(Boolean).join(" "),
  }));
}

function availableModelOptions(ctx: ExtensionCommandContext, current?: string): SearchableSelectOption[] {
  const registry = (ctx as ExtensionCommandContext & { modelRegistry?: { getAvailable?: () => any[] } }).modelRegistry;
  const models = registry?.getAvailable?.() ?? [];
  const seen = new Set<string>();
  const options: SearchableSelectOption[] = [];

  for (const model of models) {
    const provider = typeof model?.provider === "string" ? model.provider : "";
    const id = typeof model?.id === "string" ? model.id : "";
    if (!provider || !id) continue;

    const fullId = `${provider}/${id}`;
    if (seen.has(fullId)) continue;
    seen.add(fullId);

    const name = typeof model?.name === "string" && model.name !== id ? model.name : "";
    const description = [name, current === fullId ? "← 当前" : ""].filter(Boolean).join(" ");
    options.push({
      value: fullId,
      label: `Model ${fullId}`,
      description: description || undefined,
      searchText: `${fullId} ${provider} ${id} ${name}`,
    });
  }

  return options.sort((a, b) => a.value.localeCompare(b.value));
}

async function promptText(
  ctx: ExtensionCommandContext,
  title: string,
  message: string,
  defaultValue?: string,
): Promise<string | undefined> {
  const result = await ctx.ui.editor(
    `${title}\n\n${message}${defaultValue != null ? `\n\nCurrent value: ${defaultValue}` : ""}`,
    defaultValue ?? "",
  );
  return result === undefined ? undefined : result.trim();
}

function cloneModelsConfig(config: ModelsConfig): ModelsConfig {
  return structuredClone(config);
}

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function payloadLabel(key: string, value: unknown): string {
  const type = typeof value === "boolean" ? "bool" : typeof value === "string" ? "string" : "json";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const preview = serialized.length > 40 ? `${serialized.slice(0, 37)}...` : serialized;
  return `[${type}] ${key} = ${preview}`;
}

// ═══════════════════════════════════════════════════════
// 核心：保存到 models.json + 通知用户
// ═══════════════════════════════════════════════════════

/**
 * 保存 config 到 models.json。
 * Pi 会在用户下一次打开 /model 时自动重新加载该文件。
 */
function persistConfig(config: ModelsConfig, ctx?: ExtensionCommandContext): void {
  writeModelsConfig(config);
  const pCount = Object.keys(config.providers).length;
  let mCount = 0;
  for (const p of Object.values(config.providers)) mCount += (p.models || []).length;

  ctx?.ui.notify(
    `已保存 ${pCount} Providers / ${mCount} Models → ${getModelsPath()}\n` +
    `请关闭并重新打开 /model (Ctrl+L) 查看新模型`,
    "success",
  );
}

// ═══════════════════════════════════════════════════════
// Provider Editor
// ═══════════════════════════════════════════════════════

async function editProvider(
  ctx: ExtensionCommandContext,
  existing?: ProviderConfig & { _providerId?: string },
): Promise<{ providerId: string; config: ProviderConfig } | null> {
  const { _providerId: existingId, ...existingProvider } = existing ?? {};
  const base: ProviderConfig = existing ? existingProvider : { models: [] };
  const providerId = await promptText(
    ctx,
    existing ? "编辑 Provider" : "添加 Provider",
    "输入 Provider ID（唯一标识）：\n例如: ollama, my-llm, openrouter",
    existingId,
  );
  if (providerId === undefined) return null;
  if (!providerId.trim()) {
    ctx.ui.notify("Provider ID 不能为空", "error");
    return null;
  }

  const name = await promptText(ctx, `Provider: ${providerId}`, "显示名称（可选）", base.name);
  if (name === undefined) return null;
  const baseUrl = await promptText(ctx, `Provider: ${providerId}`, "API Base URL:\n例如 http://localhost:11434/v1", base.baseUrl);
  if (baseUrl === undefined) return null;

  const apiTypes = [
    "openai-completions - OpenAI Chat Completions（推荐，兼容性最广）",
    "anthropic-messages - Anthropic Messages",
    "openai-responses - OpenAI Responses",
    "google-generative-ai - Google Generative AI",
    "google-vertex - Google Vertex AI",
    "bedrock-converse-stream - Amazon Bedrock",
    "mistral-conversations - Mistral SDK",
  ];
  const apiChoice = await ctx.ui.select(`Provider: ${providerId} - API 类型`, apiTypes);
  if (apiChoice === undefined) return null;
  const apiKey = await promptText(
    ctx,
    `Provider: ${providerId}`,
    "API Key:\n  字面值: sk-xxx\n  环境变量: $MY_VAR\n  命令: !op read ...\n留空 = 无认证",
    base.apiKey,
  );
  if (apiKey === undefined) return null;
  const authChoice = await ctx.ui.select(`Provider: ${providerId} - Auth Header`, [
    "否 - 不自动添加 Bearer",
    "是 - 添加 Authorization: Bearer 头",
  ]);
  if (authChoice === undefined) return null;

  const changes: Record<string, unknown> = {
    name: name === "" ? null : name,
    baseUrl: baseUrl === "" ? null : baseUrl,
    api: apiChoice.split(" - ")[0]?.trim() || "openai-completions",
    apiKey: apiKey === "" ? null : apiKey,
    authHeader: authChoice.includes("是"),
  };

  const doCompat = await ctx.ui.confirm(`Provider: ${providerId}`, "配置高级兼容性选项？");
  if (doCompat) {
    const compat = await editCompat(ctx, providerId, base.compat);
    if (compat !== undefined) changes.compat = Object.keys(compat).length > 0 ? compat : null;
  }

  const config = mergeProviderConfig(base, changes);
  if ((!config.models || config.models.length === 0) && config.baseUrl) {
    const doFetch = await ctx.ui.confirm(
      `Provider: ${providerId}`,
      "当前没有配置任何 Model。要自动从 API 端点拉取模型列表吗？",
    );
    if (doFetch) {
      const fetched = await fetchModelsFromProvider(ctx, providerId, config);
      if (fetched && fetched.length > 0) config.models = fetched;
    }
  }

  return { providerId: providerId.trim(), config };
}

// ═══════════════════════════════════════════════════════
// Model Editor
// ═══════════════════════════════════════════════════════

interface ModelEditResult {
  model: ModelConfig;
  payload?: Record<string, unknown>;
}

function parseLegacyPayload(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const payload: Record<string, unknown> = {};
  for (const row of value) {
    if (!isPlainObject(row) || typeof row.key !== "string" || !row.key.trim() || typeof row.type !== "string" || typeof row.value !== "string") {
      return undefined;
    }
    if (row.type === "string") payload[row.key] = row.value;
    else if (row.type === "bool" && (row.value === "true" || row.value === "false")) payload[row.key] = row.value === "true";
    else if (row.type === "json") {
      try {
        payload[row.key] = JSON.parse(row.value);
      } catch {
        return undefined;
      }
    } else return undefined;
  }
  return payload;
}

function loadModelPayload(
  ctx: ExtensionCommandContext,
  providerId: string,
  existing?: ModelConfig,
): { payload?: Record<string, unknown> } {
  if (!existing) return {};
  const privatePayload = getModelPayload(providerId, existing.id);
  const legacy = (existing as Record<string, unknown>)["extraPayload"];
  if (privatePayload) return { payload: privatePayload };
  if (!Object.hasOwn(existing, "extraPayload")) return {};
  const migrated = parseLegacyPayload(legacy);
  if (!migrated) {
    ctx.ui.notify("Legacy extraPayload could not be migrated; it will be removed after a successful save", "error");
    return {};
  }
  return { payload: migrated };
}

function finiteNumberOr(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function manageCostTiers(
  ctx: ExtensionCommandContext,
  modelId: string,
  existingTiers?: ModelCostTier[],
): Promise<ModelCostTier[] | undefined> {
  const tiers = existingTiers ? existingTiers.map((tier) => ({ ...tier })) : [];

  while (true) {
    const items = tiers.map((tier, index) =>
      `Edit tier ${index + 1}: above ${tier.inputTokensAbove}, input ${tier.input}, output ${tier.output}`,
    );
    items.push("Add tier", "Delete tier", "Done");
    const choice = await ctx.ui.select(`Cost tiers - ${modelId}`, items);
    if (choice === undefined) return undefined;
    if (choice === "Done") return tiers;

    if (choice === "Delete tier") {
      if (tiers.length === 0) continue;
      const target = await ctx.ui.select(`Cost tiers - ${modelId}`, tiers.map((tier, index) =>
        `Delete tier ${index + 1}: above ${tier.inputTokensAbove}`,
      ));
      const match = target?.match(/^Delete tier (\d+):/);
      if (match) tiers.splice(Number.parseInt(match[1]!, 10) - 1, 1);
      continue;
    }

    const editMatch = choice.match(/^Edit tier (\d+):/);
    const index = choice === "Add tier" ? undefined : editMatch ? Number.parseInt(editMatch[1]!, 10) - 1 : undefined;
    if (choice !== "Add tier" && index === undefined) continue;
    const current = index === undefined ? undefined : tiers[index];
    const threshold = await promptText(ctx, `Cost tier - ${modelId}`, "Input tokens above:", current ? String(current.inputTokensAbove) : undefined);
    if (threshold === undefined) continue;
    const inputRate = await promptText(ctx, `Cost tier - ${modelId}`, "Input rate:", current ? String(current.input) : undefined);
    if (inputRate === undefined) continue;
    const outputRate = await promptText(ctx, `Cost tier - ${modelId}`, "Output rate:", current ? String(current.output) : undefined);
    if (outputRate === undefined) continue;
    const cacheReadRate = await promptText(ctx, `Cost tier - ${modelId}`, "Cache read rate:", current ? String(current.cacheRead) : undefined);
    if (cacheReadRate === undefined) continue;
    const cacheWriteRate = await promptText(ctx, `Cost tier - ${modelId}`, "Cache write rate:", current ? String(current.cacheWrite) : undefined);
    if (cacheWriteRate === undefined) continue;

    const candidate = validateCostTier({
      inputTokensAbove: Number.parseInt(threshold, 10),
      input: Number.parseFloat(inputRate),
      output: Number.parseFloat(outputRate),
      cacheRead: Number.parseFloat(cacheReadRate),
      cacheWrite: Number.parseFloat(cacheWriteRate),
    });
    if (!candidate) {
      ctx.ui.notify("Cost tier requires a positive integer threshold and non-negative finite rates", "error");
      continue;
    }
    if (index === undefined) tiers.push(candidate);
    else tiers[index] = candidate;
  }
}

async function editModel(
  ctx: ExtensionCommandContext,
  providerId: string,
  existing?: ModelConfig,
): Promise<ModelEditResult | null> {
  const modelId = await promptText(
    ctx,
    `Model - ${providerId}`,
    "Model ID（如 gpt-4o, llama3.1:8b）",
    existing?.id,
  );
  if (modelId === undefined) return null;
  if (!modelId.trim()) {
    ctx.ui.notify("Model ID 不能为空", "error");
    return null;
  }

  const base: ModelConfig = existing ?? {
    id: modelId.trim(), reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const payloadState = loadModelPayload(ctx, providerId, existing);
  let payload = payloadState.payload;
  const name = await promptText(ctx, `Model: ${modelId}`, "显示名称（留空使用 ID）", base.name);
  if (name === undefined) return null;
  const reasoningChoice = await ctx.ui.select(`Model: ${modelId} - Extended Thinking`, [
    `否${base.reasoning ? "" : " ← 当前"}`, `是${base.reasoning ? " ← 当前" : ""}`,
  ]);
  if (reasoningChoice === undefined) return null;
  const inputChoice = await ctx.ui.select(`Model: ${modelId} - 输入类型`, [
    `仅文本${!base.input?.includes("image") ? " ← 当前" : ""}`, `文本 + 图片${base.input?.includes("image") ? " ← 当前" : ""}`,
  ]);
  if (inputChoice === undefined) return null;
  const ctxWin = await promptText(ctx, `Model: ${modelId}`, "Context Window (tokens):", String(base.contextWindow ?? 128000));
  if (ctxWin === undefined) return null;
  const maxTok = await promptText(ctx, `Model: ${modelId}`, "Max Output Tokens:", String(base.maxTokens ?? 16384));
  if (maxTok === undefined) return null;
  const costIn = await promptText(ctx, `Model: ${modelId}`, "输入价格 ($/百万 tokens):", String(base.cost?.input ?? 0));
  if (costIn === undefined) return null;
  const costOut = await promptText(ctx, `Model: ${modelId}`, "输出价格 ($/百万 tokens):", String(base.cost?.output ?? 0));
  if (costOut === undefined) return null;

  const cost = {
    ...(base.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    input: finiteNumberOr(costIn, 0), output: finiteNumberOr(costOut, 0),
  };
  const changes: Record<string, unknown> = {
    id: modelId.trim(),
    name: name === "" ? null : name,
    reasoning: reasoningChoice.includes("是"),
    input: inputChoice.includes("图片") ? ["text", "image"] : ["text"],
    contextWindow: ctxWin === "" ? null : Number.parseInt(ctxWin, 10) || 128000,
    maxTokens: maxTok === "" ? null : Number.parseInt(maxTok, 10) || 16384,
    cost,
  };

  if (changes.reasoning) {
    const doMap = await ctx.ui.confirm(`Model: ${modelId}`, "配置 Thinking Level Map？");
    if (doMap) {
      const thinkingMap = { ...base.thinkingLevelMap };
      for (const level of THINKING_LEVELS) {
        const current = thinkingMap[level];
        const value = await promptText(
          ctx,
          `Model: ${modelId} - Thinking: ${level}`,
          'null = 禁用, "default" = 默认, 或自定义',
          current === null ? "null" : current ?? "",
        );
        if (value === undefined) break;
        if (value === "default") delete thinkingMap[level];
        else if (value === "null") thinkingMap[level] = null;
        else if (value !== "") thinkingMap[level] = value;
      }
      changes.thinkingLevelMap = Object.keys(thinkingMap).length > 0 ? thinkingMap : null;
    }
  }

  const doTiers = await ctx.ui.confirm(`Model: ${modelId}`, "管理 Cost tiers？");
  if (doTiers) {
    const tiers = await manageCostTiers(ctx, modelId, base.cost?.tiers);
    if (tiers !== undefined) changes.cost = replaceCostTiers(cost, tiers);
  }

  const doCompat = await ctx.ui.confirm(`Model: ${modelId}`, "配置高级兼容性选项？");
  if (doCompat) {
    const compat = await editCompat(ctx, modelId, base.compat);
    if (compat !== undefined) changes.compat = Object.keys(compat).length > 0 ? compat : null;
  }

  const model = mergeModelConfig(base, changes);
  const doPayload = await ctx.ui.confirm(
    `Model: ${modelId}`,
    `【Pi Agent 默认参数】\n` +
    `  contextWindow = ${model.contextWindow || 128000} tokens\n` +
    `  maxTokens      = ${model.maxTokens || 16384} tokens\n` +
    `  reasoning      = ${model.reasoning ? "是" : "否"}\n` +
    `  input          = ${(model.input || ["text"]).join(", ")}\n` +
    `  cost           = input $${model.cost?.input || 0} / output $${model.cost?.output || 0} (per 1M tokens)\n` +
    (model.thinkingLevelMap ? `  thinkingMap    = ${JSON.stringify(model.thinkingLevelMap)}\n` : "") +
    `\n是否管理 自定义 Payload 参数？（附加到 API 请求体的额外键值对）`,
  );
  if (doPayload) {
    const editedPayload = await editExtraPayload(ctx, modelId, payload);
    if (editedPayload !== undefined) payload = editedPayload;
  }

  return { model, payload };
}

// ═══════════════════════════════════════════════════════
// Extra Payload Editor — 自定义 API 请求体参数
// ═══════════════════════════════════════════════════════

async function editPayloadValue(
  ctx: ExtensionCommandContext,
  modelId: string,
  key: string,
  type: "string" | "bool" | "json",
  current?: unknown,
): Promise<unknown | undefined> {
  if (type === "bool") {
    const value = await ctx.ui.select(`Payload - ${modelId} - ${key}`, ["true", "false"]);
    return value === undefined ? undefined : value === "true";
  }
  if (type === "string") {
    return await promptText(ctx, `Payload - ${modelId} - ${key}`, "输入字符串值：", typeof current === "string" ? current : undefined);
  }
  const raw = await promptText(
    ctx,
    `Payload - ${modelId} - ${key} (JSON)`,
    "输入合法 JSON 值：",
    current === undefined ? undefined : JSON.stringify(current, null, 2),
  );
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    ctx.ui.notify("JSON 格式不合法", "error");
    return undefined;
  }
}

async function editExtraPayload(
  ctx: ExtensionCommandContext,
  modelId: string,
  existing?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const payload = structuredClone(existing ?? {});

  while (true) {
    const entries = Object.entries(payload);
    const items = entries.map(([key, value], index) => `${index + 1}. ${payloadLabel(key, value)}`);
    items.push("添加参数", "完成");
    const choice = await ctx.ui.select(`Payload 参数 - ${modelId} (${entries.length} 个)`, items);
    if (choice === undefined) return undefined;
    if (choice === "完成") {
      if (!isPlainObject(payload)) {
        ctx.ui.notify("Payload must be a JSON object", "error");
        continue;
      }
      return payload;
    }

    if (choice === "添加参数") {
      const key = await promptText(ctx, `Payload - ${modelId}`, "参数键名（如 temperature, top_p）：");
      if (key === undefined || !key.trim()) continue;
      if (Object.hasOwn(payload, key)) {
        ctx.ui.notify(`参数 "${key}" 已存在`, "warning");
        continue;
      }
      const typeChoice = await ctx.ui.select(`Payload - ${modelId} - ${key}`, [
        "string - 字符串", "bool - 布尔值 (true/false)", "json - JSON 值",
      ]);
      if (typeChoice === undefined) continue;
      const type = typeChoice.startsWith("bool") ? "bool" : typeChoice.startsWith("json") ? "json" : "string";
      const value = await editPayloadValue(ctx, modelId, key, type);
      if (value === undefined) continue;
      payload[key] = value;
      ctx.ui.notify(`参数 "${key}" 已添加`, "success");
      continue;
    }

    const indexMatch = choice.match(/^(\d+)\./);
    if (!indexMatch) continue;
    const entry = entries[Number.parseInt(indexMatch[1]!, 10) - 1];
    if (!entry) continue;
    const [key, value] = entry;
    const action = await ctx.ui.select(`Payload: ${payloadLabel(key, value)}`, ["修改", "删除", "返回"]);
    if (!action || action === "返回") continue;
    if (action === "删除") {
      delete payload[key];
      ctx.ui.notify(`参数 "${key}" 已删除`, "info");
      continue;
    }
    const type = typeof value === "boolean" ? "bool" : typeof value === "string" ? "string" : "json";
    const nextValue = await editPayloadValue(ctx, modelId, key, type, value);
    if (nextValue === undefined) continue;
    payload[key] = nextValue;
    ctx.ui.notify(`参数 "${key}" 已更新`, "success");
  }
}

// ═══════════════════════════════════════════════════════
// Compat Editor
// ═══════════════════════════════════════════════════════

async function editCompat(
  ctx: ExtensionCommandContext,
  parentId: string,
  existing?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  let c: Record<string, unknown> = existing ? { ...existing } : {};

  while (true) {
    const items = [
      ...COMPAT_BOOLEAN_FIELDS.map((field) => {
        const value = c[field.key];
        return `${value === true ? "[yes]" : value === false ? "[no]" : "[-]"} ${field.label}`;
      }),
      `maxTokensField = ${c.maxTokensField ?? "(unset)"}`,
      `thinkingFormat = ${c.thinkingFormat ?? "(unset)"}`,
      `cacheControlFormat = ${c.cacheControlFormat ?? "(unset)"}`,
      ...COMPAT_JSON_OBJECT_FIELDS.map((field) => `${field.label} = ${c[field.key] === undefined ? "(unset)" : "(set)"}`),
      "完成",
    ];
    const choice = await ctx.ui.select(`Compat - ${parentId}`, items);
    if (choice === undefined) return undefined;
    if (choice === "完成") return c;

    const boolField = COMPAT_BOOLEAN_FIELDS.find((field) => choice.includes(field.label));
    if (boolField) {
      const current = c[boolField.key];
      const valueChoice = await ctx.ui.select(`Compat - ${parentId} - ${boolField.label}`, [
        `${current === undefined ? "[当前] " : ""}不指定 / 使用默认值`,
        `${current === false ? "[当前] " : ""}false`,
        `${current === true ? "[当前] " : ""}true`,
        "返回",
      ]);
      if (!valueChoice || valueChoice === "返回") continue;
      const compatChoice: CompatBooleanChoice = valueChoice.includes("false")
        ? "false"
        : valueChoice.includes("true") ? "true" : "default";
      c = applyCompatBooleanChoice(c, boolField.key, compatChoice);
      continue;
    }
    if (choice.startsWith("maxTokensField")) {
      const value = await ctx.ui.select(`Compat - ${parentId}`, ["max_completion_tokens", "max_tokens", "(clear)"]);
      if (value === "(clear)") delete c.maxTokensField;
      else if (value !== undefined) c.maxTokensField = value;
      continue;
    }
    if (choice.startsWith("thinkingFormat")) {
      const value = await ctx.ui.select(`Compat - ${parentId}`, [...THINKING_FORMATS, "(clear)"]);
      if (value === "(clear)") delete c.thinkingFormat;
      else if (value !== undefined) c.thinkingFormat = value;
      continue;
    }
    if (choice.startsWith("cacheControlFormat")) {
      const value = await ctx.ui.select(`Compat - ${parentId}`, ["anthropic", "(clear)"]);
      if (value === "(clear)") delete c.cacheControlFormat;
      else if (value !== undefined) c.cacheControlFormat = value;
      continue;
    }

    const objectField = COMPAT_JSON_OBJECT_FIELDS.find((field) => choice.startsWith(field.label));
    if (!objectField) continue;
    const current = c[objectField.key];
    const raw = await ctx.ui.editor(
      `Compat - ${parentId} - ${objectField.label}`,
      current === undefined ? "" : JSON.stringify(current, null, 2),
    );
    if (raw === undefined) continue;
    if (!raw.trim()) {
      c = applyCompatObjectChoice(c, objectField.key, undefined);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error("must be a JSON object");
      c = applyCompatObjectChoice(c, objectField.key, parsed);
    } catch (error) {
      ctx.ui.notify(`Invalid ${objectField.label}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}

// ═══════════════════════════════════════════════════════
// Provider Management
// ═══════════════════════════════════════════════════════

function persistNextConfig(ctx: ExtensionCommandContext, nextConfig: ModelsConfig): boolean {
  try {
    persistConfig(nextConfig, ctx);
    return true;
  } catch (error) {
    notifyError(ctx, error);
    return false;
  }
}

function updateModelPayloadAfterSave(
  ctx: ExtensionCommandContext,
  providerId: string,
  updated: ModelConfig,
  payload: Record<string, unknown> | undefined,
  existing?: ModelConfig,
): void {
  try {
    if (payload && Object.keys(payload).length > 0) setModelPayload(providerId, updated.id, payload);
    else removeModelPayload(providerId, updated.id);
    if (existing && existing.id !== updated.id) removeModelPayload(providerId, existing.id);
  } catch (error) {
    notifyError(ctx, error);
  }
}

async function manageProviders(
  ctx: ExtensionCommandContext,
  initialConfig: ModelsConfig,
): Promise<ModelsConfig> {
  let config = initialConfig;
  while (true) {
    const pids = Object.keys(config.providers);
    const items = pids.map((pid) => `编辑 [${pid}] ${providerSummary(config.providers[pid]!)}`);
    items.push("添加新 Provider", "返回主菜单");
    const choice = await ctx.ui.select("Provider 管理", items);
    if (choice === undefined || choice.startsWith("返回")) return config;

    if (choice.startsWith("添加")) {
      const result = await editProvider(ctx);
      if (!result) continue;
      const nextConfig = cloneModelsConfig(config);
      nextConfig.providers[result.providerId] = structuredClone(result.config);
      if (persistNextConfig(ctx, nextConfig)) config = nextConfig;
      continue;
    }

    const match = choice.match(/^编辑\s+\[(.+?)\]/);
    if (!match) continue;
    const providerId = match[1]!;
    const existing = config.providers[providerId];
    if (!existing) continue;
    const action = await ctx.ui.select(`Provider: ${providerId}`, [
      "编辑设置", "管理 Models", "自动拉取 Model 列表（从 API 发现）", "复制 Provider", "删除 Provider", "返回",
    ]);
    if (!action || action.startsWith("返回")) continue;

    if (action.startsWith("删除")) {
      if (!await ctx.ui.confirm("确认删除", `删除 Provider "${providerId}" 及其所有 Models？`)) continue;
      const nextConfig = cloneModelsConfig(config);
      delete nextConfig.providers[providerId];
      if (persistNextConfig(ctx, nextConfig)) {
        config = nextConfig;
        try {
          removeProviderPayloads(providerId);
        } catch (error) {
          notifyError(ctx, error);
        }
      }
      continue;
    }
    if (action.startsWith("复制")) {
      const newId = await promptText(ctx, "复制 Provider", "输入新 ID", `${providerId}-copy`);
      if (newId === undefined || !newId.trim()) continue;
      const nextConfig = cloneModelsConfig(config);
      nextConfig.providers[newId.trim()] = structuredClone(existing);
      if (persistNextConfig(ctx, nextConfig)) config = nextConfig;
      continue;
    }
    if (action.startsWith("管理")) {
      config = await manageModels(ctx, providerId, config);
      continue;
    }
    if (action.startsWith("自动拉取")) {
      const fetched = await fetchModelsFromProvider(ctx, providerId, existing);
      if (!fetched || fetched.length === 0) continue;
      const replace = await ctx.ui.confirm(
        `发现 ${fetched.length} 个模型`,
        `拉取到的模型:\n${fetched.map((model) => `  - ${model.id}`).join("\n")}\n\n` +
        `当前已有 ${(existing.models || []).length} 个模型。\n` +
        "是 = 替换现有模型\n否 = 合并到现有列表（去重）",
      );
      const nextConfig = cloneModelsConfig(config);
      const nextProvider = nextConfig.providers[providerId]!;
      if (replace) nextProvider.models = fetched;
      else {
        const currentModels = nextProvider.models ?? [];
        const existingIds = new Set(currentModels.map((model) => model.id));
        nextProvider.models = [...currentModels, ...fetched.filter((model) => !existingIds.has(model.id))];
      }
      if (persistNextConfig(ctx, nextConfig)) config = nextConfig;
      continue;
    }
    if (action.startsWith("编辑")) {
      const result = await editProvider(ctx, { ...existing, _providerId: providerId });
      if (!result) continue;
      const nextConfig = cloneModelsConfig(config);
      delete nextConfig.providers[providerId];
      nextConfig.providers[result.providerId] = structuredClone(result.config);
      if (persistNextConfig(ctx, nextConfig)) {
        config = nextConfig;
        if (result.providerId !== providerId) {
          for (const model of existing.models ?? []) {
            try {
              moveModelPayload(providerId, model.id, result.providerId, model.id);
            } catch (error) {
              notifyError(ctx, error);
              break;
            }
          }
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
// Model Management
// ═══════════════════════════════════════════════════════

async function manageModels(
  ctx: ExtensionCommandContext,
  providerId: string,
  initialConfig: ModelsConfig,
): Promise<ModelsConfig> {
  let config = initialConfig;
  while (true) {
    const provider = config.providers[providerId];
    if (!provider) return config;
    const models = provider.models ?? [];
    const choice = await searchableSelect(
      ctx,
      `Models - ${providerId}`,
      [
        ...providerModelOptions(models),
        { value: ACTION_ADD_MODEL, label: "添加新 Model", searchText: "add new model 添加 新增" },
        { value: ACTION_BACK, label: "返回", searchText: "back return 返回" },
      ],
      { maxVisible: 10, hint: "输入 model id/name 搜索，↑/↓ 选择，Enter 操作，Esc 返回" },
    );
    if (choice === undefined || choice === ACTION_BACK) return config;

    if (choice === ACTION_ADD_MODEL) {
      const result = await editModel(ctx, providerId);
      if (!result) continue;
      const modelToSave = structuredClone(result.model);
      delete (modelToSave as Record<string, unknown>)["extraPayload"];
      const nextConfig = cloneModelsConfig(config);
      (nextConfig.providers[providerId]!.models ??= []).push(modelToSave);
      if (persistNextConfig(ctx, nextConfig)) {
        config = nextConfig;
        updateModelPayloadAfterSave(ctx, providerId, modelToSave, result.payload);
      }
      continue;
    }

    const match = choice.match(/^model:(\d+)$/);
    if (!match) continue;
    const index = Number.parseInt(match[1]!, 10);
    const existing = models[index];
    if (!existing) continue;
    const action = await ctx.ui.select(`Model: ${modelSummary(existing)}`, ["编辑", "复制", "删除", "返回"]);
    if (!action || action.startsWith("返回")) continue;

    if (action.startsWith("删除")) {
      if (!await ctx.ui.confirm("确认删除", `删除 Model "${existing.id}"？`)) continue;
      const nextConfig = cloneModelsConfig(config);
      nextConfig.providers[providerId]!.models!.splice(index, 1);
      if (persistNextConfig(ctx, nextConfig)) {
        config = nextConfig;
        try {
          removeModelPayload(providerId, existing.id);
        } catch (error) {
          notifyError(ctx, error);
        }
      }
      continue;
    }
    if (action.startsWith("复制")) {
      const modelCopy = structuredClone(existing);
      delete (modelCopy as Record<string, unknown>)["extraPayload"];
      modelCopy.id = `${existing.id}-copy`;
      modelCopy.name = `${existing.name || existing.id} (Copy)`;
      const nextConfig = cloneModelsConfig(config);
      (nextConfig.providers[providerId]!.models ??= []).push(modelCopy);
      if (persistNextConfig(ctx, nextConfig)) config = nextConfig;
      continue;
    }
    if (action.startsWith("编辑")) {
      const result = await editModel(ctx, providerId, existing);
      if (!result) continue;
      const modelToSave = structuredClone(result.model);
      delete (modelToSave as Record<string, unknown>)["extraPayload"];
      const nextConfig = cloneModelsConfig(config);
      nextConfig.providers[providerId]!.models![index] = modelToSave;
      if (persistNextConfig(ctx, nextConfig)) {
        config = nextConfig;
        updateModelPayloadAfterSave(ctx, providerId, modelToSave, result.payload, existing);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
// Subagent Model Settings
// ═══════════════════════════════════════════════════════

function getCommandCwd(ctx: ExtensionCommandContext): string {
  return (ctx as ExtensionCommandContext & { cwd?: string }).cwd || process.cwd();
}

function formatFallbackModels(models?: string[]): string {
  return models && models.length > 0 ? models.join(", ") : "(未设置)";
}

function overrideSummary(agentName: string, override?: SubagentAgentOverride): string {
  return formatSubagentOverrideSummary(agentName, override);
}

function parseFallbackInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function chooseModelOverride(
  ctx: ExtensionCommandContext,
  agentName: string,
  current?: string,
): Promise<string | undefined | "__clear__" | "__cancel__"> {
  const modelOptions = availableModelOptions(ctx, current);
  const currentOption: SearchableSelectOption[] = current && !modelOptions.some((option) => option.value === current)
    ? [{
      value: ACTION_CURRENT_MODEL,
      label: `当前: ${current}`,
      description: "当前 override，不变",
      searchText: current,
    }]
    : [];

  const choice = await searchableSelect(
    ctx,
    `Subagent ${agentName} - 选择 Model`,
    [
      ...currentOption,
      ...modelOptions,
      { value: ACTION_MANUAL_MODEL, label: "手动输入 model id", searchText: "manual input 手动 输入" },
      { value: ACTION_CLEAR_MODEL, label: "清除 model override", searchText: "clear remove 清除 删除" },
      { value: ACTION_BACK, label: "返回", searchText: "back return 返回" },
    ],
    {
      maxVisible: 10,
      initialValue: current,
      hint: "输入 provider/model 或模型名搜索，↑/↓ 选择，Enter 确认，Esc 返回",
    },
  );

  if (!choice || choice === ACTION_BACK || choice === ACTION_CURRENT_MODEL) return "__cancel__";
  if (choice === ACTION_CLEAR_MODEL) return "__clear__";
  if (choice === ACTION_MANUAL_MODEL) {
    const manual = await promptText(
      ctx,
      `Subagent ${agentName} - 手动 model`,
      "输入 model，建议使用 provider/model 格式，也可带 thinking suffix：\n例如 Mapleluv/gpt-5.5 或 anthropic/claude-sonnet-4:high",
      current,
    );
    return manual || "__cancel__";
  }
  return choice;
}

async function chooseFallbackModelToAppend(
  ctx: ExtensionCommandContext,
  agentName: string,
): Promise<string | undefined> {
  const choice = await searchableSelect(
    ctx,
    `Subagent ${agentName} - 添加 fallback model`,
    [
      ...availableModelOptions(ctx),
      { value: ACTION_MANUAL_MODEL, label: "手动输入 fallback model id", searchText: "manual input 手动 输入 fallback" },
      { value: ACTION_BACK, label: "返回", searchText: "back return 返回" },
    ],
    {
      maxVisible: 10,
      hint: "输入 provider/model 或模型名搜索，↑/↓ 选择，Enter 添加，Esc 返回",
    },
  );

  if (!choice || choice === ACTION_BACK) return undefined;
  if (choice === ACTION_MANUAL_MODEL) {
    return await promptText(
      ctx,
      `Subagent ${agentName} - 手动 fallback model`,
      "输入 fallback model，建议使用 provider/model 格式：\n例如 Mapleluv/deepseek-v4-pro 或 openai/gpt-5-mini",
    );
  }
  return choice;
}

async function confirmSubagentToolIfNeeded(ctx: ExtensionCommandContext, tools: string[]): Promise<boolean> {
  if (!tools.includes("subagent")) return true;
  return await ctx.ui.confirm(
    "允许 subagent 工具？",
    "你正在允许子 agent 使用 subagent 工具。这会授权 nested fanout 能力。确定要保存吗？",
  );
}

async function editSubagentToolsOverride(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settingsPath: string,
  agentName: string,
  current: SubagentAgentOverride,
): Promise<void> {
  const parentToolNames = pi.getActiveTools();
  const toolOptions = buildToolSelectionOptions(parentToolNames, pi.getAllTools());

  while (true) {
    const latest = readSubagentAgentOverrides(settingsPath)[agentName] ?? current;
    const action = await ctx.ui.select(`Subagent ${agentName} - tools`, [
      `当前: ${formatToolsOverride(latest.tools)}`,
      "设置 allowlist（从母 Agent 当前工具选择）",
      "使用母 Agent 当前工具列表",
      "手动输入工具列表",
      "使用 agent 默认 tools（删除 override）",
      "禁用所有 tools",
      "返回",
    ]);

    if (!action || action.startsWith("返回")) return;
    if (action.startsWith("当前")) {
      ctx.ui.notify(formatToolsOverride(latest.tools), "info");
      continue;
    }

    if (action.startsWith("设置 allowlist")) {
      if (toolOptions.length === 0) {
        ctx.ui.notify("母 Agent 当前没有可枚举的 active tools。请使用手动输入工具列表。", "warning");
        continue;
      }

      const selected = await searchableMultiSelect(
        ctx,
        `Subagent ${agentName} - tools allowlist`,
        toolOptions,
        getInitialToolsSelection(parentToolNames, latest.tools),
        {
          maxVisible: 10,
          hint: "输入关键字过滤，空格切换，a 全选，n 清空，Enter 保存，Esc 取消",
        },
      );
      if (selected === undefined) continue;
      if (selected.length === 0) {
        ctx.ui.notify("未选择任何工具。如需禁用全部工具，请选择“禁用所有 tools”。", "warning");
        continue;
      }
      if (!await confirmSubagentToolIfNeeded(ctx, selected)) continue;
      updateSubagentAgentOverride(settingsPath, agentName, { tools: selected });
      ctx.ui.notify(`已更新 ${agentName} tools allowlist (${selected.length})`, "success");
      continue;
    }

    if (action.startsWith("使用母 Agent 当前工具列表")) {
      if (parentToolNames.length === 0) {
        ctx.ui.notify("母 Agent 当前 active tools 为空，未更新。", "warning");
        continue;
      }
      if (!await confirmSubagentToolIfNeeded(ctx, parentToolNames)) continue;
      updateSubagentAgentOverride(settingsPath, agentName, { tools: parentToolNames });
      ctx.ui.notify(`已将 ${agentName} tools 设置为母 Agent 当前工具列表 (${parentToolNames.length})`, "success");
      continue;
    }

    if (action.startsWith("手动输入")) {
      const raw = await promptText(
        ctx,
        `Subagent ${agentName} - 手动 tools`,
        "输入 tools 列表，用逗号、空格或换行分隔。MCP direct tool 使用 mcp: 前缀。",
        Array.isArray(latest.tools) ? latest.tools.join("\n") : parentToolNames.join("\n"),
      );
      if (raw === undefined) continue;
      const tools = normalizeToolList(raw);
      if (tools.length === 0) {
        ctx.ui.notify("未输入任何工具。如需禁用全部工具，请选择“禁用所有 tools”。", "warning");
        continue;
      }
      if (!await confirmSubagentToolIfNeeded(ctx, tools)) continue;
      updateSubagentAgentOverride(settingsPath, agentName, { tools });
      ctx.ui.notify(`已更新 ${agentName} tools allowlist (${tools.length})`, "success");
      continue;
    }

    if (action.startsWith("使用 agent 默认")) {
      clearManagedSubagentToolFields(settingsPath, agentName);
      ctx.ui.notify(`已删除 ${agentName} tools override，将使用 agent 默认 tools`, "success");
      continue;
    }

    if (action.startsWith("禁用所有")) {
      const ok = await ctx.ui.confirm(
        `禁用 ${agentName} 所有 tools？`,
        "这会写入 tools=false，使该 subagent 没有显式可用工具。确定？",
      );
      if (!ok) continue;
      updateSubagentAgentOverride(settingsPath, agentName, { tools: false });
      ctx.ui.notify(`已禁用 ${agentName} 的所有 tools`, "success");
      continue;
    }
  }
}

async function editSubagentAgentOverride(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settingsPath: string,
  agentName: string,
): Promise<void> {
  while (true) {
    const overrides = readSubagentAgentOverrides(settingsPath);
    const current = overrides[agentName] ?? {};
    const action = await ctx.ui.select(`Subagent: ${agentName}`, [
      `当前 model: ${current.model || "(默认 Pi 当前模型)"}`,
      `当前 thinking: ${current.thinking || "(未设置)"}`,
      `当前 fallbackModels: ${formatFallbackModels(current.fallbackModels)}`,
      `当前 tools: ${formatToolsOverride(current.tools)}`,
      "设置 model",
      "设置 thinking",
      "设置 fallbackModels",
      "设置 tools allowlist",
      "清除 model/thinking/fallbackModels",
      "清除 tools override",
      "删除整个 agent override",
      "返回",
    ]);
    if (!action || action.startsWith("返回")) return;

    if (action.startsWith("设置 model")) {
      const selected = await chooseModelOverride(ctx, agentName, current.model);
      if (selected === "__cancel__") continue;
      updateSubagentAgentOverride(settingsPath, agentName, {
        model: selected === "__clear__" ? undefined : selected,
      });
      ctx.ui.notify(`已更新 ${agentName} model override`, "success");
      continue;
    }

    if (action.startsWith("设置 thinking")) {
      const choices = [
        ...(current.thinking ? [`当前: ${current.thinking}`] : []),
        ...SUBAGENT_THINKING_LEVELS.map((level) => `${level}${current.thinking === level ? " ← 当前" : ""}`),
        "清除 thinking override",
        "返回",
      ];
      const choice = await ctx.ui.select(`Subagent ${agentName} - Thinking`, choices);
      if (!choice || choice.startsWith("返回") || choice.startsWith("当前:")) continue;
      updateSubagentAgentOverride(settingsPath, agentName, {
        thinking: choice.startsWith("清除") ? undefined : choice.split(" ")[0],
      });
      ctx.ui.notify(`已更新 ${agentName} thinking override`, "success");
      continue;
    }

    if (action.startsWith("设置 fallbackModels")) {
      const fallbackAction = await ctx.ui.select(`Subagent ${agentName} - fallbackModels`, [
        "从模型选择器添加 fallback model",
        "手动编辑 fallbackModels",
        "清除 fallbackModels",
        "返回",
      ]);
      if (!fallbackAction || fallbackAction.startsWith("返回")) continue;
      if (fallbackAction.startsWith("从模型选择器")) {
        const selected = await chooseFallbackModelToAppend(ctx, agentName);
        if (!selected) continue;
        const fallbackModels = appendSubagentFallbackModel(settingsPath, agentName, selected);
        ctx.ui.notify(`已添加 ${agentName} fallback model：${selected}（共 ${fallbackModels.length} 个）`, "success");
        continue;
      }
      if (fallbackAction.startsWith("清除")) {
        updateSubagentAgentOverride(settingsPath, agentName, { fallbackModels: undefined });
        ctx.ui.notify(`已清除 ${agentName} fallbackModels`, "success");
        continue;
      }
      const raw = await promptText(
        ctx,
        `Subagent ${agentName} - fallbackModels`,
        "输入 fallback model 列表，用逗号或换行分隔：",
        current.fallbackModels?.join("\n") || "",
      );
      if (raw === undefined) continue;
      const fallbackModels = parseFallbackInput(raw);
      updateSubagentAgentOverride(settingsPath, agentName, { fallbackModels });
      ctx.ui.notify(`已更新 ${agentName} fallbackModels (${fallbackModels.length})`, "success");
      continue;
    }

    if (action.startsWith("设置 tools")) {
      await editSubagentToolsOverride(pi, ctx, settingsPath, agentName, current);
      continue;
    }

    if (action.startsWith("清除 model/thinking/fallbackModels")) {
      const ok = await ctx.ui.confirm(
        `清除 ${agentName} 模型相关字段`,
        "清除 model、thinking、fallbackModels。若该 agent override 没有其他字段，将删除该 agent override。",
      );
      if (!ok) continue;
      clearManagedSubagentModelFields(settingsPath, agentName);
      ctx.ui.notify(`已清除 ${agentName} 的 Subagent 模型相关字段`, "success");
      continue;
    }

    if (action.startsWith("清除 tools")) {
      clearManagedSubagentToolFields(settingsPath, agentName);
      ctx.ui.notify(`已删除 ${agentName} tools override，将使用 agent 默认 tools`, "success");
      continue;
    }

    if (action.startsWith("删除")) {
      const ok = await ctx.ui.confirm(
        `删除 ${agentName} override`,
        "这会删除该 agent 在 subagents.agentOverrides 下的整个 override，包括非模型字段。确定？",
      );
      if (!ok) continue;
      deleteSubagentAgentOverride(settingsPath, agentName);
      ctx.ui.notify(`已删除 ${agentName} override`, "success");
      continue;
    }
  }
}

async function syncProjectSubagentConfigToUser(ctx: ExtensionCommandContext, projectSettingsPath: string, userSettingsPath: string): Promise<void> {
  if (!settingsHasSubagentAgentOverrides(projectSettingsPath)) {
    ctx.ui.notify(
      `当前项目没有 subagents.agentOverrides，无法覆盖公共配置。\n项目配置: ${projectSettingsPath}`,
      "warning",
    );
    return;
  }
  const projectOverrides = readSubagentAgentOverrides(projectSettingsPath);
  const count = Object.keys(projectOverrides).length;
  const ok = await ctx.ui.confirm(
    "项目配置覆盖公共配置？",
    `将用当前项目配置覆盖公共配置中的 subagents.agentOverrides。\n\n` +
    `来源: ${projectSettingsPath}\n` +
    `目标: ${userSettingsPath}\n` +
    `将复制 ${count} 个 agent override。\n\n` +
    `只会覆盖目标文件的 subagents.agentOverrides，保留其他 settings 字段。`,
  );
  if (!ok) return;
  try {
    const copied = pushProjectSubagentOverridesToUser(projectSettingsPath, userSettingsPath);
    ctx.ui.notify(`已用项目配置覆盖公共 Subagent 配置：${copied} 个 agent override`, "success");
  } catch (err) {
    ctx.ui.notify(`覆盖失败: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

async function syncUserSubagentConfigToProject(ctx: ExtensionCommandContext, userSettingsPath: string, projectSettingsPath: string): Promise<void> {
  if (!settingsHasSubagentAgentOverrides(userSettingsPath)) {
    ctx.ui.notify(
      `公共配置没有 subagents.agentOverrides，无法抓取到本项目。\n公共配置: ${userSettingsPath}`,
      "warning",
    );
    return;
  }
  const userOverrides = readSubagentAgentOverrides(userSettingsPath);
  const count = Object.keys(userOverrides).length;
  const ok = await ctx.ui.confirm(
    "公共配置覆盖项目配置？",
    `将用公共配置覆盖当前项目配置中的 subagents.agentOverrides。\n\n` +
    `来源: ${userSettingsPath}\n` +
    `目标: ${projectSettingsPath}\n` +
    `将复制 ${count} 个 agent override。\n\n` +
    `只会覆盖目标文件的 subagents.agentOverrides，保留其他 settings 字段。`,
  );
  if (!ok) return;
  try {
    const copied = pullUserSubagentOverridesToProject(userSettingsPath, projectSettingsPath);
    ctx.ui.notify(`已抓取公共 Subagent 配置到本项目：${copied} 个 agent override`, "success");
  } catch (err) {
    ctx.ui.notify(`抓取失败: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

function settingsCountLabel(settingsPath: string): string {
  if (!settingsHasSubagentAgentOverrides(settingsPath)) return "未创建";
  return `${Object.keys(readSubagentAgentOverrides(settingsPath)).length} overrides`;
}

async function editSubagentSettingsFile(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settingsPath: string,
  title: string,
  createIfMissing: boolean,
): Promise<void> {
  if (createIfMissing) ensureSubagentAgentOverrides(settingsPath);
  while (true) {
    const overrides = readSubagentAgentOverrides(settingsPath);
    const items = [
      `编辑目标: ${title} (${settingsPath})`,
      ...BUILTIN_SUBAGENT_NAMES.map((agent) => overrideSummary(agent, overrides[agent])),
      "返回 Subagent 配置菜单",
    ];
    const choice = await ctx.ui.select(title, items);
    if (!choice || choice.startsWith("返回")) return;
    if (choice.startsWith("编辑目标")) {
      ctx.ui.notify(`当前编辑 ${title}\n路径: ${settingsPath}`, "info");
      continue;
    }
    const match = choice.match(/^编辑\s+\[(.+?)\]/);
    if (match) {
      await editSubagentAgentOverride(pi, ctx, settingsPath, match[1]!);
    }
  }
}

async function manageSubagentModelSettings(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const cwd = getCommandCwd(ctx);
    const paths = getActiveSubagentSettingsTargetForCwd(cwd);
    const items = [
      `路径信息（项目: ${paths.projectSettingsPath} / 公共: ${paths.userSettingsPath}）`,
      `编辑本项目配置 (${settingsCountLabel(paths.projectSettingsPath)})`,
      `编辑公共配置 (${settingsCountLabel(paths.userSettingsPath)})`,
      "本项目配置 -> 公共配置",
      "公共配置 -> 本项目配置",
      "返回主菜单",
    ];

    const choice = await ctx.ui.select("Subagent 配置", items);
    if (!choice || choice.startsWith("返回")) return;

    if (choice.startsWith("路径")) {
      ctx.ui.notify(
        `当前工作目录: ${cwd}\n` +
        `项目配置: ${paths.projectSettingsPath}\n` +
        `公共配置: ${paths.userSettingsPath}\n\n` +
        `选择“编辑本项目配置”会创建/编辑项目 subagents.agentOverrides。\n` +
        `选择“编辑公共配置”才会写入公共 settings。\n\n` +
        `联动关系: model-config 负责可视化编辑；pi-subagents 负责读取并应用这些 Subagent 模型覆盖配置。`,
        "info",
      );
      continue;
    }

    if (choice.startsWith("编辑本项目")) {
      await editSubagentSettingsFile(pi, ctx, paths.projectSettingsPath, "本项目 Subagent 配置", true);
      continue;
    }

    if (choice.startsWith("编辑公共")) {
      await editSubagentSettingsFile(pi, ctx, paths.userSettingsPath, "公共 Subagent 配置", false);
      continue;
    }

    if (choice.startsWith("本项目配置")) {
      await syncProjectSubagentConfigToUser(ctx, paths.projectSettingsPath, paths.userSettingsPath);
      continue;
    }

    if (choice.startsWith("公共配置")) {
      await syncUserSubagentConfigToProject(ctx, paths.userSettingsPath, paths.projectSettingsPath);
      continue;
    }
  }
}

// ═══════════════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════════════

export default async function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model) return undefined;
    const extraPayload = getModelPayload(model.provider, model.id);
    if (!extraPayload) return undefined;
    return mergePayloadIntoRequest(event.payload, extraPayload);
  });

  // ── /model-config 命令 ──
  pi.registerCommand("model-config", {
    description: "可视化配置自定义模型 Providers 和 Models → 保存到 models.json",
    handler: async (_args, ctx) => {
      let config: ModelsConfig;
      try {
        config = readModelsConfig();
      } catch (error) {
        notifyError(ctx, error);
        return;
      }

      while (true) {
        const pCount = Object.keys(config.providers).length;
        let mCount = 0;
        for (const provider of Object.values(config.providers)) mCount += (provider.models || []).length;

        const choice = await ctx.ui.select("模型配置编辑器", [
          `管理 Providers (当前 ${pCount} providers, ${mCount} models)`,
          "Subagent 配置",
          "诊断：检查 models.json 状态",
          "提示：保存后关闭并重开 /model (Ctrl+L) 即可看到",
          "退出",
        ]);
        if (choice === undefined || choice.startsWith("退出")) break;

        if (choice.startsWith("管理 Providers")) config = await manageProviders(ctx, config);
        else if (choice.startsWith("Subagent")) await manageSubagentModelSettings(pi, ctx);
        else if (choice.startsWith("诊断")) {
          const path = getModelsPath();
          const fs = await import("node:fs");
          const exists = fs.existsSync(path);
          const size = exists ? `${(fs.statSync(path).size / 1024).toFixed(1)} KB` : "N/A";
          try {
            const diskConfig = readModelsConfig();
            const providers = Object.values(diskConfig.providers);
            const models = providers.reduce((count, provider) => count + (provider.models || []).length, 0);
            ctx.ui.notify(
              `文件路径: ${path}\n存在: ${exists ? "是" : "否"} | 大小: ${size}\nProviders: ${providers.length} | Models: ${models}`,
              "info",
            );
          } catch (error) {
            ctx.ui.notify(`文件路径: ${path}\n无法读取 models.json: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        } else if (choice.includes("提示")) {
          ctx.ui.notify(
            "工作流程：\n" +
            "1. 添加 Provider → 自动保存到 models.json\n" +
            "2. 为 Provider 添加 Models → 自动保存\n" +
            "3. 关闭 /model 对话框 → 重新打开 (Ctrl+L)\n" +
            "4. Pi 自动重新加载 models.json → 新模型出现",
            "info",
          );
        }
      }
    },
  });

}
