# Pi 0.85.1 配置面变更 → pi-model-config 适配调研

- 日期：2026-09-06
- 调研对象：本目录插件 `pi-model-config@1.2.0`（README 声明基线 **Pi 0.80.6**）
- 上游：`@earendil-works/pi-coding-agent@0.85.1`（npm 全局安装，2026-09-05 发布）
- 运行实例：`PI_CODING_AGENT_DIR=D:\Pi\runtime\agent`，`settings.json.lastChangelogVersion=0.85.1`，`tuiMode=fullscreen`
- 结论：**必须改 9 项**（其中 7 项功能缺口、2 项打包/文档基线），**顺带修 3 项健壮性问题**；其余扩展 API、TUI 组件、hook 语义经核对**无需改动**。

---

## 1. 证据基线

| 证据 | 位置 |
| ------ | ------ |
| models.json 的 0.85.1 权威 schema（TypeBox v1，运行时编译） | `…/pi-coding-agent/dist/core/model-config.js`（`model-config.d.ts` 为生成物） |
| 校验入口 | `dist/core/model-config.js:235` `validateModelsConfig.Check(parsed)`；解析前 `stripJsonComments(stripBom(content))` |
| 引擎侧 compat 类型 | `…/@earendil-works/pi-ai/dist/types.d.ts:468-660`（`OpenAICompletionsCompat` / `OpenAIResponsesCompat` / `AnthropicMessagesCompat`） |
| 文档 | `docs/models.md`、`docs/settings.md`、`docs/packages.md:167-173`、`CHANGELOG.md` |
| 本机实测 | 见 §4 探针 A–N（直接用 `ModelConfig.load()` 校验真实 models.json 的变体） |
| 插件基线 | `README.md:105` / `README-CN.md:105`（"reads Pi 0.80.6 models.json"）、`package.json:29`（`@earendil-works/pi-tui: 0.79.1`） |

实测 `ModelConfig.load("D:/Pi/runtime/agent/models.json")` 返回 `getError() === undefined`，Provider 列表 `Mapleluv, Mapleluv-Main-MSG, Mapleluv-Main, AnyRouter`——**现网配置在 0.85.1 下可加载**，说明下面的问题目前是"功能缺口/误导"而非"启动即坏"。

---

## 2. models.json schema 差异（0.80.6 → 0.85.1）

### 2.1 Provider 级

| 字段 | 0.85.1 | 插件现状 | 处理 |
|------|--------|----------|------|
| `oauth` | `"radius"`（需 gateway `baseUrl`，见 docs/models.md Provider 表） | 缺失（`types.ts:16`、`config-validation.ts:412`、provider 编辑器无入口） | 新增枚举字段 |
| `baseUrl/apiKey/api/headers/authHeader/models/modelOverrides/compat` | 保留 | 已有 | 不变 |

> `compat.sendSessionIdHeader` **在 0.80.7 已从 models.json 移除**（CHANGELOG 0.80.7 Breaking Changes，`CHANGELOG.md:737`），替代者是 `sessionAffinityFormat: "openai" | "openai-nosession" | "openrouter"`；`sendSessionIdHeader: false` → `sessionAffinityFormat: "openai-nosession"`。
> 现网 `models.json` 中该字段出现 **29 次，全部为 `true`**（`Mapleluv` openai-responses、`Mapleluv-Main-MSG` anthropic-messages、`Mapleluv-Main` openai-completions）——`true` 即默认行为，等价于可直接删除。

### 2.2 Model 定义（`models[]`）与 `modelOverrides`

| 字段 | 0.85.1 | 插件现状 | 说明 |
|------|--------|----------|------|
| `samplingParams` | `Record<string, unknown>` | **缺失**（`types.ts:59/46`、验证、编辑器） | 0.84.0 新增；逐字合并进 OpenAI 系请求体，键覆盖 pi 自身字段；override 中按 key 合并 |
| `id/name/api/baseUrl/reasoning/thinkingLevelMap/input/contextWindow/maxTokens/cost(+tiers)/headers/compat` | 保留 | 已有 | 语义不变 |

### 2.3 `compat`（0.85.1 schema 按 API 分三组，且**新增字段只对对应 API 生效**）

**OpenAI-compatible（`openai-completions`）** — `model-config.js:66-96`：

- 新增：`supportsFinishReason`、`chatTemplateArgs`、`supportsOpenAIGrammarTools`、`deferredToolsMode: "kimi"`、`sessionAffinityFormat: "openai"|"openai-nosession"|"openrouter"`、`vllmPriority: number`
- 变化：`thinkingFormat` 增加 `"baseten"`（docs：配合 `chatTemplateArgs` 使用）
- 已在插件内：`supportsStore/DeveloperRole/ReasoningEffort/UsageInStreaming`、`maxTokensField`、`requires*`、`chatTemplateKwargs`、`cacheControlFormat`、`openRouterRouting`、`vercelGatewayRouting`、`supportsStrictMode`、`sendSessionAffinityHeaders`、`supportsLongCacheRetention`
- 引擎读取但 **models.json schema 未声明**（靠 extra props 透传，实测探针 A 通过）：`zaiToolStream`、`thinkingTokenBudgetField`、`supportsThinkingTokenBudget`
- 已失效：`sendSessionIdHeader`（pi-ai 0.85.1 已无此字段）

