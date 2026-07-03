# Pi Model Config

> Interactive configuration for Pi's native model system and `nicobailon/pi-subagents`.

[![pi-package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![author](https://img.shields.io/badge/developed%20with-DeepSeek%20V4%20Pro-orange)](https://deepseek.com)

Pi Model Config adds a `/model-config` command for managing model providers, model definitions, payload parameters, compatibility settings, and subagent overrides from an interactive terminal UI.

Chinese documentation: [README-CN.md](README-CN.md)

## Features

### Pi model configuration

- Manage Providers: create, edit, copy, and delete custom model providers.
- Discover models: import model IDs from OpenAI-compatible `/models` endpoints.
- Manage Models: edit model IDs, display names, input modes, reasoning support, context windows, output token limits, and pricing fields.
- Manage compatibility settings: set Provider-level and Model-level Pi compatibility options with default, true, and false states.
- Manage payload parameters: add string, bool, and JSON request-body fields for individual models.
- Register configured providers at Pi startup from `models.json`.

### Subagent configuration

- Configure builtin `pi-subagents` agents from the same `/model-config` UI.
- Set `model`, `thinking`, and `fallbackModels` overrides.
- Configure `tools` overrides with a searchable allowlist editor.
- Select tools from the parent Agent's current active tools.
- Use Pi tool metadata to show descriptions for available tools.
- Add MCP direct tools such as `mcp:server/tool` and path-like extension tools through manual input.
- Sync subagent overrides between project settings and user settings.

### Terminal interaction

- Search long model lists with a bounded selector.
- Search and toggle long tools lists with a bounded multi-select.
- Keep long menus inside the plugin UI instead of relying on terminal scrollback.

## Installation

Install from a local checkout:

```bash
pi install -l /path/to/pi-model-config
```

Manual installation is also supported:

```bash
# User-level extension
mkdir -p ~/.pi/agent/extensions
cp -r pi-model-config ~/.pi/agent/extensions/model-config

# Project-level extension
mkdir -p .pi/extensions
cp -r pi-model-config .pi/extensions/model-config
```

Reload Pi after installation so the extension is loaded.

## Usage

Run the command in Pi:

```text
/model-config
```

The main menu opens these areas:

1. `Manage Providers` for Pi model provider and model definitions.
2. `Subagent Config` for `pi-subagents` overrides.
3. Diagnostics for the active `models.json` file.

## Pi model workflow

1. Create a Provider with a provider ID, base URL, API type, and API key setting.
2. Import model IDs from an OpenAI-compatible `/models` endpoint or add models manually.
3. Edit each Model's context window, max output tokens, reasoning flag, input modes, and pricing fields.
4. Add payload parameters when a model requires extra API request-body fields.
5. Reopen Pi's `/model` selector after saving so Pi reloads the updated `models.json`.

### Payload parameter types

| Type | Input | Validation |
|------|-------|------------|
| `string` | Plain text | Stored as a string value |
| `bool` | `true` or `false` selection | Stored as a boolean value |
| `json` | JSON text | Parsed with `JSON.parse()` before saving |

## Subagent configuration

Subagent settings are stored under Pi settings at `subagents.agentOverrides`.
`model-config` writes these overrides, and `pi-subagents` applies them when it runs subagents.

Example:

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

### Settings scopes

| Menu entry | Settings file | Scope |
|------------|---------------|-------|
| Edit Project Config | `<project>/.pi/settings.json` | Current project |
| Edit User Config | `~/.pi/agent/settings.json` | User default |

The menu writes to the selected settings file. Sync actions copy the whole `subagents.agentOverrides` subtree between the project file and the user file while preserving other settings fields.

### Subagent models and thinking

Each builtin subagent can receive:

- `model`: the model ID used by that subagent.
- `thinking`: one of `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- `fallbackModels`: an ordered fallback list. The UI can append from the searchable model selector or accept comma/newline-separated manual input.

Builtin agent names:

```text
context-builder, delegate, oracle, planner, researcher, reviewer, scout, worker
```

### Subagent tools

Tools settings control the tools available to a subagent at runtime.

| Mode | Settings value | Runtime behavior |
|------|----------------|------------------|
| Agent default tools | Omit the `tools` field | Use the agent's configured tool policy |
| Tools allowlist | `"tools": ["read", "bash"]` | Grant the listed tools to the subagent |
| Disabled tools | `"tools": false` | Run the subagent with an empty explicit tool set |

The tools editor starts from the parent Agent's current active tools and enriches the list with descriptions from Pi's configured tool metadata. The manual input path accepts regular tool names, MCP direct tools with the `mcp:` prefix, and path-like extension tools. Selecting `subagent` asks for confirmation because it grants nested fanout capability.

## Data files

| Data | Path |
|------|------|
| Model providers and models | `~/.pi/agent/models.json` |
| User subagent overrides | `~/.pi/agent/settings.json` |
| Project subagent overrides | `<project>/.pi/settings.json` |

API keys can be stored directly in provider config or referenced with environment variables such as `$OPENAI_API_KEY`.

## Project structure

```text
pi-model-config/
├── README.md                     # English documentation
├── README-CN.md                  # Chinese documentation
├── index.ts                      # Extension entry point and TUI flows
├── config.ts                     # models.json read/write helpers
├── compat-settings.ts            # Tri-state compatibility settings
├── searchable-multi-select.ts    # Searchable bounded multi-select component
├── searchable-select.ts          # Searchable bounded select component
├── subagent-settings.ts          # subagents.agentOverrides read/write helpers
├── subagent-ui.ts                # Subagent display helpers
├── tool-options.ts               # Parent-tool option builder and tool-list parser
├── types.ts                      # Model configuration types
├── tests/                        # Node test suite
├── package.json                  # Package metadata
└── package-lock.json             # Locked dependencies
```

## Development

Run tests:

```bash
npm test
```

Run syntax checks:

```bash
npm run check
```

## License

MIT
