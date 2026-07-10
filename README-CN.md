# Pi Model Config

> 面向原生 Pi 模型系统和 `nicobailon/pi-subagents` 的交互式配置插件。

[![pi-package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![author](https://img.shields.io/badge/developed%20with-DeepSeek%20V4%20Pro-orange)](https://deepseek.com)

Pi Model Config 提供 `/model-config` 命令，用交互式终端 UI 管理模型 Provider、Model 定义、Payload 参数、兼容性设置，以及 Subagent overrides。

English documentation: [README.md](README.md)

## 功能

### Pi 模型配置

- 管理 Provider：创建、编辑、复制、删除自定义模型 Provider。
- 自动发现模型：从 OpenAI-compatible `/models` 端点导入模型 ID。
- 管理 Model：编辑 model ID、显示名称、输入模式、reasoning 支持、context window、max output tokens 和价格字段。
- 管理兼容性设置：为 Provider 或 Model 设置 Pi 兼容性选项，支持 default、true、false 三态。
- 管理 payload 参数：为单个模型向私有请求 payload 对象添加 string、boolean、JSON 值。

### Subagent 配置

- 在同一个 `/model-config` UI 中配置内置 `pi-subagents` agents。
- 设置 `model`、`thinking`、`fallbackModels` overrides。
- 使用可搜索 allowlist 编辑器配置 `tools` overrides。
- 从母 Agent 当前 active tools 中选择可授权工具。
- 使用 Pi 工具元数据展示可用工具描述。
- 通过手动输入添加 `mcp:server/tool` 形式的 MCP direct tools 和 path-like extension tools。
- 在项目 settings 和用户 settings 之间同步 Subagent overrides。

### 终端交互体验

- 使用 bounded selector 搜索长模型列表。
- 使用 bounded multi-select 搜索和勾选长工具列表。
- 长菜单保持在插件 UI 内部滚动，减少对 terminal scrollback 的依赖。

## 安装

从本地 checkout 安装：

```bash
pi install -l /path/to/pi-model-config
```

也可以手动安装：

```bash
# 用户级 extension
mkdir -p ~/.pi/agent/extensions
cp -r pi-model-config ~/.pi/agent/extensions/model-config

# 项目级 extension
mkdir -p .pi/extensions
cp -r pi-model-config .pi/extensions/model-config
```

安装后重新加载 Pi，让 extension 生效。

## 使用

在 Pi 中运行：

```text
/model-config
```

主菜单包含这些区域：

1. `管理 Providers`：管理 Pi 模型 Provider 和 Model 定义。
2. `Subagent 配置`：管理 `pi-subagents` overrides。
3. 诊断当前 `models.json` 文件。

## Pi 0.80.6 兼容性

v1.1.0 支持 `thinkingLevelMap.max`、完整的 `cost.tiers` 和 Pi 当前兼容性选项。`models.json` 使用 JSONC 读取，因此允许注释和尾逗号；只有成功解析后才会写回规范 JSON。原生配置损坏时插件会停止保存，不会用空配置覆盖文件。

Pi 本体负责 Provider 注册和 ModelRegistry 刷新。保存后关闭并重新打开 `/model` 即可刷新选择器。

## Pi 模型工作流

1. 创建 Provider，填写 provider ID、base URL、API 类型和 API key 设置。
2. 从 OpenAI-compatible `/models` 端点导入 model IDs，或手动添加 models。
3. 编辑每个 Model 的 context window、max output tokens、reasoning flag、input modes 和价格字段。
4. 在模型需要额外 API 请求体字段时添加 payload 参数。
5. 保存后重新打开 Pi 的 `/model` selector，让 Pi 重新读取更新后的 `models.json`。

## 请求 Payload 参数

额外请求体参数不再写入 `models.json`。插件把它们按精确 `provider/model-id` 键保存在 `~/.pi/agent/model-config-payloads.json`（或 `<PI_CODING_AGENT_DIR>/model-config-payloads.json`）中，并在 `before_provider_request` 对当前模型的最终请求体做浅合并。其他模型不会受到影响，插件不会记录 payload 值。

string、boolean 和 JSON 值都会作为输入写入一个私有 JSON 对象；JSON 值会在保存前解析。有效的旧 `extraPayload` 内容会在对应模型下次保存时迁移；格式损坏的内容会在成功保存后删除。

## Subagent 配置

Subagent 配置写入 Pi settings 的 `subagents.agentOverrides`。
`model-config` 写入这些 overrides，`pi-subagents` 在运行 subagents 时应用它们。

示例：

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "Mapleluv/gpt-5.5",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"],
        "tools": ["read", "bash"]
      }
    }
  }
}
```

### Settings 作用域

| 菜单入口 | Settings 文件 | 作用域 |
|----------|---------------|--------|
| 编辑本项目配置 | `<project>/.pi/settings.json` | 当前项目 |
| 编辑公共配置 | `~/.pi/agent/settings.json` | 用户默认配置 |

菜单会写入用户选择的 settings 文件。同步操作会在项目文件和用户文件之间复制整个 `subagents.agentOverrides` 子树，并保留 settings 中的其他字段。

### Subagent models 和 thinking

每个内置 Subagent 可以配置：

- `model`：该 Subagent 使用的模型 ID。
- `thinking`：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 之一。`max` 需要包含配套 `max` 兼容性 PR 的 `pi-subagents` build。
- `fallbackModels`：有序 fallback 列表。UI 可以从可搜索模型选择器追加，也可以接受逗号或换行分隔的手动输入。

内置 agent 名称：

```text
context-builder, delegate, oracle, planner, researcher, reviewer, scout, worker
```

### Subagent tools

Tools 设置用于控制 Subagent 运行时可使用的工具集合。

| 模式 | Settings 值 | 运行效果 |
|------|-------------|----------|
| Agent 默认工具 | 省略 `tools` 字段 | 使用 agent 配置的工具策略 |
| Tools allowlist | `"tools": ["read", "bash"]` | 将列表中的工具授权给该 Subagent |
| 禁用工具 | `"tools": false` | 使用空的显式工具集合运行该 Subagent |

Tools 编辑器从母 Agent 当前 active tools 开始构造候选列表，并使用 Pi 已配置工具元数据补充描述。手动输入路径支持普通工具名、带 `mcp:` 前缀的 MCP direct tools，以及 path-like extension tools。选择 `subagent` 工具时会要求确认，因为它会授予 nested fanout 能力。

## 数据文件

| 数据 | 路径 |
|------|------|
| 模型 Providers 和 Models | `~/.pi/agent/models.json` |
| 模型请求 Payload | `~/.pi/agent/model-config-payloads.json`（或 `<PI_CODING_AGENT_DIR>/model-config-payloads.json`） |
| 用户 Subagent overrides | `~/.pi/agent/settings.json` |
| 项目 Subagent overrides | `<project>/.pi/settings.json` |

API key 可以直接保存在 Provider 配置中，也可以使用 `$OPENAI_API_KEY` 这类环境变量引用。

## 项目结构

```text
pi-model-config/
├── README.md                     # 英文文档
├── README-CN.md                  # 中文文档
├── index.ts                      # Extension 入口和 TUI 流程
├── config.ts                     # models.json 读写 helper
├── compat-settings.ts            # 三态兼容性设置
├── searchable-multi-select.ts    # 可搜索 bounded 多选组件
├── searchable-select.ts          # 可搜索 bounded 单选组件
├── subagent-settings.ts          # subagents.agentOverrides 读写 helper
├── subagent-ui.ts                # Subagent 展示 helper
├── tool-options.ts               # 母 Agent 工具候选构造和工具列表解析
├── types.ts                      # 模型配置类型
├── tests/                        # Node 测试套件
├── package.json                  # package 元数据
└── package-lock.json             # 锁定依赖
```

## 开发

运行测试：

```bash
npm test
```

运行语法检查：

```bash
npm run check
```

## 许可

MIT
