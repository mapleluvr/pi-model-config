# Pi 1.4.0 配置面与 pi-model-config 基线调查

> 调研日期：2026-11-01。结论针对 `pi-model-config@1.2.2`、提交 `03915c2`，以及本机安装的 `@earendil-works/pi-coding-agent@1.4.0` 和 `@earendil-works/pi-ai@1.4.0`。这是配置面和选定运行路径的调查，不是全部 Provider、扩展接口或远程服务的兼容认证。

## 基线结论

**基线需要一次小范围兼容更新，但没有证据表明普通聊天需要紧急升级或迁移。** 在 `03915c2` 中，Pi 1.4.0 对 `models.json` 新识别的字段比插件校验更严格；插件尚未提供两个分类器图片兼容选项的编辑入口。合法的新选项可被保留并由 Pi 使用。下文的基线现象保留当时结果，不代表后续工作区行为。

用户报告其 Pi 1.4.0 正常使用；本调查没有读取用户实际 `models.json`、凭据或其他私有配置，因此不能推断这些配置是否包含下述值，也不建议为了此版本改写现有文件。

## 一手证据与复跑

- Pi 1.1.0 基线：仓库内 `docs/research/upstream-1.1.0/coding-agent/package/dist/core/model-config.js` 和 `provider-composer.js`。
- Pi 1.4.0：本机 `D:/Pi/runtime/agent/install/releases/1.4.0/node_modules/@earendil-works/` 中的 `pi-coding-agent/dist/core/{model-config,provider-composer}.js`、`pi-ai/dist/providers/{compat-schema,model-schema}.js` 和 `pi-ai/dist/api/system-one-shared.js`。
- 上游文档：同版本 `pi-coding-agent/docs/models.md`、`docs/models-configuration.md` 的 System One compatibility 段。
- 插件：`config-validation.ts`、`config.ts`、`compat-settings.ts`、`field-editors.ts`、`types.ts`、`index.ts`。
- 探针：`docs/research/pi-1.4.0-probes.mjs`。运行：

  ```powershell
  node --experimental-strip-types docs/research/pi-1.4.0-probes.mjs `
    'D:/Pi/runtime/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent' `
    'D:/Pi/runtime/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-ai'
  ```

  脚本检查包版本；1.1.0 快照缺失本地依赖时，仅把 `typebox` 和 `cross-spawn` 解析到版本号与快照依赖声明**精确相同**的已安装副本。所有配置和凭据均为隔离目录内的合成数据，清除继承的认证环境；SDK 请求与分类器传输均被进程内拦截，不向远程服务发送请求。探针现已更新为断言当前工作区行为；下方表格记录修复前的 `03915c2` 基线。

## 1. Schema 收紧与校验缺口

Pi 1.1.0 的 `compat` 是允许附加属性的三分支 union，许多错误类型通过其他分支绕过校验；Pi 1.4.0 改为合并各 API 兼容属性的单个 schema。它仍允许未知附加属性，但现在会检查声明过的属性。Pi 1.4.0 还要求 `contextWindow`、`maxTokens` 大于 0，插件此前已实施更严格的正整数检查。

使用真实的两版 `ModelConfig.load()`、插件校验与写入路径得到：

| 配置样例 | Pi 1.1.0 | Pi 1.4.0 | 基线插件 | 基线影响 |
|---|---:|---:|---:|---|
| `compat.imageInput: "invalid"` | 接受 | 拒绝 | 接受 | Pi 1.4.0 已将其声明为枚举，插件没有校验 |
| `compat.sendImageOptInHeader: "false"` | 接受 | 拒绝 | 接受 | 应为布尔值，不能使用字符串 |
| 顶层 `$schema: 42` | 接受 | 拒绝 | 接受 | 1.4.0 声明该元数据为字符串 |
| `compat.supportsMaxOutputTokens: "false"` | 接受 | 拒绝 | 拒绝 | 插件已有保护 |
| `contextWindow: 0` | 接受 | 拒绝 | 拒绝 | 插件已有保护 |

对每个前三行样例，探针还从合成文件调用插件真实的读取、无关字段修改和 `writeModelsConfig()`：插件成功写入，但 Pi 1.4.0 仍拒绝整个文件。`ModelRuntime` 实测此时该文件中的其他自定义 Provider/模型也不会加载，内置模型目录仍存在。

**触发条件很重要**：基线界面不提供上述两个新分类器字段或 `$schema` 的直接编辑，因此这不是“普通操作会自行生成坏值”的证据；复现依赖外部或手工提供不合法值后，再由插件读取/保存。用户当前配置是否如此未检查。

另对 Pi 1.4.0 Provider 级 `compat` 的 42 个已声明字段，每个尝试 `null`、`false`、`0`、`"bogus"`、`[]`、`{}`，共 252 个合成输入：此有限集合中只有 `imageInput` 和 `sendImageOptInHeader` 出现“插件接受、Pi 拒绝”；没有出现“Pi 接受、插件拒绝”。该矩阵不覆盖所有值、嵌套结构或其他配置位置，不能当作完整等价性证明。

