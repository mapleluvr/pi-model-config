# Pi 1.0.4 配置面变更 → pi-model-config 适配分析

## 1. 基线与结论

- 调研日期：2026-10-07。
- 插件：`pi-model-config@1.2.1`，代码基线 `2171b85`；原生配置面声明为 Pi **0.85.1**，Subagent 面声明为 pi-subagents **0.68.0**。
- 目标：`@earendil-works/pi-coding-agent@1.0.4`、`@earendil-works/pi-ai@1.0.4`；本机安装的两个包均已核实为此版本。1.0.4 发布于 2026-10-05；npm `gitHead` 为 `7c10bd4337495ee613f2224843ecdf349b80d1df`。
- 本轮是**分析，不是适配实现**：仅新增本文和可复跑的研究探针；不升级插件依赖、不改运行时代码、不读写用户凭据、不迁移实际配置。
- 核心工作：**删除 2 个失效 compat 编辑项；迁移 Azure Provider identity；新增 3 组 Model/Override 字段、4 个 compat 控制项；补齐既有 thinking-budget 缺口，并调整 API 家族标注。**
- 最重要的风险不是“少几个输入框”：当前 override 清理逻辑会把 3 个新合法字段列为不支持；校验器会放行 Pi 拒绝的新字段错误值；Azure 被误判成自定义 Provider。

### 证据路径约定

下文 `U/` 指安装的 `pi-coding-agent` 包根目录；`A/` 指 `U/node_modules/@earendil-works/pi-ai`。
本机 `U = C:/Users/Administrator/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent`。

主要证据：

