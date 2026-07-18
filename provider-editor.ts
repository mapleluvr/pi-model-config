import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  ModelConfigActions,
  parseLegacyExtraPayload,
  type ActionResult,
  type EndpointPreviewDescriptor,
  type FieldPatchOptions,
  type LegacyDiscardResolution,
  type PayloadCollisionResolution,
  type ProviderIdentityRequest,
} from "./config-actions.ts";
import {
  collectApiKeyAction,
  collectOptionalString,
  collectRequiredString,
  editCompatDraft,
  editStringMapDraft,
  formatApiKeyReference,
  formatNestedCount,
} from "./field-editors.ts";
import { deepCloneJson } from "./model-fields.ts";
import { getOwnValue, hasOwnKey, setOwnValue, deleteOwnKey } from "./own-keys.ts";
import { fetchEndpointModels, type EndpointDiscoveryFailure, type EndpointDiscoverySuccess } from "./endpoint-models.ts";
import { runModelList, editModelOverrideEntryDraft } from "./model-editor.ts";
import { searchableSelect, type SearchableSelectOption } from "./searchable-select.ts";
import {
  openSettingsPanel,
  type SettingsCategoryDescriptor,
  type SettingsPanelState,
} from "./settings-panel.ts";
import type { ModelOverrideConfig, ModelsConfig, ProviderConfig } from "./types.ts";

const API_OPTIONS = [
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations",
];
const ACTION_BACK = "__pi_model_config_action:back";
const ACTION_ADD_PROVIDER = "__pi_model_config_action:add_provider";

export interface ProviderEditorDependencies {
  actions?: ModelConfigActions;
  openPanel?: typeof openSettingsPanel;
  search?: typeof searchableSelect;
  runModels?: typeof runModelList;
  editOverride?: typeof editModelOverrideEntryDraft;
  fetchModels?: (provider: ProviderConfig) => Promise<EndpointDiscoverySuccess | null>;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return getOwnValue(record, key);
}

export function buildProviderCategories(providerId: string, provider: ProviderConfig): SettingsCategoryDescriptor[] {
  return [
    {
      id: "general",
      label: "常规",
      fields: [
        { id: "id", label: "Provider ID", displayValue: providerId, action: "edit-field" },
        { id: "name", label: "显示名称", displayValue: typeof ownValue(provider, "name") === "string" ? String(ownValue(provider, "name")) : "(未设置)", action: "edit-field" },
        { id: "baseUrl", label: "API Base URL", displayValue: typeof ownValue(provider, "baseUrl") === "string" ? String(ownValue(provider, "baseUrl")) : "(未设置)", action: "edit-field" },
        { id: "api", label: "API 类型", displayValue: typeof ownValue(provider, "api") === "string" ? String(ownValue(provider, "api")) : "(未设置)", action: "edit-field" },
      ],
    },
    {
      id: "http-auth",
      label: "HTTP 与认证",
      fields: [
        { id: "apiKey", label: "API Key", displayValue: formatApiKeyReference(typeof ownValue(provider, "apiKey") === "string" ? String(ownValue(provider, "apiKey")) : undefined), action: "edit-field" },
        { id: "authHeader", label: "Auth Header", displayValue: ownValue(provider, "authHeader") === undefined ? "(默认)" : String(ownValue(provider, "authHeader")), action: "edit-field" },
        { id: "headers", label: "Headers", displayValue: formatNestedCount(ownValue(provider, "headers"), "项"), action: "open-section" },
      ],
    },
    {
      id: "models",
      label: "Models",
      fields: [
        { id: "manageModels", label: "管理 Models", displayValue: `${Array.isArray(ownValue(provider, "models")) ? (ownValue(provider, "models") as unknown[]).length : 0} 个`, action: "run-action" },
        { id: "fetchModels", label: "从端点拉取 Models", displayValue: "手动运行", action: "run-action" },
        { id: "modelOverrides", label: "Model Overrides", displayValue: formatNestedCount(ownValue(provider, "modelOverrides"), "个覆盖"), action: "open-section" },
      ],
    },
    {
      id: "compatibility",
      label: "兼容性",
      fields: [
        { id: "compat", label: "Compat", displayValue: formatNestedCount(ownValue(provider, "compat"), "项"), action: "open-section" },
      ],
    },
    {
      id: "actions",
      label: "操作",
      fields: [
        { id: "copy", label: "复制 Provider", displayValue: "", action: "run-action" },
        { id: "delete", label: "删除 Provider", displayValue: "", action: "run-action" },
      ],
    },
  ];
}

