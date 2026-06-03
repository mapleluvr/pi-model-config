// ── Pi 模型配置可视化编辑器 v2 ──
/**
 * 核心机制：
 * - Pi 的 /model 命令直接从 ~/.pi/agent/models.json 读取自定义模型
 * - 每次打开 /model 时自动重新加载该文件（无需 /reload）
 * - 本插件负责：可视化编辑 → 写入 models.json → 通知用户重开 /model
 * - 启动时也用 pi.registerProvider() 预加载，作为双保险
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getModelsPath, readModelsConfig, writeModelsConfig } from "./config";
import type { ModelsConfig, ProviderConfig, ModelConfig, ExtraPayloadParam } from "./types";

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

  ctx.ui.notify(`🔍 正在拉取模型列表...\n${baseUrl}`, "info");

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
        `✅ 成功拉取 ${result.length} 个模型\n` +
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

  ctx.ui.notify(`❌ 拉取失败: ${lastError}`, "error");
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
  const r = m.reasoning ? " 🧠" : "";
  const ctx = m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k` : "?";
  const max = m.maxTokens ? `${(m.maxTokens / 1000).toFixed(0)}k` : "?";
  return `${name}${r}  ctx=${ctx}  max=${max}`;
}

async function promptText(
  ctx: ExtensionCommandContext,
  title: string,
  message: string,
  defaultValue?: string,
): Promise<string | undefined> {
  const result = await ctx.ui.editor(
    `${title}\n\n${message}${defaultValue != null ? `\n\n当前值: ${defaultValue}` : ""}`,
    defaultValue ?? "",
  );
  return result?.trim() || undefined;
}

function stripUndefined<T extends Record<string, any>>(obj: T): T {
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }
  return result;
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
    `✅ 已保存 ${pCount} Providers / ${mCount} Models → ${getModelsPath()}\n` +
    `💡 请关闭并重新打开 /model (Ctrl+L) 查看新模型`,
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
  const isNew = !existing;
  const providerId = existing?._providerId
    || await promptText(ctx, "添加 Provider", "输入 Provider ID（唯一标识）：\n例如: ollama, my-llm, openrouter");

  if (!providerId?.trim()) {
    ctx.ui.notify("Provider ID 不能为空", "error");
    return null;
  }

  const base: ProviderConfig = existing ?? { models: [] };

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
    ctx, `Provider: ${providerId}`,
    "API Key:\n  字面值: sk-xxx\n  环境变量: $MY_VAR\n  命令: !op read ...\n留空 = 无认证",
    base.apiKey,
  );
  if (apiKey === undefined) return null;

  const authChoice = await ctx.ui.select(`Provider: ${providerId} - Auth Header`, [
    "否 - 不自动添加 Bearer",
    "是 - 添加 Authorization: Bearer 头",
  ]);
  if (authChoice === undefined) return null;

  const config: ProviderConfig = stripUndefined({
    name: name || undefined,
    baseUrl: baseUrl || undefined,
    api: apiChoice?.split(" - ")[0]?.trim() || "openai-completions",
    apiKey: apiKey || undefined,
    authHeader: authChoice?.includes("是") || undefined,
    models: base.models || [],
    compat: base.compat,
  });

  const doCompat = await ctx.ui.confirm(`Provider: ${providerId}`, "配置高级兼容性选项？");
  if (doCompat) {
    const compat = await editCompat(ctx, providerId, base.compat);
    if (compat) config.compat = compat;
  }

  // 如果还没有 models，询问是否自动拉取
  const finalConfig = stripUndefined(config);
  if ((!finalConfig.models || finalConfig.models.length === 0) && finalConfig.baseUrl) {
    const doFetch = await ctx.ui.confirm(
      `Provider: ${providerId}`,
      "当前没有配置任何 Model。要自动从 API 端点拉取模型列表吗？"
    );
    if (doFetch) {
      // 临时构造完整 provider 用于 fetch
      const tempProvider: ProviderConfig = { ...finalConfig };
      const fetched = await fetchModelsFromProvider(ctx, providerId, tempProvider);
      if (fetched && fetched.length > 0) {
        finalConfig.models = fetched;
      }
    }
  }

  return { providerId: providerId.trim(), config: finalConfig };
}

// ═══════════════════════════════════════════════════════
// Model Editor
// ═══════════════════════════════════════════════════════

async function editModel(
  ctx: ExtensionCommandContext,
  providerId: string,
  existing?: ModelConfig,
): Promise<ModelConfig | null> {
  const isNew = !existing;

  const modelId = isNew
    ? await promptText(ctx, `Model - ${providerId}`, "Model ID（如 gpt-4o, llama3.1:8b）")
    : existing!.id;

  if (!modelId?.trim()) {
    if (isNew) ctx.ui.notify("Model ID 不能为空", "error");
    return null;
  }

  const base: ModelConfig = existing ?? {
    id: modelId.trim(),
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  const name = await promptText(ctx, `Model: ${modelId}`, "显示名称（留空使用 ID）", base.name);
  if (name === undefined) return null;

  const reasoningChoice = await ctx.ui.select(`Model: ${modelId} - Extended Thinking`, [
    `否${base.reasoning ? "" : " ← 当前"}`,
    `是${base.reasoning ? " ← 当前" : ""}`,
  ]);
  if (reasoningChoice === undefined) return null;

  const inputChoice = await ctx.ui.select(`Model: ${modelId} - 输入类型`, [
    `仅文本${!base.input?.includes("image") ? " ← 当前" : ""}`,
    `文本 + 图片${base.input?.includes("image") ? " ← 当前" : ""}`,
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

  const model: ModelConfig = {
    id: base.id,
    name: name || undefined,
    reasoning: reasoningChoice?.includes("是") || false,
    input: inputChoice?.includes("图片") ? ["text", "image"] : ["text"],
    contextWindow: parseInt(ctxWin, 10) || 128000,
    maxTokens: parseInt(maxTok, 10) || 16384,
    cost: {
      input: parseFloat(costIn) || 0,
      output: parseFloat(costOut) || 0,
      cacheRead: base.cost?.cacheRead || 0,
      cacheWrite: base.cost?.cacheWrite || 0,
    },
  };

  if (model.reasoning) {
    const doMap = await ctx.ui.confirm(`Model: ${modelId}`, "配置 Thinking Level Map？");
    if (doMap) {
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
      const thinkingMap: Record<string, string | null> = {};
      for (const level of levels) {
        const current = base.thinkingLevelMap?.[level];
        const val = await promptText(
          ctx, `Model: ${modelId} - Thinking: ${level}`,
          'null = 禁用, "default" = 默认, 或自定义',
          current === null ? "null" : (current || ""),
        );
        if (val === undefined) break;
        if (val === "" || val === "default") continue;
        thinkingMap[level] = val === "null" ? null : val;
      }
      if (Object.keys(thinkingMap).length > 0) model.thinkingLevelMap = thinkingMap;
    }
  }

  const doCompat = await ctx.ui.confirm(`Model: ${modelId}`, "配置高级兼容性选项？");
  if (doCompat) {
    const compat = await editCompat(ctx, modelId, base.compat);
    if (compat) model.compat = compat;
  }

  // ── Pi 默认参数展示 + 自定义 Payload 参数 ──
  const doPayload = await ctx.ui.confirm(
    `Model: ${modelId}`,
    `【Pi Agent 默认参数】\n` +
    `  contextWindow = ${model.contextWindow || 128000} tokens\n` +
    `  maxTokens      = ${model.maxTokens || 16384} tokens\n` +
    `  reasoning      = ${model.reasoning ? "是" : "否"}\n` +
    `  input          = ${(model.input || ["text"]).join(", ")}\n` +
    `  cost           = input $${model.cost?.input || 0} / output $${model.cost?.output || 0} (per 1M tokens)\n` +
    (model.thinkingLevelMap
      ? `  thinkingMap    = ${JSON.stringify(model.thinkingLevelMap)}\n`
      : "") +
    `\n以上为 Pi 默认模型参数（可在前面步骤中修改）。\n` +
    `\n是否管理 自定义 Payload 参数？（附加到 API 请求体的额外键值对）`,
  );
  if (doPayload) {
    const extraParams = await editExtraPayload(ctx, modelId, base.extraPayload);
    if (extraParams) model.extraPayload = extraParams;
  }

  return stripUndefined(model);
}

// ═══════════════════════════════════════════════════════
// Extra Payload Editor — 自定义 API 请求体参数
// ═══════════════════════════════════════════════════════

/** 验证 JSON 字符串是否合法 */
function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/** 格式化 param 展示 */
function paramLabel(p: ExtraPayloadParam): string {
  const typeTag = { json: "{ }", string: "abc", bool: "T/F" }[p.type];
  const preview = p.value.length > 40 ? p.value.slice(0, 37) + "..." : p.value;
  return `[${typeTag}] ${p.key} = ${preview}`;
}

