# 单模型官方元数据搜索

实现与验证日期：2026-11-06。历史接口调查保留在 [model cards 调研](pi-dev-model-cards-research.md)；本文记录本次功能及验证边界。

## 使用路径与写回契约

`/model-config → 管理 Providers → 编辑 Provider → 管理 Models → 编辑 Model → 操作 → 搜索模型元数据`。

打开后，以目标 Model ID 预填 query，只对官方 model ID 做 fuzzy search；名称和 Provider 标签不参与匹配。Azure、OpenAI、Amazon Bedrock 等来源的同款模型各自保留为可选条目，不自动匹配或自动应用。修改 query 只在已下载目录中筛选。

选择条目后，完整显示来源、目标、API 差异和字段旧值/新值，支持上下滚动及 PgUp/PgDn。按 Enter 执行，Esc 返回。价格单位是 USD / 百万 token。

覆盖集合：`name`、`reasoning`、`input`、`contextWindow`、`maxTokens`、`cost`（含 tiers）、`thinkingLevelMap`、`inputLimits`、`promptCache`、`samplingParams`、`samplingParamsByThinkingLevel`、`compat`。嵌套对象整体替换，来源缺省的集合内字段从模型配置清除；这可能恢复 Provider/宿主的继承行为，不代表有效值为零或 false。

保留目标 Provider、Model ID、API、Base URL、认证、Headers、未知本地字段，以及私有 Payload 的值。只操作独立 `models[]` 条目，本次未给 `modelOverrides` 增加搜索入口。官方目录不能证明代理端点的真实价格、协议或能力。

写回沿用 `ModelConfigActions.patchModel()`：提交前重新读取配置、按元数据字段 baseline 检查冲突、验证完整候选并经事务层保存。预览期间的元数据冲突会阻止覆盖；与元数据无关的外部改动会保留。现有事务层可能把原生或私有配置排版规范化；保持 Payload 值不变不等于已确认保存后文件字节不变。取消则不写文件。

## 网络与结构检查

每次显式打开搜索仅请求一次 `https://pi.dev/api/models?pi-version=<宿主 VERSION>`，无 Provider 凭据。该入口使用 legacy 聊天表示，不传 `types`。15 秒超时，8 MiB 响应上限（同时检查 Content-Length 和实际流量）；HTTP、JSON、结构或空目录错误会返回编辑器。

条目按模型配置白名单投影，身份需与所在 Provider/ID 一致，通过本仓配置校验后才可选择。不会把目录中的连接字段、Headers 或未知扩展字段导入。当前版本没有持久化目录缓存、离线模板回退或按键触发的网络请求。

## 验证结果

- `npm test`：382 项通过。包括 ID-only 模糊搜索、Provider 候选区分、初始 query、完整预览与窄宽终端、取消、网络失败、无变化、非法目录、响应体上限、元数据冲突和无关字段并发修改。
- `npm run check`、`git diff --check`、npm 打包内容 allowlist：通过；新增 runtime 模块会包含在发布包，探针和测试不会。
- `model-metadata.ts`、`model-metadata-preview.ts`、`searchable-select.ts` 的额外严格 TypeScript 检查：通过。全仓严格 TypeScript 检查并非本仓 npm check 的内容，仍有现存类型错误，未声称全仓通过。
- [宿主探针](research/pi-dev-model-cards/editor-probe.mjs)：分别使用项目锁定的 Pi 1.4.0 和本机 Pi 1.5.0 扩展加载器成功加载 `index.ts`，调用实际注册的 `/model-config` 命令，以生产选择器和预览组件完成取消与确认两条路径。每个宿主各访问官方目录两次，请求版本分别为 1.4.0 和 1.5.0；看到 Azure、OpenAI、Amazon Bedrock 候选，选择 `openai/gpt-6-astra` 应用到别名 `gpt6-astra`，核对目标身份/连接、其他模型与私有 Payload 值。取消时同时核对两文件字节不变。

宿主探针只使用项目忽略目录 `.worktrees/model-metadata-probe/` 下的合成配置并在结束时删除，不读取用户配置，不调用模型。它驱动实际组件的按键输入和渲染字符串，未覆盖桌面终端外观或真实模型请求能力。独立 reviewer 按用户要求未启用。

测试依赖默认目标仍为 **Pi 1.4.0**，未改变锁文件或 peer 范围；1.5.0 只完成上述功能路径的局部验证，不代表完成 1.5.0 适配。

复跑默认目标宿主路径：

```powershell
node docs/research/pi-dev-model-cards/editor-probe.mjs node_modules/@earendil-works/pi-coding-agent
```

也可把最后一个参数换成另一个已安装 Pi 的 coding-agent 包目录。探针依赖当次官方目录仍含所选示例；目录变动会使断言失败，不会改用别的模型继续通过。