function fieldOptions(categories: SettingsCategoryDescriptor[]): SearchableSelectOption[] {
  return categories.flatMap((category) => category.fields.map((field) => ({
    value: `${category.id}:${field.id}`,
    label: `${category.label} / ${field.label}`,
    description: field.displayValue,
    searchText: [category.id, category.label, field.id, field.label, field.searchText].filter(Boolean).join(" "),
  })));
}

function selectState(state: SettingsPanelState, selected: string): SettingsPanelState {
  const index = selected.indexOf(":");
  return { ...state, categoryId: selected.slice(0, index), fieldId: selected.slice(index + 1), focusedPane: "fields", narrowScreen: "fields" };
}

function providerFrom(config: ModelsConfig, providerId: string): ProviderConfig | undefined {
  return getOwnValue(config.providers, providerId);
}

function notifyActionFailure(ctx: ExtensionCommandContext, result: ActionResult): void {
  const messages: Partial<Record<ActionResult["type"], string>> = {
    "lock-busy": "配置操作进行中，请稍后重试",
    "lock-collision": "配置锁发生冲突",
    "lock-unsupported": "当前环境不支持配置锁",
    "recovery-required": "配置事务需要恢复后才能继续修改",
    "stale-target": "目标已被外部修改，已刷新",
    "subtree-conflict": "该字段已被外部修改；草稿已保留",
    "native-collision": "目标 ID 已存在",
    "payload-collision": "目标存在私有 Payload 冲突",
    "validation-error": "配置验证失败；草稿已保留",
  };
  const message = messages[result.type];
  if (message) ctx.ui.notify(message, "error");
}

function didSave(ctx: ExtensionCommandContext, result: ActionResult): boolean {
  if (result.type === "success") {
    ctx.ui.notify("配置已保存", "success");
    return true;
  }
  notifyActionFailure(ctx, result);
  return false;
}

async function targetInput(ctx: ExtensionCommandContext, title: string, initial: string): Promise<string | undefined> {
  const raw = await ctx.ui.editor(title, initial);
  const value = raw?.trim();
  return value || undefined;
}

async function choosePayloadResolution(ctx: ExtensionCommandContext): Promise<PayloadCollisionResolution | undefined> {
  const choice = await ctx.ui.select("私有 Payload 冲突", ["复用目标 Payload", "替换目标 Payload", "取消"]);
  if (!choice || choice === "取消") return undefined;
  return choice.startsWith("复用") ? "reuse-target" : "replace-target";
}

function hasMalformedLegacy(provider: ProviderConfig): boolean {
  return (provider.models ?? []).some((model) => hasOwnKey(model, "extraPayload") && !parseLegacyExtraPayload(getOwnValue(model, "extraPayload")).ok);
}

async function commitProviderIdentity(
  ctx: ExtensionCommandContext,
  actions: ModelConfigActions,
  initialRequest: ProviderIdentityRequest,
): Promise<boolean> {
  let request = initialRequest;
  while (true) {
    const preview = await actions.previewProviderIdentityAction(request);
    if (preview.type === "payload-collision") {
      const resolution = await choosePayloadResolution(ctx);
      if (!resolution) return false;
      request = { ...request, payloadCollisionResolution: resolution } as ProviderIdentityRequest;
      continue;
    }
    if (preview.type !== "preview") {
      notifyActionFailure(ctx, preview);
      return false;
    }
    let token = preview.token;
    let descriptor = preview.descriptor;
    while (true) {
      const confirmed = await ctx.ui.confirm(
        "确认 Provider 操作",
        `${descriptor.kind}: ${descriptor.sourceProviderId}${descriptor.targetProviderId ? ` -> ${descriptor.targetProviderId}` : ""}\n受影响身份: ${descriptor.affectedIdentities.length}\nPayload 冲突: ${descriptor.collisions.length}`,
      );
      if (!confirmed) {
        actions.discardIdentityPreview(token);
        return false;
      }
      const result = await actions.commitProviderIdentityAction(token);
      if (result.type === "stale-target" && result.preview) {
        ctx.ui.notify("配置已变化，请确认刷新后的预览", "warning");
        token = result.preview.token;
        descriptor = result.preview;
        continue;
      }
      return didSave(ctx, result);
    }
  }
}