**OpenAI Responses** — `model-config.js:100-106`：

- 新增：`supportsAdditionalTools`、`supportsToolSearch`、`supportsMaxOutputTokens`、`supportsOpenAIGrammarTools`
- 已在插件内：`supportsDeveloperRole`、`sessionAffinityFormat`（新增待补）、`supportsLongCacheRetention`、`supportsStrictMode`

**Anthropic Messages** — `model-config.js:113-118`：

- 新增：`supportsStrictTools`、`supportsMidConvoEffort`（0.84.4，docs/models.md 明确"仅对忠实 Messages 传输的对应 Claude 模型开启"）、`supportsToolReferences`
- 已在插件内：`supportsEagerToolInputStreaming`、`sendSessionAffinityHeaders`、`supportsCacheControlOnTools`、`forceAdaptiveThinking`、`allowEmptySignature`
- 归位错误：`supportsTemperature` 在 0.85.1 只属于 Anthropic 组（`anthropic-messages.js:126/832` 读取；OpenAI 系不再读取），插件当前把它当通用布尔展示

**内置 API 类型（pi-ai `KnownApi`，`types.d.ts:15`）**：`openai-completions`、`mistral-conversations`、`openai-responses`、`azure-openai-responses`、`openai-codex-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-vertex`、`pi-messages`。
插件 `types.ts:126` / `model-editor.ts:48` / `provider-editor.ts:41` 只列了 7 个，缺 `azure-openai-responses`、`openai-codex-responses`、`pi-messages`（`pi-messages` 在 `pi-ai/dist/api/pi-messages.d.ts` 头部注释中明确"可由 models.json 自定义 Provider 使用"）。

### 2.4 内置 Provider 名单

pi-ai `KnownProvider`（0.85.1）比插件 `config-validation.ts:12` 的 `BUILT_IN_PROVIDERS_PI_0_80_6` 多 5 个：

`radius`、`baseten`（0.84.0）、`qwen-token-plan`、`qwen-token-plan-cn`（0.81.0）、`qwen-token-plan-individual`（0.84.1）。

插件用该集合判断"是否内置 Provider"：`config-validation.ts:520-548`（空 Provider 规则、自定义 Provider 必须 baseUrl+api）与 `model-editor.ts:762`（Provider API 前置条件）。名单缺失会把内置 Provider 误判成自定义 Provider，导致编辑器索要 `baseUrl`/`api`、阻断合法保存。

### 2.5 settings.json

0.85.1 仍是 `~/.pi/agent/settings.json` + `.pi/settings.json`，**严格 JSON（`JSON.parse(stripBom(...))`，不支持注释）**、`proper-lockfile` 加锁 + 按修改字段合并写（`dist/core/settings-manager.js:200/376-391`）。
插件只写 `subagents.agentOverrides`（pi-subagents 扩展面），字段语义未变；但见 §5.2/§5.3。

0.81–0.85 新增的其它设置（`defaultTools`、`modelThinkingLevels`、`thinkingBudgets`、`tuiMode`/`fullscreen*`、`transport`、`httpIdleTimeoutMs` 等）不属于本插件职责，无需处理。

---

## 3. 逐文件修改清单

### 3.1 `types.ts`

- `ProviderConfig`（:16）：新增 `oauth?: "radius"`。
- `ModelConfig`（:59）与 `ModelOverrideConfig`（:46）：新增 `samplingParams?: Record<string, unknown>`。
- `CompatConfig`（:94）：补齐 §2.3 三组新增字段；`thinkingFormat` 联合类型加 `"baseten"`；`supportsTemperature` 注释标记为 Anthropic-only。
- `API_TYPES`（:126）：加 `azure-openai-responses`、`openai-codex-responses`、`pi-messages`。
- `THINKING_LEVELS`（:137）已含 `max`，不变。

### 3.2 `config-validation.ts`

