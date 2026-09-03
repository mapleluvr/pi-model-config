# Pi Model Config

> 面向 Pi 原生模型系统和 `nicobailon/pi-subagents` 的交互式配置插件。

[![pi-package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Pi Model Config 1.2.0 提供 `/model-config`，用于按字段管理原生 Provider、Model、私有请求 Payload 和 Subagent overrides。插件不会动态注册 Provider；`models.json` 加载和 ModelRegistry 刷新仍由 Pi 负责。

English documentation: [README.md](README.md)

## 安装

从本地 checkout 安装：

```bash
pi install -l /path/to/pi-model-config
```

也可以手动安装到用户或项目 extension 目录：

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi-model-config ~/.pi/agent/extensions/model-config

mkdir -p .pi/extensions
cp -r pi-model-config .pi/extensions/model-config
```

安装后重新加载 Pi。配置命令只支持交互式 TUI；在非 TUI 模式调用 `/model-config` 会在读取或修改模型配置之前停止。

## 使用

运行：

```text
/model-config
```

主菜单包含 Provider 和 Model 配置、行为保持不变的 Subagent 配置、事务诊断与恢复，以及使用提示。修改模型后关闭并重新打开 Pi 的 `/model` selector，让 Pi 重新读取 `models.json`。

## 按字段双栏编辑器

已有 Provider 和 Model 会直接打开按字段组织的 two-pane 双栏面板。终端宽度达到 88 列时，左侧显示分类，右侧显示字段；低于 88 列的窄屏 narrow 模式使用前后两个全宽页面显示相同分类和字段。

操作方式：

- 宽屏：`Tab`、`Left`、`Right` 切换双栏焦点；配置的上下移动绑定选择条目；`Enter` 打开分类或字段。
- 窄屏：`Enter` 打开分类；`Left` 或配置的 cancel 绑定返回分类；在分类页 cancel 关闭面板。
- 两种模式：`/` 搜索全部已暴露字段；取消搜索会恢复原分类、字段、焦点和滚动位置。

创建流程仍是最小向导。Provider 只询问 Provider ID、Base URL、API type；Model 只询问 Model ID 并使用 Pi-compatible 默认值。创建完成后会在 General 分类打开面板。

对于自定义非内置 Provider，添加 Model 或启动端点发现之前，必须先在 Provider 面板设置 Provider 级 `api`。内置 Provider 不受此限制。

### 保存语义

简单字段在确认有效值后立即保存。取消不会修改存储；必填字段拒绝空值；可选字段提供明确的清除或 inherited/default 操作。

嵌套值使用单一本地草稿 draft，并提供 `Save and return` 与 `Discard changes`。Headers、Model Overrides、Thinking Level Map、包含 tiers 的 Cost、Compat 和私有 Payload 都遵循此规则。保存嵌套草稿时会比较打开时的完整子树 baseline；若并发修改了同一子树，保存会被阻止，不会覆盖外部更改。

每次原生配置写入都会重新读取当前文档，只更新受管理字段，验证完整候选，并保留未编辑字段和未知字段。

## Provider 字段

| 分类 | 字段与操作 |
|------|------------|
| General | Provider ID、显示名称、API Base URL、API type |
| HTTP and authentication | API Key、Auth Header、Headers |
| Models | Manage Models、Fetch Models from endpoint、Model Overrides |
| Compatibility | Compat |
| Actions | Copy Provider、Delete Provider |

修改 Provider ID 会执行带事务日志的 rename。Model Overrides 只允许文档化的 override 子集：作为 map key 的 Model ID、`name`、`reasoning`、`thinkingLevelMap`、`input`、含可选价格和 `tiers` 的部分 `cost`、`contextWindow`、`maxTokens`、`headers`、`compat`。它不会引入 `id`、`api`、`baseUrl` 或私有 Payload 字段。已存储的不支持路径会保留，只有在预览并明确确认清理后才会删除。

## Model 字段

| 分类 | 字段与操作 |
|------|------------|
| General | Model ID、显示名称 |
| Endpoint overrides | API type、API Base URL、Headers |
| Capabilities and limits | Reasoning、input types、Context Window、Maximum Output Tokens |
| Thinking | `thinkingLevelMap`，覆盖 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 和映射值 `max` |
| Cost | Input、Output、Cache Read、Cache Write、完整 `cost.tiers` |
| Compatibility | Compat |
| Request parameters | 私有 Payload |
| Actions | Copy Model、Delete Model |

`false` 和 `0` 会按字面显示。缺失值根据字段语义显示 inherited 或 not set。API 密钥字面值会被遮罩，也不会预填到输入框。替换密钥时会先提示 Pi 原生输入在输入期间可见，然后打开空输入框。

## 端点发现

每个 Provider 都会始终显示 `Fetch Models from endpoint`，创建时不会自动执行。发现流程尝试受支持的 `{baseUrl}/models` 和 `{baseUrl}/v1/models`，规范化有效 ID，按端点顺序去重，并在选择模式前显示经过清理的来源和数量摘要。

预览提供：

- `Merge`：保留全部现有 Model 对象，只追加新的 ID。
- `Replace`：要求第二次确认，替换列表，并删除已移除 Model 对应的私有 identity。
- `Cancel`：不写入任何文件。

Merge 和 Replace 都会预览新增 identity 与私有 identity 冲突。复用或替换冲突数据需要明确确认；提交前会在共享 coordinator 下重新验证当前文件。

## 原生与私有数据

Pi Model Config 按 Pi 0.80.6 读取 JSONC `models.json`，支持注释和尾逗号。成功保存原生配置时写出规范 JSON。空白、损坏或不满足 schema 的原生配置不会被替换。

私有请求值保存在 `~/.pi/agent/model-config-payloads.json`，或 `<PI_CODING_AGENT_DIR>/model-config-payloads.json`。每个 key 是精确 `[provider, model-id]` 二元 tuple 的 JSON 编码，因此 ID 中的斜杠不会产生歧义。`before_provider_request` 只把当前所选 Model 的对象浅合并到请求中，其他 Model 不受影响。

Payload 与 API 密钥属于敏感数据。诊断、恢复预览、action result、错误、日志和测试输出都不包含这些值。私有存储和事务快照使用私有文件权限。有效旧 `extraPayload` rows 可通过确认后的编辑操作迁移；损坏 rows 必须经过明确的丢弃预览。

## IPC 锁与事务恢复

全部模型和私有 Payload 修改都使用 OS-owned IPC 锁：Windows named pipe、Linux abstract Unix socket，或 macOS loopback identity handshake。owner 退出或崩溃后 endpoint 由操作系统自动释放。系统没有 lock file、stale-owner 删除、force unlock，也不会在持有锁时等待人工输入。

跨文件修改使用 `model-config-transaction.json` 事务日志 journal。Coordinator 在每次写入前确认同一 live endpoint，并通过 atomic replacement 依次处理 journal、原生候选、私有候选和 journal 删除。请求期 Payload 解析使用稳定快照；无法获得一致视图时会 fail closed，不会混合事务两侧。

诊断可以自动完成无歧义恢复。需要选择时采用 two-phase 两阶段流程：在新 IPC 锁下检查并记录快照，释放锁后显示只有非敏感信息以及 `Cancel`、`Retry` 的预览，再重新获取锁；只有 exact hash 和 parse state 仍一致时才应用。Busy、endpoint collision、unsupported adapter、malformed journal 和 blocked native state 都只显示通用非敏感诊断。处理 mismatched journal 时恢复不会覆盖原生配置。

## Subagent 配置

1.2.0 不改变 Subagent UI 和行为。插件继续编辑 builtin `context-builder`、`delegate`、`oracle`、`planner`、`researcher`、`reviewer`、`scout`、`worker` 对应的 `subagents.agentOverrides`。

每个 override 可配置 `model`、`thinking`（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）、有序 `fallbackModels` 和 `tools`。Tools 支持 agent 默认策略、可搜索 allowlist、母 Agent 当前 active tools、手动 MCP 或 path-like tool ID，以及用 `false` 禁用全部工具。选择 `subagent` 工具仍会要求确认，因为它允许 nested fanout。

项目设置位于 `<project>/.pi/settings.json`，用户设置位于 `~/.pi/agent/settings.json`。同步操作只复制完整 `subagents.agentOverrides` 子树，并保留其他 settings 字段。

## 数据文件

| 数据 | 路径 |
|------|------|
| 原生 Providers 和 Models | `~/.pi/agent/models.json` |
| 私有 Model Payload | `~/.pi/agent/model-config-payloads.json` |
| 需要恢复时存在的事务日志 | `~/.pi/agent/model-config-transaction.json` |
| 用户 Subagent overrides | `~/.pi/agent/settings.json` |
| 项目 Subagent overrides | `<project>/.pi/settings.json` |

设置 `PI_CODING_AGENT_DIR` 后，前三个路径使用该目录。

## Package tree

```text
pi-model-config/
|-- index.ts
|-- atomic-file.ts
|-- process-lock.ts
|-- config.ts
|-- config-validation.ts
|-- config-actions.ts
|-- payload-config.ts
|-- payload-coordinator.ts
|-- endpoint-models.ts
|-- settings-panel.ts
|-- provider-editor.ts
|-- model-editor.ts
|-- field-editors.ts
|-- model-fields.ts
|-- compat-settings.ts
|-- own-keys.ts
|-- searchable-select.ts
|-- searchable-multi-select.ts
|-- subagent-settings.ts
|-- subagent-ui.ts
|-- tool-options.ts
|-- types.ts
|-- README.md
|-- README-CN.md
|-- LICENSE
`-- package.json
```

发布包只包含根目录 runtime TypeScript、双语文档、LICENSE 和 package metadata。测试、`.pi-subagents`、journal、临时 agent data 和生成的 archive 都被排除。

## 开发

```bash
npm test
npm run check
npm pack --dry-run --json | node --experimental-strip-types tests/fixtures/assert-package.ts
```

## 许可

MIT，详见 [LICENSE](LICENSE)。
