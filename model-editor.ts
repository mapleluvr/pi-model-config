import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  ModelConfigActions,
  parseLegacyExtraPayload,
  type ActionResult,
  type FieldPatchOptions,
  type LegacyDiscardResolution,
  type ModelIdentityRequest,
  type PayloadCollisionResolution,
} from "./config-actions.ts";
import {
  collectNonNegativeRate,
  collectOptionalString,
  collectPositiveInteger,
  collectRequiredString,
  editCompatDraft,
  editCostDraft,
  editPayloadDraft,
  editStringMapDraft,
  editThinkingMapDraft,
  formatNestedCount,
  formatSettingValue,
  type DraftEditorResult,
} from "./field-editors.ts";
import { deepCloneJson } from "./model-fields.ts";
import { getOwnValue, hasOwnKey, setOwnValue, deleteOwnKey } from "./own-keys.ts";
import { lookupModelPayload } from "./payload-config.ts";
import { searchableMultiSelect } from "./searchable-multi-select.ts";
import { searchableSelect, type SearchableSelectOption } from "./searchable-select.ts";
import {
  openSettingsPanel,
  type SettingsCategoryDescriptor,
  type SettingsPanelResult,
  type SettingsPanelState,
} from "./settings-panel.ts";
import type { ModelConfig, ModelOverrideConfig, ModelsConfig } from "./types.ts";

const ACTION_ADD_MODEL = "__pi_model_config_action:add_model";
const ACTION_BACK = "__pi_model_config_action:back";
const THINKING_WARNING = "Reasoning 已关闭；Thinking Map 会保留但当前不生效";
const INPUT_OPTIONS = [
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
];
const API_OPTIONS = [
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations",
];
const OVERRIDE_ALLOWED_KEYS = new Set([
  "name",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "headers",
  "compat",
]);

export interface PayloadSummary {
  count: number;
}

type PayloadSummaryInput = PayloadSummary | number | string;

export interface ModelEditorDependencies {
  actions?: ModelConfigActions;
  openPanel?: typeof openSettingsPanel;
  search?: typeof searchableSelect;
  multiSelect?: typeof searchableMultiSelect;
}

export type ModelOverrideDraftResult =
  | { status: "save"; value: ModelOverrideConfig; unsupportedPaths: string[] }
  | { status: "discard"; value: ModelOverrideConfig; unsupportedPaths: string[] };

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return getOwnValue(record, key);
}

function inputDisplay(value: unknown, inherited = false): string {
  if (value === undefined) return formatSettingValue(undefined, inherited ? "inherited" : "not-set");
  return Array.isArray(value) ? value.join(", ") : "(无效)";
}

function costValue(model: ModelConfig | ModelOverrideConfig, key: string, inherited = false): string {
  const cost = ownValue(model, "cost");
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return formatSettingValue(undefined, inherited ? "inherited" : "not-set");
  }
  return formatSettingValue(ownValue(cost as Record<string, unknown>, key), inherited ? "inherited" : "not-set");
}

function costTiers(model: ModelConfig | ModelOverrideConfig, inherited = false): string {
  const cost = ownValue(model, "cost");
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return formatSettingValue(undefined, inherited ? "inherited" : "not-set");
  }
  return formatNestedCount(ownValue(cost as Record<string, unknown>, "tiers"), "层", inherited ? "inherited" : "not-set");
}

function nestedWarning(model: ModelConfig): string | undefined {
  const map = ownValue(model, "thinkingLevelMap");
  return ownValue(model, "reasoning") === false && map && typeof map === "object" && !Array.isArray(map) && Object.keys(map).length > 0
    ? THINKING_WARNING
    : undefined;
}