function endpointMessage(descriptor: EndpointPreviewDescriptor): string {
  return `来源: ${descriptor.source}\n有效 ${descriptor.validCount}，跳过 ${descriptor.skippedCount}，重复 ${descriptor.duplicateCount}\n新增 ${descriptor.introduced.ids.length}，移除 ${descriptor.removed.ids.length}，Payload 冲突 ${descriptor.collisions.length}`;
}

function notifyEndpointFailure(ctx: ExtensionCommandContext, failure: EndpointDiscoveryFailure): void {
  const labels: Record<EndpointDiscoveryFailure["reason"], string> = {
    "missing-base-url": "请先设置 Base URL",
    "missing-api-key": "请先设置 API Key",
    "request-failed": "端点请求失败",
    timeout: "端点请求超时",
    "http-error": "端点返回 HTTP 错误",
    "parse-error": "端点返回内容无法解析",
    "unsupported-shape": "端点返回格式不支持",
    empty: "端点返回空列表",
    "all-invalid": "端点没有有效 Model",
  };
  ctx.ui.notify(`拉取失败: ${labels[failure.reason]}`, "error");
}

async function fetchAndCommit(
  ctx: ExtensionCommandContext,
  actions: ModelConfigActions,
  providerId: string,
  provider: ProviderConfig,
  fetchModels: (provider: ProviderConfig) => Promise<EndpointDiscoverySuccess | null>,
): Promise<void> {
  const discovery = await fetchModels(provider);
  if (!discovery) return;
  const modeChoice = await ctx.ui.select("端点 Model 列表", ["合并并保留现有 Models", "替换为端点 Models", "取消"]);
  if (!modeChoice || modeChoice === "取消") return;
  let mode: "merge" | "replace" = modeChoice.startsWith("替换") ? "replace" : "merge";
  let preview = await actions.previewEndpointChange({ providerId, mode, discovery });
  while (preview.type === "endpoint-preview") {
    const confirmed = await ctx.ui.confirm("确认端点 Model 变更", endpointMessage(preview.descriptor));
    if (!confirmed) {
      actions.discardIdentityPreview(preview.token);
      return;
    }
    let payloadCollisionResolution: PayloadCollisionResolution | undefined;
    let legacyDiscardResolution: LegacyDiscardResolution | undefined;
    if (preview.descriptor.collisions.length > 0) {
      payloadCollisionResolution = await choosePayloadResolution(ctx);
      if (!payloadCollisionResolution) {
        actions.discardIdentityPreview(preview.token);
        return;
      }
    }
    if (preview.descriptor.malformedIdentities.length > 0) {
      const discard = await ctx.ui.confirm("Malformed legacy extraPayload", "替换端点列表会移除 malformed legacy rows。继续？");
      if (!discard) {
        actions.discardIdentityPreview(preview.token);
        return;
      }
      legacyDiscardResolution = "discard-malformed-legacy";
    }
    const result = await actions.commitEndpointChange(preview.token, { payloadCollisionResolution, legacyDiscardResolution });
    if (result.type === "stale-target" && result.endpointPreview) {
      ctx.ui.notify("配置已变化，请确认刷新后的端点预览", "warning");
      preview = result.endpointPreview;
      continue;
    }
    didSave(ctx, result);
    return;
  }
  notifyActionFailure(ctx, preview);
}