- `BUILT_IN_PROVIDERS_PI_0_80_6`（:12）→ 改名（如 `BUILT_IN_PROVIDERS_PI_0_85_1`）并补 5 个 Provider；同步 `DEFAULT_OPTIONS`（:50）与 `model-editor.ts:12` 的 import、`tests/config-validation.test.ts:4/17`。
- `THINKING_FORMATS`（:53）：加 `"baseten"`。
- `BOOLEAN_COMPAT_FIELDS`（:57）：加 `supportsFinishReason`、`supportsOpenAIGrammarTools`、`supportsAdditionalTools`、`supportsToolSearch`、`supportsMaxOutputTokens`、`supportsStrictTools`、`supportsMidConvoEffort`、`supportsToolReferences`；删 `sendSessionIdHeader`。
- `validateCompat`（:294）：新增枚举校验 `deferredToolsMode`（`"kimi"`）、`sessionAffinityFormat`（三值）、数值校验 `vllmPriority`（有限数）、对象校验 `chatTemplateArgs`（复用 `validateChatTemplateKwargs`）。
- `validateProvider`（:412）：校验 `oauth` 只能是 `"radius"`。
- `validateModelLikeFields`（:361）：校验 `samplingParams` 必须为对象（值不限）。
- 现有 `chatTemplateKwargs.$var` 只允许 `thinking.enabled|thinking.effort` —— **修正**：引擎实际支持三个变量（`openai-completions.js:798-803` 解析 `thinking.enabled`/`thinking.budget`，`thinking.effort` 走 `thinkingLevelMap`；`pi-ai` 的 `ChatTemplateKwargValue` 含 `budget`，docs/models.md 也写了三个），只有 models.json 的 TypeBox schema（`ChatTemplateKwargVariableSchema`）漏了 `budget`。因为 union 会把它当额外属性放过（实测探针 C），这类配置可以正常加载并生效，所以插件必须放开 `thinking.budget`，否则会拦住 Pi 能用的配置。

### 3.3 `compat-settings.ts`

- `COMPAT_BOOLEAN_FIELDS`（:5）：同步增删；建议按 API 分组重排（OpenAI / Responses / Anthropic），`supportsTemperature` 标注 Anthropic-only，`sendSessionAffinityHeaders` 标注 OpenAI+Anthropic。
- `THINKING_FORMATS`（:32）：加 `"baseten"`。
- 新增 `COMPAT_STRING_FIELDS`（或导出给 field-editors）：`deferredToolsMode`、`sessionAffinityFormat`；新增数值字段清单 `COMPAT_NUMBER_FIELDS: ["vllmPriority"]`。
- `COMPAT_JSON_OBJECT_FIELDS`（:26）：加 `chatTemplateArgs`。
- 新增迁移助手：`migrateLegacySendSessionIdHeader(compat, api)` —— `true` 删除，`false`（openai-responses）→ `sessionAffinityFormat:"openai-nosession"`。

### 3.4 `field-editors.ts`

- `COMPAT_STRING_FIELDS`（:216）：加 `deferredToolsMode: ["kimi"]`、`sessionAffinityFormat: [...]`。
- `editCompatDraft`（:228）：新增"数值字段"分组（复用 `collectPositiveInteger`/新增有限数收集；`vllmPriority` 可为负、0 合法，需允许有限数），并在检测到 legacy `sendSessionIdHeader` 时提供"迁移/清理"入口；`chatTemplateArgs` 走现有 JSON 对象编辑器。

### 3.5 `model-editor.ts`

- `API_OPTIONS`（:48）：加 3 个 API。
- `OVERRIDE_ALLOWED_KEYS`（:57）：加 `samplingParams`（否则 override 编辑器会把它当"不支持字段"提示清理，见 :898）。
- `buildModelCategories`（:118）：新增"采样参数"（`samplingParams`）open-section 条目 + 编辑器分支（JSON 对象，任意值；清除 = 删除）。
- `buildModelOverrideCategories`（:203）：同样加 `samplingParams`，语义为"按 key 合并"，清除单键 vs 整体清除要与现有 draft 机制一致。
- 若采纳分组 compat，则 model/provider 两处共用 `editCompatDraft` 即可，不必改调用点。

### 3.6 `provider-editor.ts`

- `API_OPTIONS`（:41）：同步加 3 个 API。
- `buildProviderCategories`（:68）"HTTP 与认证"组：新增 `oauth` 字段（枚举 `radius` + 清除）。`oauth` 需要 gateway `baseUrl`（docs/models.md），与现有"自定义 Provider 需要 baseUrl"规则一致，无需放宽。

### 3.7 `subagent-settings.ts`（pi-subagents 面，非 pi 本体）

- `SUBAGENT_THINKING_LEVELS`（:16）：补 `"max"`（0.80.7 起 native xhigh/max；主 `types.ts` 已含 `max`，此处遗漏是内部不一致）。
- `BUILTIN_SUBAGENT_NAMES`（:4）：pi-subagents 0.63.0 的 `src/agents/builtin-names.ts` 为 `advisor, claude-code, claude-code-writer, codex-exec, codex-exec-writer, cursor-agent, cursor-agent-writer, delegate, oracle, researcher, reviewer, scout, worker`；现行硬编码的 `context-builder`、`planner` 已不存在（用户 `D:\Pi\runtime\agent\settings.json` 中这两个 override 目前是死配置）。
- 建议：内置名单改为"内置 + 现有 settings 中已出现的 agent 名"并集，避免名单再次漂移；对外部 CLI agent（codex/claude/cursor）不应提供 `thinking`/`fallbackModels` 等原生 Pi 子代理选项（pi-subagents 文档明确其 runner 契约不支持），UI 需按 agent 类型裁剪可编辑字段。

