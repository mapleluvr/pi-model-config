# Pi 1.1.0 配置面变更与 pi-model-config 适配及兼容迁移分析

## 1. 基线、版本来源与第一手证据

- **调研日期**：2026-10-09
- **当前插件基线**：`pi-model-config@1.2.1`（commit `bdc54ac`，代码基准声明为 Pi 0.85.1）。
- **目标上游版本**：`@earendil-works/pi-coding-agent@1.1.0`、`@earendil-works/pi-ai@1.1.0`、`@earendil-works/pi-agent-core@1.1.0`。
  - 发布时间：`2026-10-07T22:16:26.802Z`，npm dist-tags `latest: "1.1.0"`。
  - 源码与包实物：已解包至 `docs/research/upstream-1.1.0/`，建立可复跑的依赖测试环境。

### 第一手代码差异证据

| 模块 / 文件 | 对比基准 (1.0.4) | 上游 1.1.0 | 差异结论与实测证据 |
|---|---|---|---|
| `model-config.js` (`models.json` Schema) | `1.0.4` (13,747 字节) | `1.1.0` (13,747 字节) | **完全一致（Byte-for-byte identical）**。<br>SHA-256: `24a0e0f98672766e16e00d9f61587f50f9481915581156ae71a14e48ee912e4c`，`Buffer.equals` 为 true。<br>1.1.0 未对 `models.json` 引入任何新的顶级或模型字段。 |
| `provider-composer.js` (模型组合与继承) | `1.0.4` (24,395 字节) | `1.1.0` (24,395 字节) | **完全一致**。<br>SHA-256: `b088d1babb75360da6bf1bcbe8e140ce600e1db15f51345f1965d3d1e9f267ef`，`Buffer.equals` 为 true。<br>模型组合逻辑未变。向 models.json 注入非 chat 模型时，模型条目（id, api）保留在 `getModels()` 中，但 `type` 属性被剥离为 `undefined`，上游 `isModelType()` 将其解释为缺省的 `"chat"` 模型。models.json 依然无法声明独立的 image/classifier 类型模型。 |
| `settings-manager.js` (`settings.json` Schema) | `1.0.4` (42,894 字节) | `1.1.0` (43,953 字节) | `Settings` interface 核心定义**完全一致**。<br>新增 `isToolModifier`, `getToolListError`, `applyToolModifiers` 辅助函数，支持 `--tools` 及 `defaultTools` 的 `+name`/`-name` 增量工具修饰符。 |
| `pi-ai/dist/types.d.ts` (API/Compat/类型) | `1.0.4` (48,858 字节) | `1.1.0` (49,649 字节) | 差异严格为 4 个 hunk（见 `docs/research/types-diff.patch`）：<br>1. `KnownClassifierApi` 增加 `"openai-decisions"`；<br>2. `AssistantMessage.durationMs?: number`；<br>3. `ToolResultMessage.durationMs?: number`；<br>4. `ClassifierContext.images?: ImageContent[]`。<br>**Chat API、KnownProvider（42个）、Chat Compat 字段零变动。** |
| `pi-ai/dist/providers/openai.js` | 仅加载 `OPENAI_MODELS` | 新增 `openai-decisions` 分类器 API 及 `gpt-6-luna` 分类器模型挂载 | `gpt-6-luna` 现以双重身份存在：Chat 模型 (`openai-responses`) 与 Classifier 模型 (`openai-decisions`)。OAuth 凭据自动过滤分类器模型。 |
| `pi-ai/dist/api/openai-codex-responses.js` | `headers` 覆盖顺序固定在内部之后 | 修复默认 headers 优先逻辑 | `models.json` 中的 `headers` 现可正常覆盖默认的 `originator` 与 `User-Agent`。 |
| `pi-ai/dist/api/bedrock-converse-stream.js` | 无 haiku-5 适配，OpenAI on Bedrock 思考档位未传递 | 增加 haiku-5 自适应思考支持；增加 OpenAI GPT on Bedrock 的 `reasoning.effort` 映射 | 引擎内部参数构造修复。 |
| `pi-ai/dist/api/mistral-conversations.js` | `finish_reason: "error"` 终止会话 | 标记为 `"server error"` | 错误变为可重试（retryable）。 |

---

## 2. 字段更新全景（1.1.0 与 1.0.x 累积增量 vs 插件当前 0.85.1 实现）

当前 `pi-model-config` 插件的实现代码基线停留在 **0.85.1**。因此适配上游 Pi 1.1.0 需补齐从 0.85.1 到 1.1.0（主要是 1.0.0 - 1.0.4 引入并持续沿用至 1.1.0 的全部新配置面）：

### 2.1 需要新增支持的模型字段（同时作用于 `models[]` 与 `modelOverrides`）