- `U/dist/core/model-config.js:46-223`：真实 models.json schema。
- `U/dist/core/provider-composer.js:29-115,145-184,345-367`：模型构造、各层合并、chat-only 边界。
- `A/dist/types.d.ts:15-35,617-789`：API/Provider 名单及 compat 类型。
- `A/dist/api/{openai-completions,openai-responses,anthropic-messages,azure-openai-responses,openai-codex-responses,mistral-conversations}.js`：实际读取者。
- `U/docs/models.md`、`settings.md`、`providers.md`；`U/CHANGELOG.md:25-61`（Azure 更名、分思考档位采样）。
- [固定上游提交](https://github.com/earendil-works/pi/tree/7c10bd4337495ee613f2224843ecdf349b80d1df)，对应源码在 `packages/coding-agent/src/core/`、`packages/ai/src/`。

## 2. 需要删除什么

| 项目 | 1.0.4 证据与处理 |
|---|---|
| `compat.deferredToolsMode`（唯一旧值 `"kimi"`） | schema、pi-ai compat 类型、运行时 JS 均不再声明/读取。删除类型、校验枚举和编辑入口；已有值可列入版本化遗留清理。**不要映射为某个新工具能力开关。** |
| `compat.supportsToolReferences` | 同样无运行时读取者。删除类型、布尔校验清单和编辑入口。**不要自动改名成 `supportsMidConvoToolChanges`**：新字段要求中途 system messages + inline tool additions/removals，是另一份传输能力契约。 |
| 内置 Provider 名单中的 `azure-openai-responses` | 从“内置 Provider ID”集合移除，换成 `azure`。这是 identity 迁移，**不是删除 Provider 数据**；见下一节。 |

插件位置：`types.ts:115-159`、`compat-settings.ts:10-47`、`config-validation.ts:13-103,324-363`。

**不能删除：**

- `compat.supportsAdditionalTools`、`compat.supportsToolSearch`：虽然 1.0.4 的 models.json schema 不再列出，pi-ai 的 Responses 类型和三个 Responses adapter 仍然读取。探针已证明它们改变实际构造的请求。
- `compat.supportsExplicitPromptCacheMode`、`zaiToolStream`、`thinkingTokenBudgetField`、`supportsThinkingTokenBudget`：同样有真实引擎读取路径，不能以 schema 未列出为由清除。
- API 枚举 `azure-openai-responses`：仍有效；Azure Provider 同时分发此 API 和 `openai-completions`（`A/dist/providers/azure.js:34-44`）。
- `samplingParams`、私有 Payload、`oauth: "radius"`、现有 thinking levels：未被替代或删除。

## 3. 哪些配置应该迁移

### 3.1 必做：Azure Provider identity

Pi **1.0.3** 将 Provider ID 从 `azure-openai-responses` 更名为 `azure`。1.0.4 的启动迁移入口 `U/dist/migrations.js:281-289` 没有自动处理该更名；CHANGELOG 明确要求用户调整配置或重新登录。

必须区分“应迁移的引用”与“本插件当前有权限和事务能力自动写入的文件”：

| 位置 | 精确迁移规则 |
|---|---|
| `models.json.providers` | key `azure-openai-responses` → `azure`；Provider 对象、model IDs、headers、API type 不变。 |
| 私有 `model-config-payloads.json` | `[oldProvider, modelId]` identity → `[azure, modelId]`；包含该 Provider 的孤立私有 identity，也不能遗漏。复用现有 native + payload coordinator，不做字符串全局替换。 |
| 用户/当前项目 `settings.json` | `defaultProvider` 的精确值；`enabledModels` 中明确带旧 Provider 的模式前缀；`modelThinkingLevels` 的旧 Provider 前缀。若有 `compaction.modelOverrides`，同样迁移其精确 provider/model key。 |
| Subagent 设置 | 本插件管理的 `agentOverrides.*.model` 引用不能遗漏；还应报告 `defaultProvider`、`agentOverridesByProvider` 的旧 Provider key 和其中的 model 引用。扩展其他 model scope/defaultModel 等引用只按其自身契约处理，不任意递归替换所有字符串。 |
| `auth.json` | 官方要求移动同名 credential key，或执行 `/login azure`。**当前插件不是凭据管理器，不应悄悄新增 auth.json 写入功能**；保留为明确的外部完成步骤，或另行设计受锁保护、值盲的凭据迁移。 |
| 历史 session | 不自动重写历史；上游说明恢复旧 Provider session 会退回其他模型，旧 prompt cache 不会复用。 |

自动化条件：宿主版本已确认；旧 key 存在且新 key 无冲突；旧 identity 确属待迁移 Azure 配置；每份候选先验证。新旧 Provider、payload 或 settings key 共存时 **fail closed，报告冲突，不合并/覆盖**。若不能区分用户有意复用旧 ID 的自定义 Provider，应只给迁移预览。

不要把它实现成“打开面板就无条件改名”。现有 coordinator 只覆盖 models + payload，**不覆盖 auth + settings**；settings 还要与 Pi 的 `proper-lockfile` 协调（`U/dist/core/settings-manager.js:5,108,428`），不能宣称全配置原子迁移。建议“自动生成精确计划 + 无冲突的受管两文件迁移 + 列出待完成引用/登录步骤”，未完成依赖时不报告迁移全部成功。不扫描或修改其他项目目录。

### 3.2 失效字段：自动清理，不做能力升级

对目标内置 API 的 `Provider.compat`、`models[].compat`、`modelOverrides.*.compat` 精确删除 `deferredToolsMode`、`supportsToolReferences`。只针对确认属于 Pi 1.0.4 的失效字段；未知自定义 API 或扩展可能消费同名属性，不能全局按未知字段清理。

清理必须幂等、保留其余未知字段、复用现有写入/冲突检查、提供非敏感变更摘要。不能把旧 `true` 推导成“远端支持新协议”。

### 3.3 已有 `sendSessionIdHeader` 迁移需收紧，再考虑自动化

插件当前 `compat-settings.ts:131-173` 已有手工预览迁移，但并不适合原样变为自动迁移：

- 探针证实：已有 `sessionAffinityFormat: "openrouter"` + 旧 `sendSessionIdHeader: false` 时，当前执行函数会把新字段覆盖成 `"openai-nosession"`。
- 自动迁移应优先保留已有显式新字段，冲突提示；未知 API/错误类型只报告，不猜语义。
- `true` 可作为失效旧字段清理；`false` 在原本适用的 `openai-responses` 上、没有新字段且有效 API 明确时可映射为 `"openai-nosession"`。
- 当前插件也对 `openai-completions` 提供这种映射，但上游旧字段的破坏性变更公告针对 `openai-responses`。不要把“补足用户可能意图”冒充所有 API 上的等价迁移。
- Provider 层混合 API/继承/内置 Provider API 未显式写出的情况，要先解析有效配置，不能把无法判断当成可以删除 false 意图。

### 3.4 可选规范化：thinking budget 别名

`supportsThinkingTokenBudget: true` 与 `thinkingTokenBudgetField: "thinking_token_budget"` 仍同时被引擎支持，探针请求一致。可以在无显式新字段且继承关系明确时把 true 规范化为新字段，但这不是阻断升级的迁移。

**不能一律删除 false**：model-level false 可能用来覆盖 Provider-level true；删除会重新启用继承值。存在显式新字段时也不得覆盖它。

### 3.5 不应该自动做

- 私有 Payload → `samplingParams`：后者只对部分 OpenAI API 生效，私有 Payload 是请求 hook 的浅合并，语义/覆盖顺序不等价。
- 给所有模型补默认 `promptCache`、`inputLimits`、新工具能力 true：没有远端实证，不能推导。
- 根据 Pi 1.0.4 自动删改任意 `subagents` 字段：它们属于独立版本的 pi-subagents，不属于 Pi 核心 schema。

## 4. 需要新增什么

### 4.1 三组 Model 字段（同时支持 `models[]` 和 `modelOverrides`）

| 字段 | 类型、验证及合并语义 |
|---|---|
| `samplingParamsByThinkingLevel` | `Partial<Record<off\|minimal\|low\|medium\|high\|xhigh\|max, Record<string, unknown>>>`。Pi 1.0.2 新增。按 **Pi 的有效 thinking level**（先 clamp）选取，不用 `thinkingLevelMap` 的映射值作 key。顺序为模型 sampling defaults → 当前 level → request sampling params，后者逐 key 覆盖。Override 同一 level 按 key 合并。 |
| `inputLimits` | `maxRequestBytes`；`images.maxPerMessage/maxPerRequest`；`images.resize.maxWidth/maxHeight/maxBytes/jpegQuality`。均为正整数；jpegQuality ≤100。Override 对 images/resize 深度逐字段合并。 |
| `promptCache` | `{ short?: number, long?: number }`，严格大于 0 的有限秒数，可为小数；Override 按 tier 合并。没有已知 lifetime 的 tier 不参与 cache warming。不是 cache retention 选择器，不能用 0 表示关闭。 |

`inputLimits` 的语义要准确标注：resize 作用于**新进入历史**的图片，历史图片不随模型切换重编码；`maxBytes` 限制 base64 编码后 payload。`maxRequestBytes`、`maxPerMessage`、`maxPerRequest` 目前是元数据，Pi 尚不据此裁剪/拒绝历史。省略 resize 属性使用 2000×2000、4.5 MiB、JPEG 80 默认。

`samplingParams*` 适用 `openai-completions`、`openai-responses`、`azure-openai-responses`；不要把 `openai-codex-responses` 或全部 API 纳入。

**必须同步修改**：`types.ts` 两个 model 接口、`config-validation.ts:405-440`、`model-editor.ts:50-61` 的 `OVERRIDE_ALLOWED_KEYS`、两类编辑面板、`model-fields.ts` 子树类型和测试。

当前 `unsupportedOverrideKeys()`（`model-editor.ts:866-871`）会把这三组合法新字段列为不支持，保存时引导“清理后保存”（`:921-939`）。它**不是静默自动删除**，但错误清理提示会引导用户丢失合法配置，应优先修复。

### 4.2 新增四个 compat 控制项

| 字段 | 有效 API / 约束 |
|---|---|
| `allowedFallbackModels` | Anthropic Messages；最多 3 项，每项 `{ provider: 非空字符串, model: 非空字符串, cost: 完整价格对象 }`。可空数组，表示不发 `fallbacks`，并抑制继承的列表。传到服务器的只有 model；provider/cost 是本地计价匹配元数据。不是 pi-subagents 的历史 `fallbackModels`。 |
| `supportsMidConvoSystemMessages` | OpenAI Completions、Responses/Azure/Codex、Anthropic、Mistral。默认 false；true 保留中途 system/developer 消息，否则合并回开头的 system prompt。 |
| `supportsMidConvoToolAdditions` | OpenAI Completions；要求 `supportsMidConvoSystemMessages`，允许在会话中途引入工具。 |
| `supportsMidConvoToolChanges` | Anthropic；要求 `supportsMidConvoSystemMessages`，控制 inline tool additions/removals。引擎还检查初始工具存在等条件。 |

后三项真实引擎已支持，但 `U/dist/core/model-config.js` 未声明，走额外属性透传。**因此既要加 UI，也要加插件自身 bool 校验。** 必须保持 opt-in；这里验证的是客户端怎样编码，不是远端模型是否真的支持。

`allowedFallbackModels` 需要数组编辑/校验入口，不能误套“JSON 对象字段”编辑器。校验完整 cost 和 maxItems；上游 compat union 会让超过 3 项甚至错误类型绕过 schema（探针已测到 4 项被接受）。

### 4.3 补齐既有缺口，而非宣称都是 1.0.4 新增

- 暴露 `thinkingTokenBudgetField` 枚举：`thinking_token_budget`、`thinking_budget`、`thinking_budget_tokens`。OpenAI Completions 从 `thinkingBudgets` 解析预算；旧 `supportsThinkingTokenBudget` 可保留为受验证的别名/遗留入口。0.85.1 调研已经提到引擎支持，但当前类型、编辑器、校验仍未补齐。
- `sessionAffinityFormat` 增补 Anthropic 说明：其支持 `"openrouter"` → `x-session-id`，并受 `sendSessionAffinityHeaders` 与 cache retention 条件影响（`A/dist/api/anthropic-messages.js:136-148`）。不要向 Anthropic 提供 OpenAI 格式的等价行为承诺。
- `supportsStrictMode` 的 API 家族标注加入 Bedrock（`A/dist/types.d.ts` 的 `BedrockCompat`）；它不是已删除的 OpenAI 专用字段。
- 内置 Provider 集合由 40 → 42：`azure-openai-responses` → `azure`，增加 `meta`、`typesafe`。`typesafe` 主要是 classifier Provider；加入内置身份识别不意味着允许在 models.json 创建 classifier。
- chat API 枚举仍是当前已有的 10 个，不需要增删；thinking levels 仍是现有七档，不需要迁移。

### 4.4 新操作类型不是当前 models.json 编辑面

Pi 新增 image/classifier 模型并不意味着本插件应把 `openrouter-images`、`typesafe-system-one` 等加入 chat API 下拉框。`provider-composer.js` 明确说明 models.json definitions/overrides 为 chat-only；探针中额外 `type: "image"` 被模型构造器丢弃。

如果以后要管理非 chat 模型，需要单独设计基于扩展/registry 的编辑面，不能靠放宽当前 schema 假装支持。

## 5. 同步修正与职责边界

1. **P1：Azure 内置判断。** `config-validation.ts:13` 和 `model-editor.ts:12` 依赖陈旧常量。实测新 `azure` 配置在设置合法 baseUrl、引用内置 model ID 并继承 API 时，Pi composer 可加载，而插件要求额外 api。不要维护两套相互漂移的 Provider→API 表；优先共享内置身份来源，离线快照要明确版本并测试。
2. **P1：新字段校验与 override 白名单。** 当前合法新字段被当未知保存，错误值也被放行；Pi 却会拒绝 `jpegQuality:101`、`promptCache.short:0`、`samplingParamsByThinkingLevel.high:[]`，导致插件保存成功但 Pi 重载失败。
3. **P2：认证型空 Provider。** 当前校验 `retainsEmptyProviderData`（`config-validation.ts:548-555`）不接受仅 apiKey/authHeader/oauth 的条目；1.0.4 composer 接受满足其条件的认证型条目。这是核对发现的额外缺口，不据此声称一定由本次版本新增。`oauth` 仍要求 baseUrl。
4. **开发验证基线。** `package.json` 的 pi-tui devDependency 仍为 0.85.1，应对齐 1.0.4 并重跑 UI/运行时测试；peer 仍由宿主提供。README 更新配置面版本，不把本轮研究说成已实现适配。
5. **不扩大为整个 Pi settings 编辑器。** `cacheWarming`、`defaultTools`、`codemode`、MCP、`transport`、TUI 新默认/新键位由 Pi 自己管理；新增 `promptCache` 时给 cacheWarming 关联说明即可。Subagent tools 的 Pi CLI pattern 语义也不能直接推导为 pi-subagents 的 allowlist 语义。

## 6. 实测证据与实施验收

研究脚本：`docs/research/pi-1.0.4-probes.mjs`。

```powershell
node --experimental-strip-types docs/research/pi-1.0.4-probes.mjs 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent'
```

19 项探针全部通过。使用真实 **ModelConfig.load → composeModelProvider → provider.streamSimple → adapter onPayload**；截取请求后终止，transport 被禁用，不访问任何远端。包含：

- Pi 拒绝、插件放行的新字段错误值；compat union 的新字段错型/越界绕过。
- Azure 新 Provider + 旧 API 的有效组合与插件误拒绝；旧 Provider 无内置层无法继承 API。
- inputLimits/promptCache/分档采样的真实 override 合并；最终采样参数 `temperature=0.8, top_k=30, top_p=0.6`。
- 失效两字段在受控 transcript 上请求不变；新增中途控制改变请求，Anthropic 发出 tool_addition。
- schema 已不列出的 Responses 两字段仍改变请求；fallback 列表、thinking-budget 别名实际生效。
- 当前 legacy migration 会覆盖显式新值；models.json 额外 image type 不会建立 image 模型。

边界：这些是本地生产配置/请求构造证据，**不是远端能力或完整交互 TUI 验收**；也没有重新统计当前用户配置中的遗留字段数量。旧报告中的“29 个 sendSessionIdHeader”不作为本轮现状。

实施顺序建议：

1. 对齐测试宿主；修新字段白名单/校验与 Azure 身份识别。
2. 删除失效入口；新增字段及 API 家族标注。
3. 在有效 API/继承解析基础上实现精确、幂等、冲突阻断的迁移计划；Azure 跨文件依赖显式报告。
4. 为 migration 增加混合 API、继承 false、旧/新 key 共存、payload 孤立 identity、重复运行、失败回滚/中断恢复用例。
5. 复跑真正的 1.0.4 请求构造探针和插件测试；TUI 手测保存→关闭重开 `/model`；远端能力开关单独做端点实证，不由客户端校验通过替代。

## 7. 独立复核

**未完成，基础设施阻断；不能标记 converged。**

已尝试 fresh-context、只读 `reviewer`，run `620f0eca-83ed-466c-9898-5d0066b0f750`，cwd `D:/Pi/extensions/pi-model-config`，branch `master`，runtime HEAD `2171b85`。启动前即失败：

```text
Background children require the host npm package (@earendil-works/pi-coding-agent) with its dependencies;
C:\Users\Administrator\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent
does not provide @earendil-works/pi-agent-core/node.
```

已核实安装的 `pi-agent-core@1.0.4/package.json` exports 只有根入口和 `./package.json`，无 `./node`。这是 pi-subagents 启动兼容性问题，不能通过删除/增加本插件的模型设置来修复。本轮没有更改宿主或绕过治理流程改用其他 CLI。

工作区检查：运行时代码无修改，仅本文和研究探针新增。需要启动器适配当前宿主后重做独立复核；目前交付的是有本地实证的分析稿，不是已通过独立评审的升级实现。