### 3.8 `package.json`

- `@earendil-works/pi-tui`（:29）从 `dependencies` 固定 `0.79.1` 改为 `peerDependencies: {"*"}`（docs/packages.md:171：Pi 内置这些包，插件不得捆绑；`@earendil-works/pi-coding-agent` 也应声明为 peer）。pi 侧证据同样明确：托管安装按包管理器传入 `--legacy-peer-deps` / `--omit=peer` / `--config.auto-install-peers=false`（`dist/core/package-manager.js:1459-1479`），注释写明“不要安装或求解宿主提供的 @earendil-works/pi-* peer”，因此声明 peer `"*"` 不会拉入重复副本）。
- 证据：pi 的扩展加载器把 `@earendil-works/pi-tui`、`@earendil-works/pi-coding-agent` 别名/hook 到**宿主自带模块**（`dist/core/extensions/loader.js:13/40/84-101`），插件自带副本运行时永远不会被加载；它只影响 `npm test` 的类型/行为，导致"测试通过 ≠ 生产版本通过"。
- 移除 `node_modules/@earendil-works/pi-tui` 本地安装（或保留为 `devDependencies: "0.85.1"` 仅用于测试），并让测试跑在与生产一致的版本上。

### 3.9 文档

- `README.md:105` / `README-CN.md:105`：基线改 0.85.1，补 `samplingParams`、`oauth`、新 compat 字段说明。
- `README.md:74` / `README-CN.md:74`：Model Overrides 允许字段加 `samplingParams`。
- `docs/superpowers/plans/*`、`docs/superpowers/specs/*`：历史计划不要改；新增本文档即可（注意 `tests/release-docs.test.ts` 会校验 README 关键短语与 "1.2.0"，改文案不要删这些锚点）。

### 3.10 测试

- `tests/compat-settings.test.ts:30`：断言列表更新（`sendSessionIdHeader` → 新字段、`baseten`）。
- `tests/config-validation.test.ts:17`：内置 Provider 精确列表更新。
- 新增：`samplingParams` 验证/序列化、`oauth` 校验、新 compat 枚举/数值校验、legacy `sendSessionIdHeader` 迁移、`max` subagent thinking。
- 基线现状：`npm test` = **289 tests / 288 pass / 1 fail**，唯一失败是 `tests/release-docs.test.ts:45` 对 LICENSE 断言 `/^MIT License\n/` 而 Windows 工作区是 CRLF（环境问题，非本次变更引入）。

---

## 4. 已实测的上游校验行为（探针 A–N）

用 `ModelConfig.load()` 校验真实 `models.json` 的变体：

| 探针 | 输入 | 结果 |
| ------ | ------ | ------ |
| A | `compat.thinkingTokenBudgetField: "thinking_budget"`（schema 未声明） | ACCEPT（extra props 透传；`openai-completions.js:632/741` 会读取） |
| B | `compat.vllmPriority: "high"`（类型错） | ACCEPT（OpenAI 组失败，但 Responses/Anthropic 组把它当 extra prop） |
| C | `chatTemplateKwargs: { thinking: { $var: "thinking.budget" } }` | ACCEPT（引擎支持该变量，见 §3.2 修正；schema 只是漏声明） |
| D | `chatTemplateArgs: { thinking: { $var: "thinking.enabled" } }` | ACCEPT |
| E | `models[0].samplingParams = {温度/嵌套任意值}` | ACCEPT |
| F | `provider.oauth = "radius"` | ACCEPT |
| G | `compat.sessionAffinityFormat = "openai-nosession"`（替代 sendSessionIdHeader） | ACCEPT |
| H | `compat.supportsLongCacheRetention = "yes"`（三组共有字段） | **REJECT**（"must be boolean"） |
| I | `compat.thinkingFormat = "bogus"`（仅 OpenAI 组） | ACCEPT |
| J | `compat.supportsDeveloperRole = "yes"`（两组共有） | ACCEPT |
| K | `models[0].reasoning = "yes"` | **REJECT** |
| L | `models[0].cost = "free"` | **REJECT** |
| M/N | 删除/错型 `id` 等单 schema 字段 | **REJECT** |

结论：**pi 0.85.1 的 models.json 校验对 compat 几乎不设防**（compat 是三组 union + 允许额外属性；只有三组都声明且类型冲突的键才会被抓，目前实际上只有 `supportsLongCacheRetention` 一类）。因此**插件的 `config-validation.ts` 才是 compat 字段的真正安全闸门**——新增字段必须同时在插件侧做类型/枚举校验，否则写坏的值会被 pi 静默送进请求体。