export function buildModelCategories(
  model: ModelConfig,
  payloadSummary?: PayloadSummaryInput,
): SettingsCategoryDescriptor[] {
  return [
    {
      id: "general",
      label: "常规",
      fields: [
        { id: "id", label: "Model ID", displayValue: String(ownValue(model, "id") ?? ""), searchText: "模型 标识", action: "edit-field" },
        { id: "name", label: "显示名称", displayValue: formatSettingValue(ownValue(model, "name")), searchText: "名称", action: "edit-field" },
      ],
    },
    {
      id: "endpoint",
      label: "端点覆盖",
      fields: [
        { id: "api", label: "API 类型", displayValue: formatSettingValue(ownValue(model, "api"), "inherited"), action: "edit-field" },
        { id: "baseUrl", label: "API Base URL", displayValue: formatSettingValue(ownValue(model, "baseUrl"), "inherited"), action: "edit-field" },
        { id: "headers", label: "Headers", displayValue: formatNestedCount(ownValue(model, "headers"), "项", "inherited"), action: "open-section" },
      ],
    },
    {
      id: "capability",
      label: "能力与限制",
      fields: [
        { id: "reasoning", label: "Reasoning", displayValue: formatSettingValue(ownValue(model, "reasoning")), action: "edit-field" },
        { id: "input", label: "输入类型", displayValue: inputDisplay(ownValue(model, "input")), action: "edit-field" },
        { id: "contextWindow", label: "Context Window", displayValue: formatSettingValue(ownValue(model, "contextWindow")), action: "edit-field" },
        { id: "maxTokens", label: "最大输出 Tokens", displayValue: formatSettingValue(ownValue(model, "maxTokens")), action: "edit-field" },
      ],
    },
    {
      id: "thinking",
      label: "Thinking",
      fields: [
        {
          id: "thinkingLevelMap",
          label: "Thinking Map",
          displayValue: formatNestedCount(ownValue(model, "thinkingLevelMap"), "项"),
          warning: nestedWarning(model),
          action: "open-section",
        },
      ],
    },
    {
      id: "cost",
      label: "成本",
      fields: [
        { id: "input", label: "输入价格", displayValue: costValue(model, "input"), action: "edit-field" },
        { id: "output", label: "输出价格", displayValue: costValue(model, "output"), action: "edit-field" },
        { id: "cacheRead", label: "缓存读取价格", displayValue: costValue(model, "cacheRead"), action: "edit-field" },
        { id: "cacheWrite", label: "缓存写入价格", displayValue: costValue(model, "cacheWrite"), action: "edit-field" },
        { id: "tiers", label: "成本分层", displayValue: costTiers(model), action: "open-section" },
      ],
    },
    {
      id: "compatibility",
      label: "兼容性",
      fields: [
        { id: "compat", label: "Compat", displayValue: formatNestedCount(ownValue(model, "compat"), "项"), action: "open-section" },
      ],
    },
    {
      id: "payload",
      label: "请求参数",
      fields: [
        { id: "payload", label: "Payload", displayValue: payloadSummary === undefined
          ? "(未设置)"
          : typeof payloadSummary === "string"
            ? payloadSummary
            : `${typeof payloadSummary === "number" ? payloadSummary : payloadSummary.count} 项`, action: "open-section" },
      ],
    },
    {
      id: "actions",
      label: "操作",
      fields: [
        { id: "copy", label: "复制 Model", displayValue: "", action: "run-action" },
        { id: "delete", label: "删除 Model", displayValue: "", action: "run-action" },
      ],
    },
  ];
}

