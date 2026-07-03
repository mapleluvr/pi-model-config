# Pi Model Config

> 使用 **DeepSeek V4 Pro** 开发的 Pi 可视化模型配置插件

[![pi-package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![author](https://img.shields.io/badge/developed%20with-DeepSeek%20V4%20Pro-orange)](https://deepseek.com)

可视化地管理 Pi Agent 的自定义模型提供商、定义模型参数，并自动保存到 `models.json`。

## 功能

- **Provider 管理** — 添加、编辑、删除、复制自定义模型提供商
- **自动拉取模型列表** — 从 OpenAI 兼容 API 端点一键发现所有可用模型
- **Model 管理** — 为每个 Provider 定义模型及其完整参数
- **兼容性选项** — Provider / Model 兼容性布尔项支持「默认 / false / true」三态编辑
- **Payload 参数** — 为单个模型添加自定义 API 请求体参数（支持 JSON / String / Bool，带 JSON 合法性检测）
- **Pi 默认参数展示** — 编辑模型时展示 Pi Agent 的标准参数（contextWindow、maxTokens 等）供参考和修改
- **自动保存** — 每次操作后自动写入 `models.json`，无需手动保存
- **启动加载** — Pi 启动时自动从 `models.json` 恢复所有 Providers
- **Subagent 配置** — 管理 `pi-subagents` 内置 agents 的 `model`、`thinking`、`fallbackModels`、`tools` 覆盖配置

## 安装

```bash
# 全局安装（所有项目可用）
mkdir -p ~/.pi/agent/extensions
cp -r pi-model-config ~/.pi/agent/extensions/model-config

# 或项目级安装
cp -r pi-model-config .pi/extensions/model-config

# Pi 中执行 /reload 加载
```

## 使用

在 Pi 中输入：

```
/model-config
```

### 工作流程

1. **添加 Provider** -> 输入 Base URL、API 类型、API Key
2. **自动拉取模型** -> 点击「自动拉取 Model 列表」，从 API 端点发现所有模型
3. **自定义 Payload** -> 编辑单个模型，添加 `temperature`、`top_p` 等自定义参数
4. **自动保存** -> 每次修改后自动写入 `~/.pi/agent/models.json`
5. **查看模型** -> 关闭并重新打开 `/model`（Ctrl+L），Pi 自动加载新模型

### Payload 参数类型

| 类型 | 输入方式 | 验证 |
|------|----------|------|
| `string` | 文本输入 | 无 |
| `bool` | 选择 true/false | 无 |
| `json` | 文本输入 | **JSON.parse() 合法性检测，非法时提示重试** |

### Subagent 配置

进入 `/model-config` 后选择「Subagent 配置」。该功能读写 Pi settings 中的 `subagents.agentOverrides`。**联动关系：`model-config` 只提供可视化编辑 UI；实际读取并应用这些 Subagent 覆盖配置的是 `pi-subagents` 插件/扩展。**

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

配置编辑方式：

- 「编辑本项目配置」：创建/编辑当前项目 `.pi/settings.json` 的 `subagents.agentOverrides`。
- 「编辑公共配置」：编辑公共配置 `~/.pi/agent/settings.json` 的 `subagents.agentOverrides`。
- 只有用户明确选择公共配置时才会写公共 settings；默认不会因为项目配置缺失而隐式写公共配置。

同步操作：

- 「本项目配置 → 公共配置」：用项目 `subagents.agentOverrides` 覆盖公共配置的同名子树。
- 「公共配置 → 本项目配置」：用公共 `subagents.agentOverrides` 覆盖项目配置的同名子树。

两种同步都会在确认后执行，并且只覆盖 `subagents.agentOverrides` 子树，保留 settings 其他字段。

`fallbackModels` 支持从模型选择器追加模型，也支持手动编辑逗号/换行分隔列表。追加时会自动去重并保留原顺序。

`tools` 支持三种状态：不写 `tools` 字段表示使用 agent 默认工具；写入 `tools: ["read", "bash"]` 表示 tools allowlist；写入 `tools: false` 表示禁用所有工具。工具候选来自母 Agent 当前 active tools，描述来自 Pi 已配置工具元数据。

支持的内置 agents：`context-builder`、`delegate`、`oracle`、`planner`、`researcher`、`reviewer`、`scout`、`worker`。

## 项目结构

```
pi-model-config/
├── index.ts                     # 扩展入口 + TUI 流程 + 命令注册
├── config.ts                    # models.json 读写
├── compat-settings.ts           # 兼容性布尔选项三态写入逻辑
├── searchable-multi-select.ts   # 可搜索 bounded 多选组件
├── searchable-select.ts         # 可搜索 bounded 单选组件
├── subagent-settings.ts         # subagents.agentOverrides 读写与 scope 解析
├── subagent-ui.ts               # Subagent 配置展示辅助函数
├── tool-options.ts              # 母 Agent 工具候选构造与工具列表规范化
├── types.ts                     # TypeScript 类型定义
├── tests/
│   ├── compat-settings.test.ts   # 兼容性三态布尔单元测试
│   ├── no-emoji.test.ts          # 插件文案无 emoji 约束测试
│   ├── searchable-multi-select.test.ts # 多选组件测试
│   ├── searchable-select.test.ts # 单选组件测试
│   ├── subagent-settings.test.ts # Subagent settings 单元测试
│   ├── subagent-ui.test.ts       # Subagent 展示辅助函数测试
│   └── tool-options.test.ts      # 工具候选构造测试
├── package.json                 # 包元数据
└── README.md                    # 本文档
```

## 隐私声明

- 无硬编码 API Key / Token / 密码
- 所有路径通过 `os.homedir()` 动态解析
- API Key 支持环境变量引用（`$VAR`），不存储明文到仓库

## 许可

MIT — 使用 DeepSeek V4 Pro 开发