---

## 5. 顺带应修的健壮性问题（与 0.85.1 直接相关）

### 5.1 BOM

pi 解析 `models.json`/`settings.json` 前都 `stripBom`（`dist/core/model-config.js`、`dist/core/settings-manager.js:200`）；插件 `config.ts:parseModelsDocument`（jsonc-parser）与 `subagent-settings.ts:readJsonObject`（`JSON.parse`）都不处理 BOM → 带 BOM 的文件在插件内直接报错（pi 自己能加载）。建议两处都加 `stripBom`。

### 5.2 settings.json 并发写

pi 0.85.1 用 `proper-lockfile` 加锁并"读-改-写"合并（`settings-manager.js:376-391`）；插件 `subagent-settings.ts` 原为裸 `fs.writeFileSync`。用户按 `/model` `Ctrl+S` 保存默认模型与插件保存 subagent override 并发时会丢更新。

**已实施**：settings.json 改为「每次重读 + 原子替换 + 内容哈希 CAS 重试」，上限 `SETTINGS_WRITE_ATTEMPTS` 次，超限抛出 `concurrent modifications detected` 并保留并发写入者的字节（测试见 §9.1）。

**未实施（已知残差）**：哈希检查在 `beforeRename` 内、紧邻 `renameSync`，因此“检查通过后、rename 前”落地的并发写仍会被覆盖；要彻底关闭它必须持有 pi 自己的 `proper-lockfile` 锁（本插件不持有），引入 `process-lock.ts` 对 pi 的 settings-manager 无效（它不识别该 IPC 锁），故不引入。代码注释已按此精确表述，不再声称“绝不覆盖”。

### 5.3 pi-tui 版本错位（见 §3.8）

测试用 0.79.1、生产用宿主 0.85.1。已核对 0.85.1 与 0.79.1 的 `Component`/`Focusable`、`Input`（新增可选 `InputOptions`）、`KeybindingsManager`（`matches`/`getKeys`）、`tui.select.*` action id、`fuzzyFilter`/`truncateToWidth`/`visibleWidth`/`Key`/`matchesKey` 均向后兼容，但依赖版本应改为 peer `"*"` 并把本地测试版本对齐 0.85.1。

---

## 6. 无需改动（已核对）

- `pi.on("before_provider_request", (event, ctx) => payload | undefined)`：0.85.1 语义不变（docs/extensions.md:705-720），私有 payload 合并路径有效。
- `ctx.model`（含 `.provider`/`.id`）、`ctx.mode === "tui"`、`ctx.modelRegistry.getAvailable()`（`ModelRegistry` 仍在 `ExtensionContext` 上，`model-registry.d.ts:20/27`）。
- `ctx.ui.custom<T>((tui, theme, keybindings, done) => Component, { overlay: false })`：签名不变（`core/extensions/types.d.ts:117-127`）。
- `pi.registerCommand(name, { description, handler(args, ctx) })`：签名不变（`types.d.ts:891-897`）。
- `models-store.json` 不会遮蔽 `models.json`：组合顺序为 built-in → models.json → extension → `modelOverrides`（`dist/core/provider-composer.js:290-303`），且 `/model` 每次打开会重新加载 models.json（0.82.0 修复）。插件不需要 invalidate 该缓存。
- 全屏 TUI（用户当前 `tuiMode=fullscreen`）：自定义非 overlay 组件仍是 `render(width)` + `handleInput`，无新必需方法（`handleMouse` 可选）。

---

## 7. 建议实施顺序与验证

1. **打包与版本对齐**（§3.8）+ 测试基线修复（CRLF）——先让"测试证据 = 生产版本"。
2. **校验层**（§3.1–3.2）——先保证插件不会再写出 pi 无法使用的值，并同步单测。
3. **编辑器层**（§3.3–3.6）——新字段入口 + legacy `sendSessionIdHeader` 迁移。
4. **Subagent 面**（§3.7）。
5. **文档**（§3.9）+ 新增单测（§3.10）。

验证手段：

- `npm test` / `npm run check`（当前 288/289，修 CRLF 后应全绿）。
- 写一个与 §4 同款的 `ModelConfig.load()` 探针：对插件写出的每个新字段组合断言 `getError() === undefined`。
- 真机手测：`/model-config` → 新增 `samplingParams`/`oauth`/新 compat → 保存 → `/model` 重载确认模型可用；`tuiMode=fullscreen` 下走一遍面板键盘操作（`tui.select.*`）。
- 迁移验证：对现网 `models.json`（29 处 `sendSessionIdHeader: true`）执行一次迁移，确认仅删除键、字节级其他内容不变。

---

## 8. 实施记录（已完成）

### 8.1 已改文件