1. `samplingParamsByThinkingLevel`（Pi 1.0.2 引入，1.1.0 沿用）：
   - 类型：`Partial<Record<"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max", Record<string, unknown>>>`
   - 合并语义：逐 level 选取，在每个 level 内部为顶层 key 浅覆盖（Object.assign，实测非深递归合并）。在请求时由 Pi 解析的有效 thinking level 覆盖模型 sampling defaults。
2. `inputLimits`（Pi 1.0.0 引入，1.1.0 沿用）：
   - 类型：
     - `maxRequestBytes?: number`
     - `images?: { maxPerMessage?: number, maxPerRequest?: number, resize?: { maxWidth?: number, maxHeight?: number, maxBytes?: number, jpegQuality?: number } }`
   - 约束：正整数；`jpegQuality` 必须在 1-100 之间（Pi schema 会主动拒绝 101 等越界值）。
3. `promptCache`（Pi 1.0.0 引入，1.1.0 沿用）：
   - 类型：`{ short?: number, long?: number }`
   - 约束：严格大于 0 的有限数字（Pi schema 会主动拒绝 `short: 0`）。

### 2.2 需要新增支持的 Compat 控制项

1. `allowedFallbackModels`（Anthropic Messages 专用）：
   - 类型：`Array<{ provider: string, model: string, cost: ModelCost }>`。
   - 作用：**Anthropic 服务端 refusal fallback 目标**（对应请求体的 `fallbacks: [{ model }]`）；并在服务端返回 fallback 模型时，由本地客户端根据 `cost` 元数据计算 usage cost。它**不控制本地重试**。
   - 策略：上游虽然因 TypeBox union 缺陷放行多于 3 项，但插件校验层主动强化约束为最多 3 项（Hardening Policy）。
2. `supportsMidConvoSystemMessages`（适用于 OpenAI Completions/Responses, Anthropic, Mistral 等）：
   - 类型：`boolean`（默认 false）。保留对话中途出现的 system/developer 消息。
3. `supportsMidConvoToolAdditions`（OpenAI Completions）：
   - 类型：`boolean`。中途动态引入新工具。依赖 `supportsMidConvoSystemMessages: true`。
4. `supportsMidConvoToolChanges`（Anthropic）：
   - 类型：`boolean`。中途动态增删工具。依赖 `supportsMidConvoSystemMessages: true`。
5. `thinkingTokenBudgetField`（补齐已有缺口）：
   - 枚举：`"thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens"`。
   - 实测证明：当设置 `thinkingTokenBudgetField` 时，上游 `openai-completions` 会直接使用该字符串作为 request payload 的 key 名（例如实测传 `max_tokens` 时，payload 出现 `max_tokens: 4096`）。因此插件必须强制校验枚举，禁止任意字符串透传。
6. `supportsThinkingTokenBudget`（补齐已有缺口）：
   - 类型：`boolean`。当为 true 且缺失 `thinkingTokenBudgetField` 时，上游默认使用 `"thinking_token_budget"`。显式字段优先于此 alias 开关。

### 2.3 边界说明

1. **Classifier 模型（如 `gpt-6-luna` on `openai-decisions`）**：
   - 上游文档（`docs/models.md`）明确指出：“Classifier models do not appear in /model ... models.json definitions/overrides are chat-only”。
   - 探针证实：向 models.json 注入非 chat 模型时，其 `type` 属性丢失，作为 chat-like 模型参与解析。
   - 结论：**插件不应将 classifier API 加入 chat API 下拉框或 models.json 编辑面板**。
2. **`defaultTools` 的 `+name`/`-name` 修饰符**：
   - 属于 `settings.json` 的 CLI/用户首选项范畴，由 Pi 核心管理，插件的 subagent 工具覆盖遵循既有列表契约。

---

## 3. 已有 pi-model-config 配置面的 Deprecate 与清理清单

| 字段 / 项 | 当前插件状态 | Upstream 1.1.0 现状 | 处理方式 | 证据与理由 |
|---|---|---|---|---|
| `compat.deferredToolsMode` | 在类型、校验、UI 中声明（唯一旧值 `"kimi"`） | 运行时代码及 schema 彻底废弃，无任何消费者 | **完全废弃，移除 UI，并在保存/Doctor 时自动剥离** | 探针 11 实测对请求无任何影响。严禁映射为其他工具开关。 |
| `compat.supportsToolReferences` | 在布尔开关列表中暴露 | 运行时代码及 schema 彻底废弃，无任何消费者 | **完全废弃，移除 UI，并在保存/Doctor 时自动剥离** | 探针 11 实测无请求影响。严禁自动重命名为 `supportsMidConvoToolChanges`。 |
| Provider ID: `azure-openai-responses` | 在内置 Provider 识别表中列出 | 1.0.3+ 更名为 `azure`，1.1.0 持续使用 `azure` | **内置识别表废弃旧 ID，全面支持 `azure`，提供幂等迁移** | 1.1.0 中若使用旧 ID 且不显式配置 `api`，composer 直接报错无法继承。注：API 枚举 `azure-openai-responses` 仍合法保留。 |
| `compat.sendSessionIdHeader` | 插件遗留了半自动化覆盖迁移函数 | Pi 0.80.7 废弃，由 `sessionAffinityFormat` 取代 | **废弃该兼容开关，收紧迁移逻辑** | 用户环境已有 32 处残留；当前插件会强行把已有显式格式覆盖为 `openai-nosession`（探针 16）。需修复覆盖漏洞并 fail-closed。 |
| `unsupportedOverrideKeys` 白名单阻断 | `model-editor.ts:50-61` 将新字段阻断并提示清理 | 1.1.0 合法字段 | **将合法新字段加入白名单** | 避免引导用户把合法的 `samplingParamsByThinkingLevel`、`inputLimits`、`promptCache` 当作非法字段删掉。 |