## 2. 分类器图片的 Provider 级覆盖

1.4.0 的 `provider-composer.js` 开始把 Provider 级 `compat` 应用于已注册的 classifier 模型；1.1.0 只将该覆盖应用于 chat 模型。System One 使用：

- `imageInput`: `"assets" | "images" | "state-image-urls"`；选择对应服务的图片请求格式。
- `sendImageOptInHeader`: boolean；控制带图请求是否发送 `TypeSafe-Danger-Zone-Images: true`。

两项不存在时沿用 Pi 的模型/服务检测和默认值。该配置作用于 **Provider 级**的已注册分类器模型；`models` 和 `modelOverrides` 条目仍是 chat 配置，不能靠把 classifier API 加进聊天模型下拉框来注册自定义分类器。

探针使用 Pi 1.4.0 的 TypeSafe provider、真实 composer 和真实 System One 请求构造器，合成图片并在发送前拦截：

| Provider 级配置 | 请求构造结果 |
|---|---|
| 未覆盖 | 包含 `assets`，发送图片 opt-in 头 |
| `imageInput: "state-image-urls"`、`sendImageOptInHeader: false` | 图片放入 state 的 `image_url`，无 opt-in 头 |

这是请求构造证据，不证明任何远程服务实际支持该格式。基线插件的 Provider Compat 编辑器不展示这两个字段；对已存在的合法值，脚本化调用真实编辑器并经真实写入器保存，观察到两项均被保留，Pi 1.4.0 可加载。该检查不等于一次交互式终端验收。

## 3. 已验证的非缺口和边界

- 基线插件内置 Provider ID 与 1.4.0 实际注册的 **42 个 ID 完全一致**；基线 chat API 列表未发现须因本次差异新增的项。
- 基线插件已校验 `supportsExplicitPromptCacheMode`、`supportsAdditionalTools` 等字段，以及 `chatTemplate*` 的 `thinking.budget`；1.4.0 的 schema 现在显式声明了这些运行时支持项。`config-validation.ts`、`compat-settings.ts` 有将部分字段描述为“上游 schema 未声明”的历史注释，应在适配时重新核对。
- 在隔离 SDK 中，通过 Pi 1.4.0 的真实扩展加载器加载本仓库 `index.ts`，以合成 Provider 启动真实 agent turn；`before_provider_request` 将合成额外字段和 `temperature` 放入最终请求体，随后由进程内模拟 SSE 响应完成。此结果证明所测宿主请求路径，不证明真实上游网络、认证或模型能力。
- 基线仓库日常测试依赖 `pi-tui@0.85.1`，而实际宿主加载器将该包别名解析到宿主 `pi-tui@1.4.0`。在隔离副本中将 TUI 依赖指向已安装的 1.4.0 后，完整测试 **350/350 通过**；此结果不替代实际交互式 TUI 测试。
- `before_agent_start` 等其他扩展类型存在变化，但插件注册的事件是 `before_provider_request`；本次没有发现必须据此改写插件事件处理的证据。

## 4. 基线阶段的独立核验与最小建议

独立 Reviewer 复跑了隔离探针并核查相关源码，确认上述校验缺口与过时注释。其“旧版路径没有回归”“没有剩余风险”的概括超出本次探针覆盖，不作为结论；具体验证边界见上文。

1. 插件校验层补充 `compat.imageInput` 枚举、`compat.sendImageOptInHeader` 严格布尔值和顶层可选 `$schema` 字符串校验；覆盖 Provider、model、override 的实际 schema 位置及无关未知字段保留。
2. 如需在界面配置分类器图片协议，仅在 **Provider Compat** 明确暴露两项，并能恢复为未设置；不新增 classifier 类型的 `models.json` 聊天模型，不猜测或自动迁移既有值。
3. 增加与 1.4.0 实际 loader、写入器和请求构造路径对应的回归测试，覆盖目标版本的宿主 TUI 而非仅依赖本地 0.85.1，并清理过时注释。基线阶段还建议保留旧版测试；现行规则要求默认测试依赖跟随目标 Pi 版本，旧版覆盖可按需另设矩阵，见 `AGENTS.md`。

不建议因 Pi 版本号变化进行大规模重构、批量重写现有 `models.json`，或宣称未经验证的 Provider 全面兼容。

## 后续适配与验证

基线调查之后，插件已加入上述三项校验和 Provider 级编辑入口，测试依赖与锁文件对齐目标 Pi 1.4.0。以后跟进新的 Pi 发行版本时，按 `AGENTS.md` 同步更新并验证对应测试依赖；历史基线不随之改写。

`tests/provider-editor.test.ts` 通过真实编辑、写入、Pi 1.4.0 配置加载和请求构造覆盖三种图片格式，其中 `assets` 是清除设置后的 TypeSafe 默认值；传输在进程内拦截。主会话运行了完整测试、语法检查及宿主隔离探针。独立 Reviewer 核对了实现和上游源码，未发现具体阻断问题，但未自行运行 Git diff、完整测试或宿主探针。这些结果不等于远程服务或交互式 TUI 验收。