export function buildModelOverrideCategories(
  targetId: string,
  override: ModelOverrideConfig,
): SettingsCategoryDescriptor[] {
  return [
    {
      id: "general",
      label: "常规",
      fields: [
        { id: "targetId", label: "目标 Model ID", displayValue: targetId, action: "run-action" },
        { id: "name", label: "显示名称", displayValue: formatSettingValue(ownValue(override, "name"), "inherited"), action: "edit-field" },
      ],
    },
    {
      id: "capability",
      label: "能力与限制",
      fields: [
        { id: "reasoning", label: "Reasoning", displayValue: formatSettingValue(ownValue(override, "reasoning"), "inherited"), action: "edit-field" },
        { id: "input", label: "输入类型", displayValue: inputDisplay(ownValue(override, "input"), true), action: "edit-field" },
        { id: "contextWindow", label: "Context Window", displayValue: formatSettingValue(ownValue(override, "contextWindow"), "inherited"), action: "edit-field" },
        { id: "maxTokens", label: "最大输出 Tokens", displayValue: formatSettingValue(ownValue(override, "maxTokens"), "inherited"), action: "edit-field" },
      ],
    },
    {
      id: "thinking",
      label: "Thinking",
      fields: [
        {
          id: "thinkingLevelMap",
          label: "Thinking Map",
          displayValue: formatNestedCount(ownValue(override, "thinkingLevelMap"), "项", "inherited"),
          warning: nestedWarning(override as ModelConfig),
          action: "open-section",
        },
      ],
    },
    {
      id: "cost",
      label: "成本",
      fields: [
        { id: "input", label: "输入价格", displayValue: costValue(override, "input", true), action: "edit-field" },
        { id: "output", label: "输出价格", displayValue: costValue(override, "output", true), action: "edit-field" },
        { id: "cacheRead", label: "缓存读取价格", displayValue: costValue(override, "cacheRead", true), action: "edit-field" },
        { id: "cacheWrite", label: "缓存写入价格", displayValue: costValue(override, "cacheWrite", true), action: "edit-field" },
        { id: "tiers", label: "成本分层", displayValue: costTiers(override, true), action: "open-section" },
      ],
    },
    {
      id: "headers",
      label: "Headers",
      fields: [
        { id: "headers", label: "Headers", displayValue: formatNestedCount(ownValue(override, "headers"), "项", "inherited"), action: "open-section" },
      ],
    },
    {
      id: "compatibility",
      label: "兼容性",
      fields: [
        { id: "compat", label: "Compat", displayValue: formatNestedCount(ownValue(override, "compat"), "项", "inherited"), action: "open-section" },
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

function selectedSearchState(state: SettingsPanelState, selected: string): SettingsPanelState {
  const separator = selected.indexOf(":");
  return {
    ...state,
    categoryId: selected.slice(0, separator),
    fieldId: selected.slice(separator + 1),
    focusedPane: "fields",
    narrowScreen: "fields",
  };
}

function modelFrom(config: ModelsConfig, providerId: string, modelId: string): ModelConfig | undefined {
  const provider = getOwnValue(config.providers, providerId);
  return provider?.models?.find((model) => getOwnValue(model, "id") === modelId);
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

async function choosePayloadResolution(ctx: ExtensionCommandContext): Promise<PayloadCollisionResolution | undefined> {
  const choice = await ctx.ui.select("私有 Payload 冲突", ["复用目标 Payload", "替换目标 Payload", "取消"]);
  if (!choice || choice === "取消") return undefined;
  return choice.startsWith("复用") ? "reuse-target" : "replace-target";
}

function malformedLegacy(model: ModelConfig): boolean {
  if (!hasOwnKey(model, "extraPayload")) return false;
  return !parseLegacyExtraPayload(getOwnValue(model, "extraPayload")).ok;
}

function clearIdentityResolutions(request: ModelIdentityRequest): ModelIdentityRequest {
  const cleared = deepCloneJson(request);
  deleteOwnKey(cleared as Record<string, unknown>, "payloadCollisionResolution");
  deleteOwnKey(cleared as Record<string, unknown>, "legacyDiscardResolution");
  return cleared;
}

function modelIdentityNeedsLegacyDiscard(actions: ModelConfigActions, request: ModelIdentityRequest): boolean {
  const snapshot = actions.readEditorSnapshot();
  if (snapshot.type !== "snapshot" || hasOwnKey(request as Record<string, unknown>, "legacyDiscardResolution")) return false;
  const provider = getOwnValue(snapshot.native.providers, request.providerId);
  if (!provider || !Array.isArray(getOwnValue(provider, "models"))) return false;
  const model = (getOwnValue(provider, "models") as ModelConfig[]).find((entry) => getOwnValue(entry, "id") === request.modelId);
  return model ? malformedLegacy(model) : false;
}

async function confirmLegacyDiscard(ctx: ExtensionCommandContext): Promise<boolean> {
  return await ctx.ui.confirm(
    "Malformed legacy extraPayload",
    "检测到 malformed legacy rows。确认丢弃后继续？取消会保留原始数据。",
  );
}

async function completeSimpleAction(
  ctx: ExtensionCommandContext,
  actions: ModelConfigActions,
  first: ActionResult,
  retry: (options: FieldPatchOptions) => Promise<ActionResult>,
): Promise<ActionResult> {
  let result = first;
  while (result.type === "payload-collision" || result.type === "validation-error" || result.type === "stale-target") {
    const token = result.resolutionToken;
    if (!token) return result;
    let payloadCollisionResolution: PayloadCollisionResolution | undefined;
    let legacyDiscardResolution: LegacyDiscardResolution | undefined;
    const collisions = "collisions" in result ? result.collisions : undefined;
    const malformed = "malformedIdentities" in result ? result.malformedIdentities : undefined;
    if (collisions && collisions.length > 0) {
      payloadCollisionResolution = await choosePayloadResolution(ctx);
      if (!payloadCollisionResolution) {
        actions.discardResolutionToken(token);
        return result;
      }
    }
    if (malformed && malformed.length > 0) {
      const discard = await ctx.ui.confirm(
        "Malformed legacy extraPayload",
        "检测到 malformed legacy rows。确认丢弃后继续？取消会保留原始数据。",
      );
      if (!discard) {
        actions.discardResolutionToken(token);
        return result;
      }
      legacyDiscardResolution = "discard-malformed-legacy";
    }
    result = await retry({ resolutionToken: token, payloadCollisionResolution, legacyDiscardResolution });
  }
  return result;
}

async function commitModelIdentity(
  ctx: ExtensionCommandContext,
  actions: ModelConfigActions,
  initialRequest: ModelIdentityRequest,
): Promise<boolean> {
  let request = clearIdentityResolutions(initialRequest);
  while (true) {
    if (modelIdentityNeedsLegacyDiscard(actions, request)) {
      if (!await confirmLegacyDiscard(ctx)) return false;
      request = { ...request, legacyDiscardResolution: "discard-malformed-legacy" };
    }
    const preview = await actions.previewModelIdentityAction(request);
    if (preview.type === "payload-collision") {
      const resolution = await choosePayloadResolution(ctx);
      if (!resolution) return false;
      request = { ...request, payloadCollisionResolution: resolution } as ModelIdentityRequest;
      continue;
    }
    if (preview.type === "validation-error" && modelIdentityNeedsLegacyDiscard(actions, request)) {
      if (!await confirmLegacyDiscard(ctx)) return false;
      request = { ...request, legacyDiscardResolution: "discard-malformed-legacy" };
      continue;
    }
    if (preview.type !== "preview") {
      notifyActionFailure(ctx, preview);
      return false;
    }
    const confirmed = await ctx.ui.confirm(
      "确认 Model 操作",
      `${preview.descriptor.kind}: ${preview.descriptor.sourceModelId ?? ""}${preview.descriptor.targetModelId ? ` -> ${preview.descriptor.targetModelId}` : ""}\n受影响身份: ${preview.descriptor.affectedIdentities.length}\nPayload 冲突: ${preview.descriptor.collisions.length}`,
    );
    if (!confirmed) {
      actions.discardIdentityPreview(preview.token);
      return false;
    }
    const committed = await actions.commitModelIdentityAction(preview.token);
    if (committed.type === "stale-target" && committed.preview) {
      // A drift refresh intentionally clears resolutions. Never reconfirm it; restart below.
      actions.discardIdentityPreview(committed.preview.token);
      ctx.ui.notify("配置已变化，请重新检查并确认操作", "warning");
      request = clearIdentityResolutions(initialRequest);
      continue;
    }
    return didSave(ctx, committed);
  }
}

async function patchModelField(
  ctx: ExtensionCommandContext,
  actions: ModelConfigActions,
  providerId: string,
  modelId: string,
  key: string,
  baseline: unknown,
  value: unknown,
): Promise<boolean> {
  const patch = { [key]: value };
  const options = { fieldBaselines: { [key]: baseline } };
  const first = await actions.patchModel(providerId, modelId, patch, options);
  const result = await completeSimpleAction(
    ctx,
    actions,
    first,
    (resolution) => actions.patchModel(providerId, modelId, patch, { ...options, ...resolution }),
  );
  return didSave(ctx, result);
}

async function editApiChoice(
  ctx: ExtensionCommandContext,
  title: string,
): Promise<{ status: "cancel" } | { status: "value"; value: string | null }> {
  const selected = await ctx.ui.select(title, [...API_OPTIONS, "使用默认值", "清除值", "取消"]);
  if (!selected || selected === "取消") return { status: "cancel" };
  return { status: "value", value: selected === "使用默认值" || selected === "清除值" ? null : selected };
}

async function editBooleanChoice(
  ctx: ExtensionCommandContext,
  title: string,
  allowDefault = false,
): Promise<{ status: "cancel" } | { status: "value"; value: boolean | null }> {
  const options = [...(allowDefault ? ["使用继承值"] : []), "false", "true", "取消"];
  const selected = await ctx.ui.select(title, options);
  if (!selected || selected === "取消") return { status: "cancel" };
  if (selected === "使用继承值") return { status: "value", value: null };
  return { status: "value", value: selected === "true" };
}

async function editNativeBooleanChoice(
  ctx: ExtensionCommandContext,
  title: string,
): Promise<{ status: "cancel" } | { status: "value"; value: boolean | null }> {
  const action = await ctx.ui.select(title, ["设置值", "使用默认值", "取消"]);
  if (!action || action === "取消") return { status: "cancel" };
  if (action === "使用默认值") return { status: "value", value: null };
  return editBooleanChoice(ctx, title);
}

async function editNativePositiveInteger(
  ctx: ExtensionCommandContext,
  title: string,
  current: unknown,
): Promise<{ status: "cancel" } | { status: "value"; value: number | null }> {
  const action = await ctx.ui.select(title, ["设置值", "使用默认值", "取消"]);
  if (!action || action === "取消") return { status: "cancel" };
  if (action === "使用默认值") return { status: "value", value: null };
  return collectPositiveInteger(ctx, title, String(current ?? ""));
}

async function editInputTypes(
  ctx: ExtensionCommandContext,
  multiSelect: typeof searchableMultiSelect,
  title: string,
  current: unknown,
  absenceChoice?: "使用默认值" | "使用继承值",
): Promise<{ status: "cancel" } | { status: "value"; value: Array<"text" | "image"> | null }> {
  if (absenceChoice) {
    const action = await ctx.ui.select(title, ["设置值", absenceChoice, "取消"]);
    if (!action || action === "取消") return { status: "cancel" };
    if (action === absenceChoice) return { status: "value", value: null };
  }
  const initial = Array.isArray(current) ? current.filter((value): value is "text" | "image" => value === "text" || value === "image") : ["text"];
  const selected = await multiSelect(ctx, title, INPUT_OPTIONS, initial, {
    hint: "输入关键字过滤，空格切换，Enter 保存，Esc 取消",
  });
  if (selected === undefined) return { status: "cancel" };
  const supported = selected.filter((value): value is "text" | "image" => value === "text" || value === "image");
  if (supported.length === 0) {
    ctx.ui.notify("输入类型必须至少保留 text 或 image", "error");
    return { status: "cancel" };
  }
  return { status: "value", value: supported };
}

function defaultModel(modelId: string): ModelConfig {
  return {
    id: modelId,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export async function runModelEditor(
  ctx: ExtensionCommandContext,
  providerId: string,
  initialModelId: string,
  dependencies: ModelEditorDependencies = {},
): Promise<void> {
  const actions = dependencies.actions ?? new ModelConfigActions();
  const openPanel = dependencies.openPanel ?? openSettingsPanel;
  const search = dependencies.search ?? searchableSelect;
  const multiSelect = dependencies.multiSelect ?? searchableMultiSelect;
  let modelId = initialModelId;
  let state: Partial<SettingsPanelState> = {
    categoryId: "general",
    fieldId: "id",
    focusedPane: "fields",
    narrowScreen: "fields",
    categoryScrollOffset: 0,
    fieldScrollOffset: 0,
  };
  const retained = new Map<string, { baseline: unknown; value: unknown }>();

  while (true) {
    const snapshot = actions.readEditorSnapshot();
    if (snapshot.type !== "snapshot") {
      notifyActionFailure(ctx, snapshot);
      return;
    }
    const model = modelFrom(snapshot.native, providerId, modelId);
    if (!model) {
      ctx.ui.notify("Model 已不存在", "warning");
      return;
    }
    const privatePayload = lookupModelPayload(snapshot.payload, providerId, modelId);
    const legacy = hasOwnKey(model, "extraPayload") ? parseLegacyExtraPayload(getOwnValue(model, "extraPayload")) : undefined;
    const visiblePayload = privatePayload ?? (legacy?.ok ? legacy.payload : undefined);
    const categories = buildModelCategories(model, visiblePayload ? { count: Object.keys(visiblePayload).length } : undefined);
    const result = await openPanel(ctx, { title: `Model: ${providerId}/${modelId}`, categories }, state);
    state = result.state;
    if (result.type === "back") return;
    if (result.type === "search") {
      const selected = await search(ctx, "搜索 Model 字段", fieldOptions(categories), { maxVisible: 12 });
      if (selected) state = selectedSearchState(result.state, selected);
      continue;
    }

    const fieldId = result.fieldId;
    if (result.categoryId === "general" && fieldId === "id") {
      const target = await collectRequiredString(ctx, "重命名 Model", `${modelId}-new`);
      if (target.status === "cancel" || target.value === modelId) continue;
      const saved = await commitModelIdentity(ctx, actions, {
        kind: "rename",
        providerId,
        modelId,
        targetModelId: target.value,
      });
      if (saved) modelId = target.value;
      continue;
    }
    if (result.categoryId === "general" && fieldId === "name") {
      const value = await collectOptionalString(ctx, "Model 显示名称", "输入显示名称");
      if (value.status !== "cancel") await patchModelField(ctx, actions, providerId, modelId, "name", ownValue(model, "name"), value.status === "clear" ? null : value.value);
      continue;
    }
    if (result.categoryId === "endpoint" && fieldId === "api") {
      const value = await editApiChoice(ctx, "Model API 类型");
      if (value.status === "value") await patchModelField(ctx, actions, providerId, modelId, "api", ownValue(model, "api"), value.value);
      continue;
    }
    if (result.categoryId === "endpoint" && fieldId === "baseUrl") {
      const value = await collectOptionalString(ctx, "Model API Base URL", "输入覆盖 URL");
      if (value.status !== "cancel") await patchModelField(ctx, actions, providerId, modelId, "baseUrl", ownValue(model, "baseUrl"), value.status === "clear" ? null : value.value);
      continue;
    }
    if (result.categoryId === "capability" && fieldId === "reasoning") {
      const value = await editNativeBooleanChoice(ctx, "Model Reasoning");
      if (value.status === "value") await patchModelField(ctx, actions, providerId, modelId, "reasoning", ownValue(model, "reasoning"), value.value);
      continue;
    }
    if (result.categoryId === "capability" && fieldId === "input") {
      const value = await editInputTypes(ctx, multiSelect, "Model 输入类型", ownValue(model, "input"), "使用默认值");
      if (value.status === "value") await patchModelField(ctx, actions, providerId, modelId, "input", ownValue(model, "input"), value.value);
      continue;
    }
    if (result.categoryId === "capability" && (fieldId === "contextWindow" || fieldId === "maxTokens")) {
      const value = await editNativePositiveInteger(
        ctx,
        fieldId === "contextWindow" ? "Context Window" : "最大输出 Tokens",
        ownValue(model, fieldId),
      );
      if (value.status === "value") await patchModelField(ctx, actions, providerId, modelId, fieldId, ownValue(model, fieldId), value.value);
      continue;
    }
    if (result.categoryId === "cost" && fieldId !== "tiers") {
      const action = await ctx.ui.select(`Model 成本 - ${fieldId}`, ["设置费率", "清除整个 Cost（使用默认值）", "取消"]);
      if (!action || action === "取消") continue;
      const baseline = ownValue(model, "cost");
      if (action === "清除整个 Cost（使用默认值）") {
        didSave(ctx, await actions.saveModelSubtree(providerId, modelId, "cost", baseline, null));
        continue;
      }
      const value = await collectNonNegativeRate(ctx, `Model 成本 - ${fieldId}`, costValue(model, fieldId));
      if (value.status === "cancel") continue;
      const next = deepCloneJson((baseline && typeof baseline === "object" && !Array.isArray(baseline))
        ? baseline
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      setOwnValue(next as Record<string, unknown>, fieldId, value.value);
      didSave(ctx, await actions.saveModelSubtree(providerId, modelId, "cost", baseline, next));
      continue;
    }

    if (result.categoryId === "actions" && fieldId === "copy") {
      const raw = await ctx.ui.editor("复制 Model - 新 ID", `${modelId}-copy`);
      const target = raw?.trim();
      if (!target) continue;
      await commitModelIdentity(ctx, actions, {
        kind: "copy",
        providerId,
        modelId,
        targetModelId: target,
      });
      continue;
    }
    if (result.categoryId === "actions" && fieldId === "delete") {
      if (!await ctx.ui.confirm("删除 Model", `确认删除 Model "${modelId}"？`)) continue;
      const saved = await commitModelIdentity(ctx, actions, {
        kind: "delete",
        providerId,
        modelId,
      });
      if (saved) return;
      continue;
    }

    const draftKey = `${result.categoryId}:${fieldId}`;
    if (result.categoryId === "endpoint" && fieldId === "headers") {
      const stored = ownValue(model, "headers") as Record<string, string> | undefined;
      const held = retained.get(draftKey);
      const baseline = held?.baseline ?? stored;
      const draft = (held?.value ?? stored) as Record<string, string> | undefined;
      const edited = await editStringMapDraft(ctx, "Model Headers", draft);
      if (edited.status === "discard") retained.delete(draftKey);
      else {
        const next = Object.keys(edited.value).length > 0 ? edited.value : undefined;
        const saved = didSave(ctx, await actions.saveModelSubtree(providerId, modelId, "headers", baseline, next));
        if (saved) retained.delete(draftKey); else retained.set(draftKey, { baseline, value: edited.value });
      }
      continue;
    }
    if (result.categoryId === "thinking" && fieldId === "thinkingLevelMap") {
      const stored = ownValue(model, "thinkingLevelMap") as Record<string, unknown> | undefined;
      const held = retained.get(draftKey);
      const baseline = held?.baseline ?? stored;
      const draft = (held?.value ?? stored) as Record<string, unknown> | undefined;
      const warning = nestedWarning(model);
      const edited = await editThinkingMapDraft(ctx, warning ? `Thinking Map - ${warning}` : "Thinking Map", draft, true);
      if (edited.status === "discard") retained.delete(draftKey);
      else {
        const next = Object.keys(edited.value).length > 0 ? edited.value : undefined;
        const saved = didSave(ctx, await actions.saveModelSubtree(providerId, modelId, "thinkingLevelMap", baseline, next));
        if (saved) retained.delete(draftKey); else retained.set(draftKey, { baseline, value: edited.value });
      }
      continue;
    }
    if (result.categoryId === "cost" && fieldId === "tiers") {
      const stored = ownValue(model, "cost") as Record<string, unknown> | undefined;
      const held = retained.get(draftKey);
      const baseline = held?.baseline ?? stored;
      const draft = (held?.value ?? stored) as Record<string, unknown> | undefined;
      const action = await ctx.ui.select("Model 成本与分层", ["编辑 Cost 与分层", "清除整个 Cost（使用默认值）", "取消"]);
      if (!action || action === "取消") continue;
      if (action === "清除整个 Cost（使用默认值）") {
        const saved = didSave(ctx, await actions.saveModelSubtree(providerId, modelId, "cost", baseline, null));
        if (saved) retained.delete(draftKey);
        continue;
      }
      const edited = await editCostDraft(ctx, "Model 成本与分层", draft ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      if (edited.status === "discard") retained.delete(draftKey);
      else {
        const saved = didSave(ctx, await actions.saveModelSubtree(providerId, modelId, "cost", baseline, edited.value));
        if (saved) retained.delete(draftKey); else retained.set(draftKey, { baseline, value: edited.value });
      }
      continue;
    }
    if (result.categoryId === "compatibility" && fieldId === "compat") {
      const stored = ownValue(model, "compat") as Record<string, unknown> | undefined;
      const held = retained.get(draftKey);
      const baseline = held?.baseline ?? stored;
      const draft = (held?.value ?? stored) as Record<string, unknown> | undefined;
      const edited = await editCompatDraft(ctx, "Model Compat", draft);
      if (edited.status === "discard") retained.delete(draftKey);
      else {
        const next = Object.keys(edited.value).length > 0 ? edited.value : undefined;
        const saved = didSave(ctx, await actions.saveModelSubtree(providerId, modelId, "compat", baseline, next));
        if (saved) retained.delete(draftKey); else retained.set(draftKey, { baseline, value: edited.value });
      }
      continue;
    }
    if (result.categoryId === "payload" && fieldId === "payload") {
      const held = retained.get(draftKey);
      const baseline = held?.baseline ?? privatePayload;
      const draft = (held?.value ?? visiblePayload) as Record<string, unknown> | undefined;
      const edited = await editPayloadDraft(ctx, "Model Payload", draft);
      if (edited.status === "discard") {
        retained.delete(draftKey);
        continue;
      }
      const next = Object.keys(edited.value).length > 0 ? edited.value : undefined;
      let actionResult: ActionResult;
      if (hasOwnKey(model, "extraPayload")) {
        const first = await actions.patchModel(providerId, modelId, {}, {
          fieldBaselines: { extraPayload: getOwnValue(model, "extraPayload") },
          payload: next ?? null,
        });
        actionResult = await completeSimpleAction(ctx, actions, first, (resolution) => actions.patchModel(providerId, modelId, {}, {
          fieldBaselines: { extraPayload: getOwnValue(model, "extraPayload") },
          payload: next ?? null,
          ...resolution,
        }));
      } else {
        actionResult = await actions.saveModelPayload(providerId, modelId, baseline as Record<string, unknown> | undefined, next);
      }
      const saved = didSave(ctx, actionResult);
      if (saved) retained.delete(draftKey); else retained.set(draftKey, { baseline, value: edited.value });
    }
  }
}

export async function createModelAndOpen(
  ctx: ExtensionCommandContext,
  providerId: string,
  dependencies: ModelEditorDependencies = {},
): Promise<string | undefined> {
  const actions = dependencies.actions ?? new ModelConfigActions();
  const id = await collectRequiredString(ctx, `新建 Model - ${providerId}`, "Model ID");
  if (id.status === "cancel") return undefined;
  const model = defaultModel(id.value);
  const first = await actions.createModel(providerId, model);
  const completed = await completeSimpleAction(ctx, actions, first, (resolution) => actions.createModel(providerId, model, resolution));
  if (!didSave(ctx, completed)) return undefined;
  await runModelEditor(ctx, providerId, id.value, { ...dependencies, actions });
  return id.value;
}

function modelSummary(model: ModelConfig): string {
  const id = getOwnValue(model, "id");
  const name = getOwnValue(model, "name");
  return `${typeof name === "string" && name ? name : String(id ?? "")}  ctx=${formatSettingValue(getOwnValue(model, "contextWindow"))}  max=${formatSettingValue(getOwnValue(model, "maxTokens"))}`;
}

export async function runModelList(
  ctx: ExtensionCommandContext,
  providerId: string,
  dependencies: ModelEditorDependencies = {},
): Promise<void> {
  const actions = dependencies.actions ?? new ModelConfigActions();
  const search = dependencies.search ?? searchableSelect;
  while (true) {
    const snapshot = actions.readEditorSnapshot();
    if (snapshot.type !== "snapshot") {
      notifyActionFailure(ctx, snapshot);
      return;
    }
    const provider = getOwnValue(snapshot.native.providers, providerId);
    if (!provider) return;
    const models = Array.isArray(getOwnValue(provider, "models"))
      ? getOwnValue(provider, "models") as ModelConfig[]
      : [];
    const options: SearchableSelectOption[] = [
      ...models.filter((model) => typeof getOwnValue(model, "id") === "string").map((model) => ({
        value: `model:${String(getOwnValue(model, "id") ?? "")}`,
        label: `Model ${String(getOwnValue(model, "id") ?? "")}`,
        description: modelSummary(model),
        searchText: [getOwnValue(model, "id"), getOwnValue(model, "name")].filter((value): value is string => typeof value === "string").join(" "),
      })),
      { value: ACTION_ADD_MODEL, label: "添加新 Model", searchText: "add new 添加 新建" },
      { value: ACTION_BACK, label: "返回", searchText: "back return 返回" },
    ];
    const selected = await search(ctx, `Models - ${providerId}`, options, { maxVisible: 12 });
    if (!selected || selected === ACTION_BACK) return;
    if (selected === ACTION_ADD_MODEL) {
      await createModelAndOpen(ctx, providerId, { ...dependencies, actions });
      continue;
    }
    if (selected.startsWith("model:")) {
      await runModelEditor(ctx, providerId, selected.slice("model:".length), { ...dependencies, actions });
    }
  }
}

const UNSUPPORTED_PREVIEW_LIMIT = 20;
const UNSUPPORTED_PATH_LENGTH_LIMIT = 160;

export function unsupportedOverrideKeys(value: ModelOverrideConfig): string[] {
  return Object.keys(value).filter((key) => !OVERRIDE_ALLOWED_KEYS.has(key)).sort();
}

function unsupportedOverridePaths(value: ModelOverrideConfig): string[] {
  return unsupportedOverrideKeys(value).map((key) => `$.${key}`);
}

export function formatUnsupportedOverridePreview(paths: readonly string[]): string {
  const visible = paths.slice(0, UNSUPPORTED_PREVIEW_LIMIT).map((path) => (
    path.length <= UNSUPPORTED_PATH_LENGTH_LIMIT
      ? path
      : `${path.slice(0, UNSUPPORTED_PATH_LENGTH_LIMIT - 3)}...`
  ));
  const remaining = paths.length - visible.length;
  return [...visible, ...(remaining > 0 ? [`另有 ${remaining} 个不支持字段`] : [])].join("\n");
}

function setOptionalDraftValue(draft: ModelOverrideConfig, key: string, value: unknown | null): void {
  if (value === null) deleteOwnKey(draft, key);
  else setOwnValue(draft, key, value);
}

function setCostDraftValue(draft: ModelOverrideConfig, key: string, value: unknown | null): void {
  const current = ownValue(draft, "cost");
  const cost = deepCloneJson(current && typeof current === "object" && !Array.isArray(current) ? current : {}) as Record<string, unknown>;
  if (value === null) deleteOwnKey(cost, key);
  else setOwnValue(cost, key, value);
  if (Object.keys(cost).length === 0) deleteOwnKey(draft, "cost");
  else setOwnValue(draft, "cost", cost);
}

export async function editModelOverrideEntryDraft(
  ctx: ExtensionCommandContext,
  targetId: string,
  existing: ModelOverrideConfig,
  dependencies: Pick<ModelEditorDependencies, "openPanel" | "search" | "multiSelect"> = {},
): Promise<ModelOverrideDraftResult> {
  const original = deepCloneJson(existing);
  const draft = deepCloneJson(existing);
  const openPanel = dependencies.openPanel ?? openSettingsPanel;
  const search = dependencies.search ?? searchableSelect;
  const multiSelect = dependencies.multiSelect ?? searchableMultiSelect;
  let state: Partial<SettingsPanelState> = { categoryId: "general", fieldId: "name", focusedPane: "fields", narrowScreen: "fields" };

  while (true) {
    const categories = buildModelOverrideCategories(targetId, draft);
    const result = await openPanel(ctx, { title: `Model Override: ${targetId}`, categories }, state);
    state = result.state;
    if (result.type === "search") {
      const selected = await search(ctx, "搜索 Override 字段", fieldOptions(categories), { maxVisible: 12 });
      if (selected) state = selectedSearchState(result.state, selected);
      continue;
    }
    if (result.type === "back") {
      const unsupportedPaths = unsupportedOverridePaths(draft);
      if (unsupportedPaths.length === 0) return { status: "save", value: draft, unsupportedPaths };
      ctx.ui.notify("Override 包含不支持字段；普通保存不会持久化这些字段", "warning");
      const action = await ctx.ui.select("Override 包含不支持字段", [
        "查看不支持字段",
        "移除不支持字段并保存",
        "取消并保留原值",
      ]);
      const preview = formatUnsupportedOverridePreview(unsupportedPaths);
      if (action === "查看不支持字段") {
        ctx.ui.notify(preview, "warning");
        continue;
      }
      if (action === "移除不支持字段并保存") {
        if (!await ctx.ui.confirm("移除不支持字段", preview)) continue;
        for (const path of unsupportedPaths) deleteOwnKey(draft, path.slice(2));
        return { status: "save", value: draft, unsupportedPaths };
      }
      return { status: "discard", value: original, unsupportedPaths };
    }
    const fieldId = result.fieldId;
    if (result.categoryId === "general" && fieldId === "targetId") {
      ctx.ui.notify("目标 Model ID 请在 Overrides 列表中重命名", "info");
      continue;
    }
    if (result.categoryId === "general" && fieldId === "name") {
      const value = await collectOptionalString(ctx, "Override 显示名称", "输入覆盖名称");
      if (value.status !== "cancel") setOptionalDraftValue(draft, "name", value.status === "clear" ? null : value.value);
      continue;
    }
    if (result.categoryId === "capability" && fieldId === "reasoning") {
      const value = await editBooleanChoice(ctx, "Override Reasoning", true);
      if (value.status === "value") setOptionalDraftValue(draft, "reasoning", value.value);
      continue;
    }
    if (result.categoryId === "capability" && fieldId === "input") {
      const value = await editInputTypes(ctx, multiSelect, "Override 输入类型", ownValue(draft, "input"), "使用继承值");
      if (value.status === "value") setOptionalDraftValue(draft, "input", value.value);
      continue;
    }
    if (result.categoryId === "capability" && (fieldId === "contextWindow" || fieldId === "maxTokens")) {
      const action = await ctx.ui.select(fieldId, ["设置值", "使用继承值", "取消"]);
      if (!action || action === "取消") continue;
      if (action === "使用继承值") setOptionalDraftValue(draft, fieldId, null);
      else {
        const value = await collectPositiveInteger(ctx, fieldId, String(ownValue(draft, fieldId) ?? ""));
        if (value.status === "value") setOptionalDraftValue(draft, fieldId, value.value);
      }
      continue;
    }
    if (result.categoryId === "cost" && fieldId !== "tiers") {
      const action = await ctx.ui.select(`Override 成本 - ${fieldId}`, ["设置值", "使用继承值", "取消"]);
      if (!action || action === "取消") continue;
      if (action === "使用继承值") setCostDraftValue(draft, fieldId, null);
      else {
        const value = await collectNonNegativeRate(ctx, `Override 成本 - ${fieldId}`, costValue(draft, fieldId, true));
        if (value.status === "value") setCostDraftValue(draft, fieldId, value.value);
      }
      continue;
    }
    let edited: DraftEditorResult<Record<string, unknown>> | DraftEditorResult<Record<string, string>> | undefined;
    let key: "thinkingLevelMap" | "cost" | "headers" | "compat" | undefined;
    if (result.categoryId === "thinking") {
      key = "thinkingLevelMap";
      const warning = nestedWarning(draft as ModelConfig);
      edited = await editThinkingMapDraft(
        ctx,
        warning ? `Override Thinking Map - ${warning}` : "Override Thinking Map",
        ownValue(draft, key) as Record<string, unknown> | undefined,
        true,
      );
    } else if (result.categoryId === "cost" && fieldId === "tiers") {
      key = "cost";
      edited = await editCostDraft(ctx, "Override 成本与分层", ownValue(draft, key) as Record<string, unknown> | undefined);
    } else if (result.categoryId === "headers") {
      key = "headers";
      edited = await editStringMapDraft(ctx, "Override Headers", ownValue(draft, key) as Record<string, string> | undefined);
    } else if (result.categoryId === "compatibility") {
      key = "compat";
      edited = await editCompatDraft(ctx, "Override Compat", ownValue(draft, key) as Record<string, unknown> | undefined);
    }
    if (key && edited?.status === "save") setOptionalDraftValue(draft, key, Object.keys(edited.value).length > 0 ? edited.value : null);
  }
}