### 不能废除的项（防过拟合反向核对）：

1. `compat.supportsAdditionalTools` & `supportsToolSearch`：虽然 models.json 的 TypeBox schema 移除了它们的显式声明，但 `pi-ai` 的 Responses adapter 内部仍有活跃读取分支（探针 13 实测改变真实 payload）。**绝不能删除**。
2. `compat.supportsExplicitPromptCacheMode`, `zaiToolStream`, `thinkingTokenBudgetField`, `supportsThinkingTokenBudget`：仍有活跃运行时读取者，保留。
3. API 类型 `azure-openai-responses`：Provider ID 变为 `azure`，但其内部派发的 API 名依然是 `azure-openai-responses`。

---

## 4. 向后兼容迁移方案（Migration Strategy）

### 4.1 Azure Provider Identity 幂等迁移

- **涉及范围**：
  - `models.json` 中的 `providers["azure-openai-responses"]` -> `providers["azure"]`
  - `model-config-payloads.json` 中的 `[oldProvider, modelId]` key -> `[azure, modelId]`
  - `settings.json` 中的 `defaultProvider`、`enabledModels`、`modelThinkingLevels`、`compaction.modelOverrides`
  - Subagent 配置中的 `subagents.agentOverrides.*.model` 以及 **`subagents.agentOverridesByProvider` 中的 provider map key 与嵌套 model 字符串**。
- **事务与原子性定性**：
  - 插件底层依赖单个文件的原子替换（`atomicReplace`），跨多个文件（`models.json`, `model-config-payloads.json`, `settings.json`）**不具备原生操作系统级跨文件原子事务**。
  - **防御性设计（Fail-Closed）**：
    1. Preflight 检查：检查所有目标文件是否存在已有的 `azure` 冲突 key；若存在冲突，**立即终止并报错，严禁覆盖**。
    2. 写入前生成 migration journal 记录修改前后的内容与散列值。
    3. 顺序执行 `atomicReplace`，若中途任一文件写入失败，立刻中止，记录详细未决状态和恢复指引。
    4. **凭据文件 `auth.json` 绝不自动写入**：插件遵循值盲原则，仅在完成其他迁移后明确提示用户：“请运行 `/login azure` 或手动迁移 auth.json”。

### 4.2 废弃 Compat 字段的安全剥离（`stripDeprecatedCompatKeys`）

- 实现独立的 `stripDeprecatedCompatKeys(compat: Record<string, unknown>): Record<string, unknown>`：
  - 精确删除 `deferredToolsMode` 和 `supportsToolReferences`；
  - 严格保留其他所有已知及未知扩展属性；
  - 在 `saveModelDraft`、`saveOverrideDraft`、`saveProviderDraft` 以及 Doctor 修复路径统一调用；
  - 保证操作幂等（重复运行内容不变）。

### 4.3 修复 `sendSessionIdHeader` 迁移算法（Fail-Closed 边界）

改进 `planLegacySessionAffinityMigration` 与 `applyLegacySessionAffinityMigration`：
1. **显式值合法性保护**：若配置已存在非空的 `sessionAffinityFormat`：
   - 若属于合法枚举值（`"openai" | "openai-nosession" | "openrouter"`），**保留该显式值**，仅安全剥离旧的 `sendSessionIdHeader`。
   - 若属于非法值，**fail-closed 报错并提示人工处理**，不视为安全值。
2. **仅在已知支持的 API 迁移**：仅针对 `openai-responses`（及上游确有此语义的分支）且 legacy value 为严格布尔值：
   - `sendSessionIdHeader === false` 且缺失新字段 -> 迁移为 `"openai-nosession"`；
   - `sendSessionIdHeader === true` -> 剥离旧字段（因 true 为默认行为）；
   - 若 legacy value 为非布尔值（如字符串或未知类型），或出现在不支持该字段的 API 上，**fail-closed 报错**，禁止静默删除或猜度语义。