| 文件 | 改动 |
| ------ | ------ |
| `package.json` / `package-lock.json` | `@earendil-works/pi-tui` 从 `dependencies@0.79.1` 改为 `peerDependencies:"*"` + `devDependencies@0.85.1`；新增 `@earendil-works/pi-coding-agent` peer；本地测试运行时已对齐 0.85.1 |
| `types.ts` | `ProviderConfig.oauth`；`ModelConfig/ModelOverrideConfig.samplingParams`；`CompatConfig` 补 §2.3 全部新字段；`API_TYPES` +3 并新增 `API_TYPE_IDS` 单一来源；新增 `JsonValue`、`OAUTH_PROVIDER_TYPES` |
| `config-validation.ts` | `BUILT_IN_PROVIDERS_PI_0_85_1`（+5 内置 Provider）；`baseten`；新增布尔/枚举/数值/对象校验（含 `supportsExplicitPromptCacheMode`）；`oauth`、`samplingParams` 校验；放开 `$var: thinking.budget` |
| `compat-settings.ts` | 布尔字段按 API 家族重排并标注；新增 `COMPAT_STRING_FIELDS`、`COMPAT_NUMBER_FIELDS`、`chatTemplateArgs`；`sendSessionIdHeader` 迁移计划与执行函数；补 `supportsExplicitPromptCacheMode`（引擎读取、schema 未声明）；为 `sessionAffinityFormat`/`chatTemplateArgs` 标注生效前置条件 |
| `field-editors.ts` | compat 编辑器支持数值字段、`sessionAffinityFormat`/`deferredToolsMode`/`chatTemplateArgs`，并在检测到遗留键时提供预览迁移；拆分为按组小函数 |
| `model-editor.ts` | API 列表改为 `API_TYPE_IDS`；override 白名单加 `samplingParams`；Model/Override 新增 `samplingParams` 编辑入口；兼容性编辑器传入有效 API |
| `provider-editor.ts` | API 列表单一来源；新增 `oauth` 字段与处理；compat/override 编辑器传入 Provider API |
| `model-fields.ts` | `ModelSubtreeKey` 加 `samplingParams`（复用 `saveModelSubtree` 的乐观基线机制） |
| `subagent-settings.ts` | thinking 补 `max`；内置 agent 名单对齐 pi-subagents 0.63.0；新增 `listSubagentAgentNames`/`isExternalCliSubagent`；BOM 剥离；settings.json 改为原子写 + 哈希 CAS 重试（含 `SettingsWriteHooks` 测试缝） |
| `index.ts` | Subagent 列表用“内置 + 已存储 override 名”并集；外部 CLI runner agent 只保留带“忽略”标记的只读行 + 清理动作（不再提供 `设置 model`，见 §10.1） |
| `config.ts` | `parseModelsDocument` 剥离 BOM（与 pi 一致） |
| `README.md` / `README-CN.md` | 基线改 Pi 0.85.1，补 `oauth`/`samplingParams`/新 compat 分组与迁移说明 |
| 测试 | 更新内置 Provider 名单与新旧目录断言、LICENSE 断言改为 CRLF 无关；新增 compat 迁移与新字段正/负例；新增 settings.json BOM/CAS 重试/超限、external-CLI 菜单裁剪、models.json BOM、subagent agent 名单用例 |

### 8.2 验证证据

- `npm test`：**308 tests / 308 pass / 0 fail**（改动前基线为 289 tests / 288 pass / 1 fail，唯一失败是 `release-docs.test.ts` 对 LICENSE 的 CRLF 断言，已改为先归一化换行）。
- `npm run check`：全部根模块 `node --experimental-strip-types --check` 通过。
- 真机探针（`ModelConfig.load()`）：用插件自己的 `serializeModelsDocument` 写出包含 `oauth: "radius"`、`samplingParams`、全部新 compat 字段、`thinkingFormat: "baseten"`、`chatTemplateArgs.$var = thinking.budget` 以及遗留 `sendSessionIdHeader` 的 models.json，pi 0.85.1 返回 `getError() === undefined`，且插件的 JSONC 读取器往返字节一致。
- 本地测试运行时：`node_modules/@earendil-works/pi-tui` 已由 `npm install` 升级到 **0.85.1**，与宿主相同。
- 独立 reviewer（`Mapleluv/deepseek-flash:max`）审查 `7750e95`：结论 `needs-fix`、无 blocker；其结论逐条复核结果见 §9。

### 8.3 有意不做（保留现状，供确认）

- `thinkingTokenBudgetField`、`supportsThinkingTokenBudget`：引擎会读取但 models.json schema 未声明（靠额外属性透传）。本次**未**加入 UI，避免超出报告范围；需要时可作为后续增量。
  （`zaiToolStream` 也属此类，但它在改动前就已存在于 UI，不是本次新增。）