async function editOverridesDraft(
  ctx: ExtensionCommandContext,
  providerId: string,
  existing: Record<string, ModelOverrideConfig> | undefined,
  editOverride: typeof editModelOverrideEntryDraft,
): Promise<{ status: "save"; value: Record<string, ModelOverrideConfig> } | { status: "discard" }> {
  const draft = deepCloneJson(existing ?? {}) as Record<string, ModelOverrideConfig>;
  while (true) {
    const keys = Object.keys(draft);
    const choice = await ctx.ui.select(`Model Overrides - ${providerId}`, [
      ...keys.map((key) => `编辑 ${key}`),
      "新增 Override",
      "保存并返回",
      "放弃更改",
    ]);
    if (!choice || choice === "放弃更改") return { status: "discard" };
    if (choice === "保存并返回") return { status: "save", value: draft };
    if (choice === "新增 Override") {
      const key = await collectRequiredString(ctx, "新增 Override - Model ID", "目标 Model ID");
      if (key.status === "cancel") return { status: "discard" };
      if (hasOwnKey(draft, key.value)) {
        ctx.ui.notify("该 Override ID 已存在", "error");
        continue;
      }
      const edited = await editOverride(ctx, key.value, {}, {});
      if (edited.status === "save") setOwnValue(draft, key.value, edited.value);
      continue;
    }
    const key = keys.find((candidate) => choice === `编辑 ${candidate}`);
    if (!key) continue;
    const action = await ctx.ui.select(`Override ${key}`, ["编辑字段", "重命名", "删除", "返回"]);
    if (!action || action === "返回") continue;
    if (action === "编辑字段") {
      const edited = await editOverride(ctx, key, draft[key]!, {});
      if (edited.status === "save") setOwnValue(draft, key, edited.value);
      continue;
    }
    if (action === "删除") {
      if (await ctx.ui.confirm("删除 Override", `确认删除 ${key}？`)) deleteOwnKey(draft, key);
      continue;
    }
    const target = await targetInput(ctx, "重命名 Override", `${key}-copy`);
    if (!target) continue;
    if (hasOwnKey(draft, target)) {
      ctx.ui.notify("该 Override ID 已存在", "error");
      continue;
    }
    setOwnValue(draft, target, draft[key]!);
    deleteOwnKey(draft, key);
  }
}