---

## 5. 探针验证与第一手实测证据（Pi 1.1.0）

探针脚本：`docs/research/pi-1.1.0-probes.mjs` 与 `docs/research/check-reviewer-items.mjs`。
运行环境：Node 24.18.0，离线环境，无任何网络请求，全部 20 项探针通过。

### 实测结果摘要
- **byte-for-byte 证据**：1.0.4 与 1.1.0 的 `model-config.js` 和 `provider-composer.js` 的 SHA-256 和 `Buffer.equals` 完全一致。
- **校验器与上游不对称**：Pi 1.1.0 拒绝 `jpegQuality: 101`、`promptCache.short: 0`、`samplingParamsByThinkingLevel: []`，当前插件放行。必须在插件层补齐校验。
- **thinkingTokenBudgetField 透传风险实测**：当配置非法值 `thinkingTokenBudgetField: "max_tokens"` 时，当前插件放行，而上游实际将 `max_tokens: 4096` 直接写入 request payload。必须收紧为枚举。
- **samplingParamsByThinkingLevel 合并实测**：同一 level 内的 override 是浅层覆盖（`{ nested: { a: 3 } }`），不对子对象深合并。

---

## 6. pi-model-config 变更实施方案（Action Plan）

### 阶段 1：校验层、类型定义与常量基准升级
- **文件**：`types.ts`, `config-validation.ts`, `model-fields.ts`
- **动作**：
  1. 内置 Providers 常量更新为 42 个（`azure-openai-responses` -> `azure`，新增 `meta`, `typesafe`）。
  2. 扩展模型与 Override 类型：`samplingParamsByThinkingLevel`、`inputLimits`、`promptCache`。
  3. 严格校验器：
     - `inputLimits`: 限制正整数，`jpegQuality` 必须在 1-100；
     - `promptCache`: 严格大于 0 的有限数；
     - `samplingParamsByThinkingLevel`: 限制 7 个合法 thinking level key，值为 object；
     - `allowedFallbackModels`: 数组最多 3 项，严格校验 `provider`, `model`, `cost`；
     - `thinkingTokenBudgetField`: 严格限制 3 项枚举（`"thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens"`）；
     - `supportsThinkingTokenBudget`: 严格布尔值。
  4. 支持认证型空 Provider。

### 阶段 2：编辑面板完整覆盖与废弃字段剥离
- **文件**：`model-editor.ts`, `compat-settings.ts`, `field-editors.ts`
- **动作**：
  1. `OVERRIDE_ALLOWED_KEYS` 增加合法新字段白名单，防止误删。
  2. 实现全套编辑界面支持：为 `inputLimits`、`promptCache`、`samplingParamsByThinkingLevel` 增加专用子树编辑器、分类面板展示与保存 dispatch。
  3. 实现 `stripDeprecatedCompatKeys()`，在模型/Provider 保存及编辑时安全剥离 `deferredToolsMode` 与 `supportsToolReferences`。
  4. 增加 `allowedFallbackModels` 结构化编辑器与中途工具变更开关。
  5. 暴露 `thinkingTokenBudgetField` 下拉枚举及 `supportsThinkingTokenBudget` 开关。

### 阶段 3：迁移引擎健壮性升级（Fail-Closed）
- **文件**：`compat-settings.ts`, `config-actions.ts`
- **动作**：
  1. 修复 `applyLegacySessionAffinityMigration`：保留显式合法枚举，未知 API/非法值 fail-closed。
  2. 实现 Azure Provider 迁移执行器：
     - 全面扫描 `models.json`、`model-config-payloads.json`、`settings.json`（含 `defaultProvider`、`enabledModels`、`modelThinkingLevels`）、以及 `subagents.agentOverrides` 和 `subagents.agentOverridesByProvider`；
     - preflight 冲突检测（若存在 `azure` 冲突则中止）；
     - 生成 migration journal；
     - 逐文件原子替换，出错中断并给出恢复信息；
     - 明确提示用户手动完成 `/login azure`。

### 阶段 4：测试套件覆盖与文档更新
- **文件**：`tests/*.test.ts`, `package.json`, `README.md`, `README-CN.md`
- **动作**：
  1. 编写全面的单元测试：
     - 新字段非法值校验测试（jpegQuality 101, promptCache 0, invalid thinking budget 等）；
     - `stripDeprecatedCompatKeys` 幂等性测试；
     - `sessionAffinityFormat` 显式保留与 fail-closed 测试；
     - Azure 迁移覆盖（含 `agentOverridesByProvider` 映射与冲突 abort）；
     - 新字段在 models 和 modelOverrides 中的读写、显示与浅合并测试。
  2. 对齐 devDependencies 中的 pi-tui 依赖声明。
  3. 更新 README 中插件支持的基线版本说明为 Pi 1.1.0。