- 版本号仍为 **1.2.0**（本次不是发布动作；`release-docs.test.ts` 对版本与 README 锚点的断言保持通过）。
- Subagent 外部 CLI runner 字段策略（round 2 已修正，见 §10.1）：pi-subagents 不接受任何 Pi 原生子代理选项——`model` 残留会使单 agent 运行被拒绝，`thinking`/`fallbackModels`/`tools` 被丢弃；插件只提供标注过的只读行 + 清理动作，不再提供 `设置 model`。

---

## 9. 独立评审（round 1）与处置

评审对象：`7750e95`（reviewer 子代理，模型 `Mapleluv/deepseek-flash:max`）。结论 `needs-fix`、无 blocker。

### 9.1 已修正

| # | 评审项 | 复核证据 | 处置 |
| --- | ------- | --------- | ------ |
| 1 | 外部 CLI runner 仍提供 `设置 model`，而 pi-subagents 忽略该键 | `src/runs/shared/external-cli-runner.ts` / `codex-exec-adapter.ts` 全文无 `model` 引用；`agents/agent-management.ts:643` 直接拒绝（`does not support Pi-only fields: model`）；`runs/background/async-execution.ts:826-832` 对 step 级 model 抛错；`async-execution.ts:1569` 在单 agent 路径直接拒绝（已由 pi-subagents 自身测试钉住：`test/integration/single-execution.test.ts:1744/1767/1788`） | `index.ts`：外部 runner 菜单删除 `设置 model`，四条只读行改为按行标注：`model` 行“（外部 CLI runner 不支持；残留会使运行被拒绝）”，`thinking`/`fallbackModels`/`tools` 行“（外部 CLI runner 忽略）”；清理动作改为 `清除 model/thinking/fallbackModels（残留会被拒绝）`；README/README-CN 同步 |
| 2 | 新增的 settings.json 安全路径与 external-CLI 裁剪无测试 | `tests/` 中无 BOM/CAS 相关断言 | 新增 `tests/subagent-settings-write.test.ts`（BOM 读写、并发写重放、超限抛出且不落盘）、`tests/subagent-menu.test.ts`（外部 runner 无编辑动作 + 忽略标注；原生 agent 菜单完整）、`tests/config.test.ts` 增 models.json BOM 往返；为此在 `subagent-settings.ts` 增加 `SettingsWriteHooks` 测试缝（与 `atomic-file.ts` 既有测试缝同风格） |
| 3 | 注释夸大了 CAS 保证 | `atomicReplace` 的哈希检查与 `renameSync` 之间存在窗口 | 注释与 §5.2 改为精确表述（检测-重试），并记明未引入 proper-lockfile 的原因 |
| 4 | 漏了 `supportsExplicitPromptCacheMode`（Responses 读取、schema 未声明） | `pi-ai/dist/api/openai-responses.js:60/65/70` 有读取；`dist/core/model-config.js` 无声明 | 加入 `COMPAT_BOOLEAN_FIELDS`/`BOOLEAN_COMPAT_FIELDS` 并补正/负例 |
| 5 | compat 字符串字段顺序在两处重复构造 | `field-editors.ts` 两处 `[COMPAT_THINKING_FORMAT_FIELD, ...COMPAT_STRING_FIELDS]` | 提取 `COMPAT_STRING_FIELD_ORDER` 单一来源 |
| 6 | 无 API 时的迁移提示不准确 | 原提示断言“该 API 不读取旧字段”，但未知 API ≠ 不读取 | 改为“无法确定 API；该键自 0.80.7 起不再被任何 API 读取，删除会丢失 `openai-nosession` 意图” |
| 7 | 两个 compat 字段的生效前置条件未在 UI 暴露 | `openai-completions.js:557`（需 `sendSessionAffinityHeaders: true`）、`:666-670`（需 `thinkingFormat: baseten`） | 两项 label 补前置条件 |
| 8 | `tests/compat-settings.test.ts` 对 `thinkingFormat` 的断言是同义反复 | 常量即由 `[...THINKING_FORMATS]` 构造 | 改为与字面量列表比对（含 `baseten`） |

### 9.2 未采纳（附理由）

- `thinkingTokenBudgetField`、`supportsThinkingTokenBudget`：超出本次范围，已在 §8.3 记录为后续增量。
- 为内置 Provider 增加 `api` 目录回退表（评审第 6 项的完整版）：会让插件维护一份随 pi 版本漂移的 provider→api 映射；当前行为（删除已失效键 + 明确提示）不会写出错误配置，故不做。
- 用 `process-lock.ts` 包裹 settings.json 读改写：pi 的 settings-manager 不识别该 IPC 锁，无法消除与 pi 的竞态，只会增加持锁复杂度（并违反“不在持锁时等待输入”的既有不变量）。
- 将 `dispatchCompatFieldEdit` 改为表驱动：纯风格收益，改动面大于收益；本次只消除顺序重复（§9.1-5）。
- 评审期间外部 auto-format（80 列折行 + 补尾逗号）重写了 17 个文件（+4970/−1523，纯格式）：已整体 `git checkout` 丢弃，不让与仓库风格不符的无关变更进入提交。

