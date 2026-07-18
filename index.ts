// ── Pi 模型配置可视化编辑器 v2 ──
/**
 * 核心机制：
 * - Pi 的 /model 命令直接从 ~/.pi/agent/models.json 读取自定义模型
 * - 每次打开 /model 时自动重新加载该文件（无需 /reload）
 * - 本插件负责：可视化编辑 → 写入 models.json → 通知用户重开 /model
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ModelConfigActions } from "./config-actions.ts";
import { readModelsConfig } from "./config.ts";
import { mergePayloadIntoRequest } from "./payload-config.ts";
import {
  applyRecovery,
  inspectRecovery,
  resolveRequestPayload,
  type ApplyRecoveryResult,
  type RecoveryChoice,
  type RecoveryResult,
} from "./payload-coordinator.ts";
import type { ModelsConfig } from "./types.ts";
import { searchableSelect, type SearchableSelectOption } from "./searchable-select.ts";
import { searchableMultiSelect } from "./searchable-multi-select.ts";
import { runProviderList } from "./provider-editor.ts";
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

const ACTION_BACK = "__pi_model_config_action:back";
const ACTION_MANUAL_MODEL = "__pi_model_config_action:manual_model";
const ACTION_CLEAR_MODEL = "__pi_model_config_action:clear_model";
const ACTION_CURRENT_MODEL = "__pi_model_config_action:current_model";

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

interface RecoveryApi {
  inspect(): Promise<RecoveryResult>;
  apply(snapshotToken: string, choice: RecoveryChoice): Promise<ApplyRecoveryResult>;
}

const DEFAULT_RECOVERY_API: RecoveryApi = {
  inspect: () => inspectRecovery(),
  apply: (snapshotToken, choice) => applyRecovery(snapshotToken, choice),
};

const RECOVERY_CHOICE_LABELS: Record<RecoveryChoice, string> = {
  "restore-before-payload": "恢复事务前状态",
  "restore-after-payload": "恢复事务后状态",
  "accept-current": "接受当前文件并隔离损坏日志",
  "quarantine-and-empty": "隔离损坏数据并初始化空私有配置",
};

async function retryOrCancel(ctx: ExtensionCommandContext): Promise<boolean> {
  return await ctx.ui.select("配置恢复", ["重试", "取消"]) === "重试";
}

function notifyRecoveryDiagnostic(
  ctx: ExtensionCommandContext,
  type: "busy" | "collision" | "unsupported" | "blocked",
): void {
  const messages = {
    busy: "配置操作正在进行，未执行任何更改",
    collision: "配置协调端点发生冲突，未执行任何更改",
    unsupported: "当前环境不支持配置协调，未执行任何更改",
    blocked: "配置恢复暂时无法继续，未执行任何更改",
  } as const;
  ctx.ui.notify(messages[type], "error");
}

export async function runRecoveryDiagnostics(
  ctx: ExtensionCommandContext,
  recovery: RecoveryApi = DEFAULT_RECOVERY_API,
): Promise<"ready" | "cancelled"> {
  while (true) {
    let inspected: RecoveryResult;
    try {
      inspected = await recovery.inspect();
    } catch {
      notifyRecoveryDiagnostic(ctx, "blocked");
      if (await retryOrCancel(ctx)) continue;
      return "cancelled";
    }

    if (inspected.type === "clean") {
      ctx.ui.notify("配置文件和事务状态正常", "info");
      return "ready";
    }
    if (inspected.type === "automatic-recovered") {
      ctx.ui.notify("配置事务自动恢复完成", "success");
      return "ready";
    }
    if (inspected.type === "busy" || inspected.type === "collision" || inspected.type === "unsupported" || inspected.type === "blocked") {
      notifyRecoveryDiagnostic(ctx, inspected.type);
      if (await retryOrCancel(ctx)) continue;
      return "cancelled";
    }

    const choiceByLabel = new Map(inspected.choices.map((choice) => [RECOVERY_CHOICE_LABELS[choice], choice] as const));
    const selected = await ctx.ui.select("配置恢复预览", [
      ...choiceByLabel.keys(),
      "重试",
      "取消",
    ]);
    if (!selected || selected === "取消") return "cancelled";
    if (selected === "重试") continue;
    const choice = choiceByLabel.get(selected);
    if (!choice) return "cancelled";

    let applied: ApplyRecoveryResult;
    try {
      applied = await recovery.apply(inspected.snapshotToken, choice);
    } catch {
      notifyRecoveryDiagnostic(ctx, "blocked");
      if (await retryOrCancel(ctx)) continue;
      return "cancelled";
    }
    if (applied.type === "recovered") {
      ctx.ui.notify("配置恢复完成", "success");
      return "ready";
    }
    if (applied.type === "refresh") {
      ctx.ui.notify("配置状态已变化，已刷新恢复预览", "warning");
      continue;
    }
    notifyRecoveryDiagnostic(ctx, applied.type);
    if (await retryOrCancel(ctx)) continue;
    return "cancelled";
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
    const extraPayload = resolveRequestPayload(model.provider, model.id, {
      onDiagnostic: () => console.warn("Model Config request payload unavailable"),
    });
    if (!extraPayload) return undefined;
    return mergePayloadIntoRequest(event.payload, extraPayload);
  });

  // ── /model-config 命令 ──
  pi.registerCommand("model-config", {
    description: "可视化配置自定义模型 Providers 和 Models → 保存到 models.json",
    handler: async (_args, ctx) => {
      if ((ctx as ExtensionCommandContext & { mode?: string }).mode !== "tui") {
        ctx.ui.notify("模型配置编辑器仅支持交互式 TUI；未读取或修改配置", "error");
        return;
      }

      let config: ModelsConfig;
      try {
        config = readModelsConfig();
      } catch {
        ctx.ui.notify("无法读取模型配置；未执行任何更改", "error");
        return;
      }

      while (true) {
        const pCount = Object.keys(config.providers).length;
        let mCount = 0;
        for (const provider of Object.values(config.providers)) mCount += (provider.models || []).length;

        const choice = await ctx.ui.select("模型配置编辑器", [
          `管理 Providers (当前 ${pCount} providers, ${mCount} models)`,
          "Subagent 配置",
          "诊断与事务恢复",
          "提示：保存后关闭并重开 /model (Ctrl+L) 即可看到",
          "退出",
        ]);
        if (choice === undefined || choice.startsWith("退出")) break;

        if (choice.startsWith("管理 Providers")) {
          const actions = new ModelConfigActions();
          await runProviderList(ctx, { actions });
          const refreshed = actions.readEditorSnapshot();
          if (refreshed.type === "snapshot") config = structuredClone(refreshed.native);
        } else if (choice.startsWith("Subagent")) {
          await manageSubagentModelSettings(pi, ctx);
        } else if (choice.startsWith("诊断")) {
          if (await runRecoveryDiagnostics(ctx) === "ready") {
            try {
              config = readModelsConfig();
              const providers = Object.values(config.providers);
              const models = providers.reduce((count, provider) => count + (provider.models || []).length, 0);
              ctx.ui.notify(`Providers: ${providers.length} | Models: ${models}`, "info");
            } catch {
              ctx.ui.notify("恢复后仍无法读取模型配置；未执行额外更改", "error");
            }
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