async function editExtraPayload(
  ctx: ExtensionCommandContext,
  modelId: string,
  existing?: ExtraPayloadParam[],
): Promise<ExtraPayloadParam[] | undefined> {
  const params: ExtraPayloadParam[] = existing ? [...existing] : [];

  while (true) {
    const items: string[] = params.map((p, i) => `${i + 1}. ${paramLabel(p)}`);
    items.push("➕ 添加参数");
    items.push("⬅️ 完成");

    const choice = await ctx.ui.select(`Payload 参数 - ${modelId} (${params.length} 个)`, items);
    if (choice === undefined || choice?.startsWith("⬅️")) break;

    if (choice?.startsWith("➕")) {
      // 输入 key
      const key = await promptText(ctx, `Payload - ${modelId}`, "参数键名（如 temperature, top_p）：");
      if (!key) continue;

      // 检查重复
      if (params.some((p) => p.key === key)) {
        ctx.ui.notify(`参数 "${key}" 已存在`, "warning");
        continue;
      }

      // 选择类型
      const typeChoice = await ctx.ui.select(`Payload - ${modelId} - ${key}`, [
        "string - 字符串",
        "bool   - 布尔值 (true/false)",
        "json   - JSON 对象或数组",
      ]);
      if (!typeChoice) continue;
      const type = typeChoice.includes("bool") ? "bool"
        : typeChoice.includes("json") ? "json"
        : "string";

      // 输入值
      let value: string | undefined;
      if (type === "bool") {
        const boolChoice = await ctx.ui.select(`Payload - ${modelId} - ${key}`, [
          "true",
          "false",
        ]);
        if (boolChoice === undefined) continue;
        value = boolChoice;
      } else if (type === "json") {
        // JSON 类型：循环验证直到合法
        while (true) {
          const raw = await promptText(
            ctx, `Payload - ${modelId} - ${key} (JSON)`,
            "输入合法 JSON 值（对象或数组）：\n例如: {\"key\": \"value\"} 或 [1, 2, 3]",
            params.find((p) => p.key === key)?.value,
          );
          if (raw === undefined) break; // 用户取消
          if (!raw.trim()) break;
          if (isValidJson(raw.trim())) {
            // 美化 JSON
            try {
              value = JSON.stringify(JSON.parse(raw.trim()));
            } catch {
              value = raw.trim();
            }
            break;
          }
          const retry = await ctx.ui.confirm(
            "JSON 格式不合法",
            `输入内容不是合法 JSON。\n输入: ${raw.slice(0, 100)}${raw.length > 100 ? "..." : ""}\n\n重试？`,
          );
          if (!retry) break;
        }
        if (value === undefined) continue;
        if (!value) continue;
      } else {
        // string 类型
        value = await promptText(
          ctx, `Payload - ${modelId} - ${key} (string)`,
          "输入字符串值：",
          params.find((p) => p.key === key)?.value,
        );
        if (value === undefined) continue;
      }

      params.push({ key: key.trim(), type, value: value.trim() });
      ctx.ui.notify(`参数 "${key}" 已添加`, "success");
      continue;
    }

    // 编辑或删除已有参数
    const idxMatch = choice?.match(/^(\d+)\./);
    if (idxMatch) {
      const idx = parseInt(idxMatch[1]!, 10) - 1;
      if (idx >= 0 && idx < params.length) {
        const param = params[idx]!;
        const action = await ctx.ui.select(
          `Payload: ${paramLabel(param)}`,
          ["✏️ 修改", "🗑️ 删除", "⬅️ 返回"],
        );
        if (!action || action.startsWith("⬅️")) continue;

        if (action.startsWith("🗑️")) {
          params.splice(idx, 1);
          ctx.ui.notify(`参数 "${param.key}" 已删除`, "info");
          continue;
        }

        if (action.startsWith("✏️")) {
          // 修改值（保持类型不变，但允许在 JSON 类型时重新验证）
          if (param.type === "bool") {
            const boolChoice = await ctx.ui.select(
              `Payload - ${modelId} - ${param.key}`,
              ["true", "false"],
            );
            if (boolChoice !== undefined) {
              param.value = boolChoice;
              ctx.ui.notify(`参数 "${param.key}" 已更新`, "success");
            }
          } else if (param.type === "json") {
            while (true) {
              const raw = await promptText(
                ctx, `Payload - ${modelId} - ${param.key} (JSON)`,
                "输入合法 JSON 值：",
                param.value,
              );
              if (raw === undefined) break;
              if (!raw.trim()) break;
              if (isValidJson(raw.trim())) {
                try {
                  param.value = JSON.stringify(JSON.parse(raw.trim()));
                } catch {
                  param.value = raw.trim();
                }
                ctx.ui.notify(`参数 "${param.key}" 已更新`, "success");
                break;
              }
              const retry = await ctx.ui.confirm("JSON 不合法", "重试？");
              if (!retry) break;
            }
          } else {
            const newVal = await promptText(
              ctx, `Payload - ${modelId} - ${param.key} (string)`,
              "输入新值：",
              param.value,
            );
            if (newVal !== undefined) {
              param.value = newVal.trim();
              ctx.ui.notify(`参数 "${param.key}" 已更新`, "success");
            }
          }
        }
      }
    }
  }

  return params.length > 0 ? params : undefined;
}