---

## 10. 独立评审（round 2，对象 `304c3bd`）与处置

结论：must-fix 2（测试空缺）**确认为已解决**；must-fix 1 **重新打开**——我 round 1 的“外部 runner 忽略 model”结论不完整，实际是**运行被拒绝**。另发现 1 个 P2（迁移提示措辞）。

### 10.1 重新打开的 must-fix 1（已修正）

完整调用链（已逐行复核）：

1. `agents/agents.ts:1383-1386`：settings 里的 `agentOverrides.<name>.model` 会被应用，并 **删除 `modelSource`**。
2. `runs/foreground/subagent-executor.ts:3212-3226`：`externalRunnerWithoutExplicitModel` 因 `modelSource` 被删而变为 false → `modelOverride = a.model`。
3. `runs/background/async-execution.ts:1569`：单 agent 路径在 `params.modelOverride !== undefined` 时直接返回错误 `Agent '<name>' uses runner.type='external-cli' and does not support: model override.`
4. pi-subagents 自身测试钉住该行为：`test/integration/single-execution.test.ts:1744`（调用级）、`:1767`（与继承默认值不同）、`:1788`（无 provenance）、`test/unit/async-execution.test.ts:191-198`（step 级）。

区别对待（同源复核）：`thinking`（`async-execution.ts:1571` 只检查 `params.thinkingOverride`，agent 级 thinking 不进入该参数）、`fallbackModels`（`preflight.ts:336` 直接置空）、`tools`（外部 CLI runner 不执行 Pi 工具）均是被**丢弃**，不会导致拒绝。

处置：`index.ts` 把 `model` 行标注为“（外部 CLI runner 不支持；残留会使运行被拒绝）”，其余三行保留“（外部 CLI runner 忽略）”；外部 runner 的清理动作改为 `清除 model/thinking/fallbackModels（残留会被拒绝）`（handler 仍按前缀匹配，行为不变）；README/README-CN、`tests/subagent-menu.test.ts` 同步钉住新措辞。

### 10.2 P2：已知非 OpenAI API 的迁移提示自相矛盾（已修正）

`compat-settings.ts` 原实现对“已知但非 OpenAI 系”的 API（如 `anthropic-messages`）也输出“无法确定该 Provider/Model 的 API（anthropic-messages）”。现拆为三支：OpenAI 两族 → 映射为 `openai-nosession`；**已知** API（`API_TYPE_IDS`）→ “该 API（X）不读取该字段；直接删除旧字段”；未设置/未知 → 保留“无法确定…”并说明会丢失 `openai-nosession` 意图。另已用 `rg` 复核：`azure-openai-responses.js`、`openai-codex-responses.js`、`pi-messages.js` 均无 `sessionAffinity` 引用，故“只有 `openai-completions`/`openai-responses` 读取该字段”的判定成立。测试：`tests/compat-settings.test.ts` 新增已知 API 与未知 API 的措辞断言，并验证区分不会误判。

### 10.3 round 2 其余结论（无需动作）

- 测试空缺项：评审确认新测试驱动的是生产函数（`updateSubagentAgentOverride`/`editSubagentAgentOverride`/`readModelsConfig`），断言可失败，`SettingsWriteHooks` 为可选参数（生产调用方均传 3 参），不会影响生产行为。
- CAS 注释、`supportsExplicitPromptCacheMode`、compat label 前置条件、`COMPAT_STRING_FIELD_ORDER`、`thinkingFormat` 断言五项均被确认。

---

## 11. 独立评审（round 3，对象 `ac69309`）与处置

结论：**`converged`**（无 must-fix）。三条 report-only P2 已全部处理（措辞/交叉引用/补测试，无行为变更）：

- P2-1：`model` 行的提示原为“残留会使运行被拒绝”，未限定路径。已复核 `async-execution.ts:900/909-910`（chain/task 路径下 agent 级 model/thinking 直接置 `undefined`，只有 step 级 model 会在 `:826` 被拒），改为“残留会使**单 agent** 运行被拒绝”；测试与 README 同步。
- P2-2：文档交叉引用修正（`§9.2`/`§9.3` → `§9.1`/`§10.1`）。
- P2-3：补上清理动作的端到端派发测试（`tests/subagent-menu.test.ts`：脚本选中 `清除 model/thinking/fallbackModels（残留会被拒绝）` + 确认，断言存储的 `model` 键被移除）；为此给共享的 scripted UI 助手增加 `confirms` 支持。若 `index.ts` 的前缀派发失效，该测试会因存储未变而失败。