export async function runProviderEditor(
  ctx: ExtensionCommandContext,
  initialProviderId: string,
  dependencies: ProviderEditorDependencies = {},
): Promise<void> {
  const actions = dependencies.actions ?? new ModelConfigActions();
  const openPanel = dependencies.openPanel ?? openSettingsPanel;
  const search = dependencies.search ?? searchableSelect;
  const runModels = dependencies.runModels ?? runModelList;
  const editOverride = dependencies.editOverride ?? editModelOverrideEntryDraft;
  const fetchModels = dependencies.fetchModels ?? (async (provider: ProviderConfig) => {
    const result = await fetchEndpointModels(provider);
    if (result.type === "failure") {
      notifyEndpointFailure(ctx, result);
      return null;
    }
    ctx.ui.notify(`拉取到 ${result.validCount} 个 Model`, "success");
    return result;
  });
  let providerId = initialProviderId;
  let state: Partial<SettingsPanelState> = { categoryId: "general", fieldId: "id", focusedPane: "fields", narrowScreen: "fields" };
  const retained = new Map<string, { baseline: unknown; value: unknown }>();

  while (true) {
    const snapshot = actions.readEditorSnapshot();
    if (snapshot.type !== "snapshot") {
      notifyActionFailure(ctx, snapshot);
      return;
    }
    const provider = providerFrom(snapshot.native, providerId);
    if (!provider) return;
    const categories = buildProviderCategories(providerId, provider);
    const result = await openPanel(ctx, { title: `Provider: ${providerId}`, categories }, state);
    state = result.state;
    if (result.type === "back") return;
    if (result.type === "search") {
      const selected = await search(ctx, "搜索 Provider 字段", fieldOptions(categories), { maxVisible: 12 });
      if (selected) state = selectState(result.state, selected);
      continue;
    }
    const fieldId = result.fieldId;

    if (result.categoryId === "general" && fieldId === "id") {
      const target = await collectRequiredString(ctx, "重命名 Provider", `${providerId}-new`);
      if (target.status === "cancel" || target.value === providerId) continue;
      const discard = hasMalformedLegacy(provider)
        ? await ctx.ui.confirm("Malformed legacy extraPayload", "重命名需要丢弃 malformed legacy rows。继续？")
        : true;
      if (!discard) continue;
      const saved = await commitProviderIdentity(ctx, actions, {
        kind: "rename",
        providerId,
        targetProviderId: target.value,
        ...(hasMalformedLegacy(provider) ? { legacyDiscardResolution: "discard-malformed-legacy" } : {}),
      });
      if (saved) providerId = target.value;
      continue;
    }
    if (result.categoryId === "general" && fieldId === "name") {
      const value = await collectOptionalString(ctx, "Provider 显示名称", "输入显示名称");
      if (value.status !== "cancel") didSave(ctx, await actions.patchProvider(providerId, { name: value.status === "clear" ? null : value.value }, { fieldBaselines: { name: ownValue(provider, "name") } }));
      continue;
    }
    if (result.categoryId === "general" && fieldId === "baseUrl") {
      const value = await collectOptionalString(ctx, "Provider API Base URL", "输入 URL");
      if (value.status !== "cancel") didSave(ctx, await actions.patchProvider(providerId, { baseUrl: value.status === "clear" ? null : value.value }, { fieldBaselines: { baseUrl: ownValue(provider, "baseUrl") } }));
      continue;
    }
    if (result.categoryId === "general" && fieldId === "api") {
      const value = await ctx.ui.select("Provider API 类型", [...API_OPTIONS, "清除值", "取消"]);
      if (value && value !== "取消") didSave(ctx, await actions.patchProvider(providerId, { api: value === "清除值" ? null : value }, { fieldBaselines: { api: ownValue(provider, "api") } }));
      continue;
    }
    if (result.categoryId === "http-auth" && fieldId === "apiKey") {
      const current = ownValue(provider, "apiKey");
      const value = await collectApiKeyAction(ctx, typeof current === "string" ? current : undefined);
      if (value.status === "keep") continue;
      const next = value.status === "clear" ? null : value.status === "replace" ? value.value : undefined;
      if (next !== undefined) didSave(ctx, await actions.patchProvider(providerId, { apiKey: next }, { fieldBaselines: { apiKey: current } }));
      continue;
    }
    if (result.categoryId === "http-auth" && fieldId === "authHeader") {
      const selected = await ctx.ui.select("Provider Auth Header", ["使用默认值", "false", "true", "取消"]);
      if (selected && selected !== "取消") didSave(ctx, await actions.patchProvider(providerId, { authHeader: selected === "使用默认值" ? null : selected === "true" }, { fieldBaselines: { authHeader: ownValue(provider, "authHeader") } }));
      continue;
    }

    const draftKey = `${result.categoryId}:${fieldId}`;
    if (result.categoryId === "http-auth" && fieldId === "headers") {
      const stored = ownValue(provider, "headers") as Record<string, string> | undefined;
      const held = retained.get(draftKey);
      const baseline = held?.baseline ?? stored;
      const edited = await editStringMapDraft(ctx, "Provider Headers", (held?.value ?? stored) as Record<string, string> | undefined);
      if (edited.status === "discard") retained.delete(draftKey);
      else {
        const next = Object.keys(edited.value).length > 0 ? edited.value : undefined;
        const saved = didSave(ctx, await actions.saveProviderSubtree(providerId, "headers", baseline, next));
        if (saved) retained.delete(draftKey); else retained.set(draftKey, { baseline, value: edited.value });
      }
      continue;
    }
    if (result.categoryId === "compatibility" && fieldId === "compat") {
      const stored = ownValue(provider, "compat") as Record<string, unknown> | undefined;
      const held = retained.get(draftKey);
      const baseline = held?.baseline ?? stored;
      const edited = await editCompatDraft(ctx, "Provider Compat", (held?.value ?? stored) as Record<string, unknown> | undefined);
      if (edited.status === "discard") retained.delete(draftKey);
      else {
        const next = Object.keys(edited.value).length > 0 ? edited.value : undefined;
        const saved = didSave(ctx, await actions.saveProviderSubtree(providerId, "compat", baseline, next));
        if (saved) retained.delete(draftKey); else retained.set(draftKey, { baseline, value: edited.value });
      }
      continue;
    }
    if (result.categoryId === "models" && fieldId === "manageModels") {
      await runModels(ctx, providerId, { actions, search });
      continue;
    }
    if (result.categoryId === "models" && fieldId === "fetchModels") {
      await fetchAndCommit(ctx, actions, providerId, provider, fetchModels);
      continue;
    }
    if (result.categoryId === "models" && fieldId === "modelOverrides") {
      const stored = ownValue(provider, "modelOverrides") as Record<string, ModelOverrideConfig> | undefined;
      const held = retained.get(draftKey);
      const baseline = held?.baseline ?? stored;
      const edited = await editOverridesDraft(ctx, providerId, (held?.value ?? stored) as Record<string, ModelOverrideConfig> | undefined, editOverride);
      if (edited.status === "discard") retained.delete(draftKey);
      else {
        const saved = didSave(ctx, await actions.saveProviderSubtree(providerId, "modelOverrides", baseline, Object.keys(edited.value).length > 0 ? edited.value : undefined));
        if (saved) retained.delete(draftKey); else retained.set(draftKey, { baseline, value: edited.value });
      }
      continue;
    }
    if (result.categoryId === "actions" && fieldId === "copy") {
      const target = await targetInput(ctx, "复制 Provider - 新 ID", `${providerId}-copy`);
      if (!target) continue;
      const discard = hasMalformedLegacy(provider)
        ? await ctx.ui.confirm("Malformed legacy extraPayload", "复制需要丢弃 malformed legacy rows。继续？")
        : true;
      if (!discard) continue;
      await commitProviderIdentity(ctx, actions, {
        kind: "copy",
        providerId,
        targetProviderId: target,
        ...(hasMalformedLegacy(provider) ? { legacyDiscardResolution: "discard-malformed-legacy" } : {}),
      });
      continue;
    }
    if (result.categoryId === "actions" && fieldId === "delete") {
      if (!await ctx.ui.confirm("删除 Provider", `确认删除 Provider "${providerId}" 及其 Models？`)) continue;
      const discard = hasMalformedLegacy(provider)
        ? await ctx.ui.confirm("Malformed legacy extraPayload", "删除需要丢弃 malformed legacy rows。继续？")
        : true;
      if (!discard) continue;
      const saved = await commitProviderIdentity(ctx, actions, {
        kind: "delete",
        providerId,
        ...(hasMalformedLegacy(provider) ? { legacyDiscardResolution: "discard-malformed-legacy" } : {}),
      });
      if (saved) return;
    }
  }
}