// ═══════════════════════════════════════════════════════
// Compat Editor
// ═══════════════════════════════════════════════════════

async function editCompat(
  ctx: ExtensionCommandContext,
  parentId: string,
  existing?: Record<string, any>,
): Promise<Record<string, any> | undefined> {
  const c: Record<string, any> = existing ? { ...existing } : {};

  const boolFields = [
    { key: "supportsDeveloperRole", label: "supportsDeveloperRole" },
    { key: "supportsReasoningEffort", label: "supportsReasoningEffort" },
    { key: "supportsUsageInStreaming", label: "supportsUsageInStreaming" },
    { key: "requiresToolResultName", label: "requiresToolResultName" },
    { key: "requiresThinkingAsText", label: "requiresThinkingAsText" },
    { key: "supportsStrictMode", label: "supportsStrictMode" },
    { key: "supportsLongCacheRetention", label: "supportsLongCacheRetention" },
    { key: "supportsEagerToolInputStreaming", label: "supportsEagerToolInputStreaming (Anthropic)" },
    { key: "forceAdaptiveThinking", label: "forceAdaptiveThinking" },
    { key: "allowEmptySignature", label: "allowEmptySignature" },
  ];

  while (true) {
    const items = boolFields.map((f) => {
      const val = c[f.key];
      return `${val === true ? "[✓]" : val === false ? "[✗]" : "[·]"} ${f.label}`;
    });
    if (c.maxTokensField) items.push(`maxTokensField = ${c.maxTokensField}`);
    if (c.thinkingFormat) items.push(`thinkingFormat = ${c.thinkingFormat}`);
    if (c.cacheControlFormat) items.push(`cacheControlFormat = ${c.cacheControlFormat}`);
    items.push("✅ 完成");

    const choice = await ctx.ui.select(`Compat - ${parentId}`, items);
    if (choice === undefined || choice === "✅ 完成") break;

    for (const f of boolFields) {
      if (choice.includes(f.label)) {
        c[f.key] = !c[f.key];
        if (c[f.key] === false) delete c[f.key];
        break;
      }
    }
    if (choice.includes("maxTokensField")) {
      const val = await ctx.ui.select(`Compat - ${parentId}`, ["max_completion_tokens", "max_tokens"]);
      if (val !== undefined) c.maxTokensField = val;
    }
    if (choice.includes("thinkingFormat")) {
      const val = await ctx.ui.select(`Compat - ${parentId}`, [
        "openai", "openrouter", "deepseek", "together", "qwen", "qwen-chat-template", "(清除)",
      ]);
      if (val !== undefined) {
        c.thinkingFormat = val === "(清除)" ? undefined : val;
        if (!c.thinkingFormat) delete c.thinkingFormat;
      }
    }
    if (choice.includes("cacheControlFormat")) {
      const val = await ctx.ui.select(`Compat - ${parentId}`, ["anthropic", "(清除)"]);
      if (val !== undefined) {
        c.cacheControlFormat = val === "(清除)" ? undefined : val;
        if (!c.cacheControlFormat) delete c.cacheControlFormat;
      }
    }
  }

  return Object.keys(c).length > 0 ? c : undefined;
}

