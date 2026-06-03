# Pi Model Config

> 🧩 由 **DeepSeek** 开发的 Pi 可视化模型配置插件

[![pi-package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![author](https://img.shields.io/badge/author-DeepSeek-orange)](https://deepseek.com)

可视化地管理 Pi Agent 的自定义模型提供商、定义模型参数，并自动保存到 `models.json`。

## 功能

- 🧩 **Provider 管理** — 添加、编辑、删除、复制自定义模型提供商
- 🔍 **自动拉取模型列表** — 从 OpenAI 兼容 API 端点一键发现所有可用模型
- 📦 **Model 管理** — 为每个 Provider 定义模型及其完整参数
- ⚙️ **Payload 参数** — 为单个模型添加自定义 API 请求体参数（支持 JSON / String / Bool，带 JSON 合法性检测）
- 📊 **Pi 默认参数展示** — 编辑模型时展示 Pi Agent 的标准参数（contextWindow、maxTokens 等）供参考和修改
- 💾 **自动保存** — 每次操作后自动写入 `models.json`，无需手动保存
- 🚀 **启动加载** — Pi 启动时自动从 `models.json` 恢复所有 Providers

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

1. **添加 Provider** → 输入 Base URL、API 类型、API Key
2. **自动拉取模型** → 点击「🔍 自动拉取 Model 列表」，从 API 端点发现所有模型
3. **自定义 Payload** → 编辑单个模型，添加 `temperature`、`top_p` 等自定义参数
4. **自动保存** → 每次修改后自动写入 `~/.pi/agent/models.json`
5. **查看模型** → 关闭并重新打开 `/model`（Ctrl+L），Pi 自动加载新模型

### Payload 参数类型

| 类型 | 输入方式 | 验证 |
|------|----------|------|
| `string` | 文本输入 | 无 |
| `bool` | 选择 true/false | 无 |
| `json` | 文本输入 | **JSON.parse() 合法性检测，非法时提示重试** |

## 项目结构

```
pi-model-config/
├── index.ts       # 扩展入口 + TUI 流程 + 命令注册
├── config.ts      # models.json 读写
├── types.ts       # TypeScript 类型定义
├── package.json   # 包元数据
└── README.md      # 本文档
```

## 隐私声明

- ✅ 无硬编码 API Key / Token / 密码
- ✅ 所有路径通过 `os.homedir()` 动态解析
- ✅ API Key 支持环境变量引用（`$VAR`），不存储明文到仓库

## 许可

MIT — 由 DeepSeek 开发