export async function createProviderAndOpen(
  ctx: ExtensionCommandContext,
  dependencies: ProviderEditorDependencies = {},
): Promise<string | undefined> {
  const actions = dependencies.actions ?? new ModelConfigActions();
  const id = await collectRequiredString(ctx, "新建 Provider", "Provider ID");
  if (id.status === "cancel") return undefined;
  const baseUrl = await collectRequiredString(ctx, `Provider ${id.value} - Base URL`, "API Base URL");
  if (baseUrl.status === "cancel") return undefined;
  const api = await ctx.ui.select(`Provider ${id.value} - API 类型`, [...API_OPTIONS, "取消"]);
  if (!api || api === "取消") return undefined;
  const config: ProviderConfig = { baseUrl: baseUrl.value, api, models: [] };
  const first = await actions.createProvider(id.value, config);
  if (!didSave(ctx, first)) return undefined;
  await runProviderEditor(ctx, id.value, { ...dependencies, actions });
  return id.value;
}

export async function runProviderList(
  ctx: ExtensionCommandContext,
  dependencies: ProviderEditorDependencies = {},
): Promise<void> {
  const actions = dependencies.actions ?? new ModelConfigActions();
  const search = dependencies.search ?? searchableSelect;
  while (true) {
    const snapshot = actions.readEditorSnapshot();
    if (snapshot.type !== "snapshot") {
      notifyActionFailure(ctx, snapshot);
      return;
    }
    const entries = Object.entries(snapshot.native.providers);
    const options: SearchableSelectOption[] = [
      ...entries.map(([id, provider]) => ({
        value: `provider:${id}`,
        label: `编辑 [${id}]`,
        description: `${typeof getOwnValue(provider, "name") === "string" ? getOwnValue(provider, "name") : ""} ${Array.isArray(getOwnValue(provider, "models")) ? (getOwnValue(provider, "models") as unknown[]).length : 0} models`,
        searchText: [id, getOwnValue(provider, "name")].filter((value): value is string => typeof value === "string").join(" "),
      })), 
      { value: ACTION_ADD_PROVIDER, label: "添加新 Provider", searchText: "add new 添加 新建" },
      { value: ACTION_BACK, label: "返回", searchText: "back return 返回" },
    ];
    const selected = await search(ctx, "Provider 管理", options, { maxVisible: 12 });
    if (!selected || selected === ACTION_BACK) return;
    if (selected === ACTION_ADD_PROVIDER) {
      await createProviderAndOpen(ctx, { ...dependencies, actions });
      continue;
    }
    if (selected.startsWith("provider:")) await runProviderEditor(ctx, selected.slice("provider:".length), { ...dependencies, actions });
  }
}