// ═══════════════════════════════════════════════════════
// Provider Management
// ═══════════════════════════════════════════════════════

async function manageProviders(
  ctx: ExtensionCommandContext,
  config: ModelsConfig,
): Promise<void> {
  while (true) {
    const pids = Object.keys(config.providers);
    const items: string[] = pids.map((pid) => {
      const p = config.providers[pid]!;
      return `✏️  [${pid}] ${providerSummary(p)}`;
    });
    items.push("➕ 添加新 Provider");
    items.push("⬅️ 返回主菜单");

    const choice = await ctx.ui.select("📁 Provider 管理", items);
    if (choice === undefined || choice?.startsWith("⬅️")) return;

    if (choice?.startsWith("➕")) {
      const result = await editProvider(ctx);
      if (result) {
        config.providers[result.providerId] = result.config;
        persistConfig(config, ctx);
      }
      continue;
    }

    const match = choice?.match(/^✏️\s+\[(.+?)\]/);
    if (match) {
      const pid = match[1]!;
      const existing = config.providers[pid];
      if (!existing) continue;

      const action = await ctx.ui.select(`Provider: ${pid}`, [
        "✏️ 编辑设置",
        "📦 管理 Models",
        "🔍 自动拉取 Model 列表（从 API 发现）",
        "📋 复制 Provider",
        "🗑️ 删除 Provider",
        "⬅️ 返回",
      ]);
      if (!action || action.startsWith("⬅️")) continue;

      if (action.startsWith("🗑️")) {
        const ok = await ctx.ui.confirm("确认删除", `删除 Provider "${pid}" 及其所有 Models？`);
        if (ok) {
          delete config.providers[pid];
          persistConfig(config, ctx);
        }
        continue;
      }
      if (action.startsWith("📋")) {
        const newId = await promptText(ctx, "复制 Provider", "输入新 ID", `${pid}-copy`);
        if (newId) {
          config.providers[newId] = JSON.parse(JSON.stringify(existing));
          persistConfig(config, ctx);
        }
        continue;
      }
      if (action.startsWith("📦")) {
        const updated = await manageModels(ctx, pid, existing, config);
        config.providers[pid] = updated;
        continue;
      }
      if (action.startsWith("🔍")) {
        // 自动拉取模型列表
        const fetched = await fetchModelsFromProvider(ctx, pid, existing);
        if (fetched && fetched.length > 0) {
          const merge = await ctx.ui.confirm(
            `发现 ${fetched.length} 个模型`,
            `拉取到的模型:\n${fetched.map((m) => `  - ${m.id}`).join("\n")}\n\n` +
            `当前已有 ${(existing.models || []).length} 个模型。\n` +
            `是 = 替换现有模型\n否 = 合并到现有列表（去重）`
          );
          if (merge) {
            existing.models = fetched;
          } else {
            // 合并去重
            const existingIds = new Set((existing.models || []).map((m) => m.id));
            const newModels = fetched.filter((m) => !existingIds.has(m.id));
            existing.models = [...(existing.models || []), ...newModels];
          }
          persistConfig(config, ctx);
        }
        continue;
      }
      if (action.startsWith("✏️")) {
        const editInput = { ...existing, _providerId: pid } as any;
        const result = await editProvider(ctx, editInput);
        if (result) {
          if (result.providerId !== pid) delete config.providers[pid];
          config.providers[result.providerId] = result.config;
          persistConfig(config, ctx);
        }
        continue;
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
  provider: ProviderConfig,
  config: ModelsConfig,
): Promise<ProviderConfig> {
  const models = provider.models || [];
  provider.models = models;

  while (true) {
    const items: string[] = models.map((m, i) => `${i + 1}. 📋 ${modelSummary(m)}`);
    items.push("➕ 添加新 Model");
    items.push("⬅️ 返回");

    const choice = await ctx.ui.select(`Models - ${providerId}`, items);
    if (choice === undefined || choice?.startsWith("⬅️")) return provider;

    if (choice?.startsWith("➕")) {
      const newModel = await editModel(ctx, providerId);
      if (newModel) {
        models.push(newModel);
        persistConfig(config, ctx);
      }
      continue;
    }

    const idxMatch = choice?.match(/^(\d+)\./);
    if (idxMatch) {
      const idx = parseInt(idxMatch[1]!, 10) - 1;
      if (idx >= 0 && idx < models.length) {
        const existing = models[idx]!;
        const action = await ctx.ui.select(`Model: ${modelSummary(existing)}`, [
          "✏️ 编辑", "📋 复制", "🗑️ 删除", "⬅️ 返回",
        ]);
        if (!action || action.startsWith("⬅️")) continue;

        if (action.startsWith("🗑️")) {
          const ok = await ctx.ui.confirm("确认删除", `删除 Model "${existing.id}"？`);
          if (ok) { models.splice(idx, 1); persistConfig(config, ctx); }
          continue;
        }
        if (action.startsWith("📋")) {
          models.push({ ...existing, id: existing.id + "-copy", name: (existing.name || existing.id) + " (Copy)" });
          persistConfig(config, ctx);
          continue;
        }
        if (action.startsWith("✏️")) {
          const updated = await editModel(ctx, providerId, existing);
          if (updated) {
            if (updated.id !== existing.id) models.splice(idx, 1);
            models[idx] = updated;
            persistConfig(config, ctx);
          }
          continue;
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════════════

export default async function (pi: ExtensionAPI) {
  // ── 启动：从 models.json 加载并注册 ──
  const initialConfig = readModelsConfig();
  let loadedCount = 0;

  for (const [pid, p] of Object.entries(initialConfig.providers)) {
    try {
      pi.registerProvider(pid, {
        name: p.name,
        baseUrl: p.baseUrl,
        api: (p.api as any) || "openai-completions",
        apiKey: p.apiKey,
        headers: p.headers,
        authHeader: p.authHeader,
        models: (p.models || []).map((m) => ({
          id: m.id,
          name: m.name || m.id,
          reasoning: m.reasoning || false,
          input: m.input || ["text"],
          contextWindow: m.contextWindow || 128000,
          maxTokens: m.maxTokens || 16384,
          cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
          ...(m.compat ? { compat: m.compat } : {}),
          ...(m.api ? { api: m.api as any } : {}),
          ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
          ...(m.headers ? { headers: m.headers } : {}),
        })),
        ...(p.compat ? { compat: p.compat } : {}),
        ...(p.modelOverrides ? { modelOverrides: p.modelOverrides } : {}),
      });
      loadedCount++;
    } catch (err) {
      console.error(`[model-config] Startup register "${pid}" failed:`, err);
    }
  }

  // ── /model-config 命令 ──
  pi.registerCommand("model-config", {
    description: "可视化配置自定义模型 Providers 和 Models → 保存到 models.json",
    handler: async (_args, ctx) => {
      const config = readModelsConfig();

      while (true) {
        const pCount = Object.keys(config.providers).length;
        let mCount = 0;
        for (const p of Object.values(config.providers)) mCount += (p.models || []).length;

        const choice = await ctx.ui.select("🧩 模型配置编辑器", [
          `📁 管理 Providers (当前 ${pCount} providers, ${mCount} models)`,
          `🔍 诊断：检查 models.json 状态`,
          `💡 提示：保存后关闭并重开 /model (Ctrl+L) 即可看到`,
          "❌ 退出",
        ]);

        if (choice === undefined || choice?.startsWith("❌")) break;

        if (choice?.startsWith("📁")) {
          await manageProviders(ctx, config);
        }

        if (choice?.startsWith("🔍")) {
          // 诊断命令：检查 models.json 是否存在且格式正确
          const path = getModelsPath();
          const fs = await import("node:fs");
          const exists = fs.existsSync(path);
          const size = exists ? `${(fs.statSync(path).size / 1024).toFixed(1)} KB` : "N/A";

          ctx.ui.notify(
            `📁 文件路径: ${path}\n` +
            `📏 存在: ${exists ? "是" : "否"} | 大小: ${size}\n` +
            `📊 Providers: ${pCount} | Models: ${mCount}`,
            "info",
          );
        }

        if (choice?.includes("提示")) {
          ctx.ui.notify(
            "💡 工作流程：\n" +
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

  // ── 启动通知 ──
  if (loadedCount > 0) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        `📦 已加载 ${loadedCount} 个自定义 Provider（/model-config 管理 · Ctrl+L 切换）`,
        "info",
      );
    });
  }
}
