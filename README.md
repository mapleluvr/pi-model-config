# Pi Model Config

> Interactive configuration for Pi's native model system and `nicobailon/pi-subagents`.

[![pi-package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Pi Model Config 1.2.0 adds `/model-config`, a field-oriented terminal editor for native Providers, Models, private request Payloads, and Subagent overrides. It does not register Providers dynamically; Pi continues to own `models.json` loading and ModelRegistry refresh.

Chinese documentation: [README-CN.md](README-CN.md)

## Installation

Install from a checkout:

```bash
pi install -l /path/to/pi-model-config
```

A manual user or project installation also works:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi-model-config ~/.pi/agent/extensions/model-config

mkdir -p .pi/extensions
cp -r pi-model-config .pi/extensions/model-config
```

Reload Pi after installation. The extension requires an interactive TUI for configuration; non-TUI `/model-config` calls stop before reading or changing model configuration.

## Usage

Run:

```text
/model-config
```

The main menu opens Provider and Model configuration, unchanged Subagent configuration, transaction diagnostics and recovery, and usage guidance. After a model change, close and reopen Pi's `/model` selector so Pi reloads `models.json`.

## Field-oriented editor

Existing Providers and Models open directly in a field-oriented two-pane panel. At 88 columns or wider, categories are on the left and fields are on the right. In a narrow terminal below 88 columns, the same categories and fields use consecutive full-width screens.

Controls:

- Wide mode: `Tab`, `Left`, and `Right` switch panes; configured up/down bindings move the cursor; `Enter` opens a category or field.
- Narrow mode: `Enter` opens a category; `Left` or the configured cancel binding returns to categories; cancel from categories closes the panel.
- Both modes: `/` searches every exposed field; cancel restores the previous category, field, focus, and scroll location.

New objects retain small creation wizards. A Provider asks for Provider ID, Base URL, and API type. A Model asks for Model ID and applies Pi-compatible defaults. The new object then opens in the panel at General.

### Save behavior

Simple fields save immediately after a valid confirmed value. Cancel leaves storage unchanged, required blanks are rejected, and optional fields have explicit clear or inherited/default actions.

Nested values use one local draft with explicit `Save and return` and `Discard changes`. This applies to Headers, Model Overrides, Thinking Level Map, Cost including tiers, Compat, and private Payload. A nested save checks the whole edited subtree against its opening baseline; a concurrent change blocks the save instead of overwriting it.

Every native change re-reads the current document, patches only managed fields, validates the complete candidate, and preserves unedited and unknown fields.

## Provider fields

| Category | Fields and actions |
|----------|--------------------|
| General | Provider ID, display name, API Base URL, API type |
| HTTP and authentication | API Key, Auth Header, Headers |
| Models | Manage Models, Fetch Models from endpoint, Model Overrides |
| Compatibility | Compat |
| Actions | Copy Provider, Delete Provider |

Provider ID changes are journaled rename operations. Model Overrides expose only the documented override subset: record-key Model ID, `name`, `reasoning`, `thinkingLevelMap`, `input`, partial `cost` with optional rates and `tiers`, `contextWindow`, `maxTokens`, `headers`, and `compat`. They never add `id`, `api`, `baseUrl`, or private Payload fields. Unsupported stored override paths are preserved until an explicit previewed cleanup is confirmed.

## Model fields

| Category | Fields and actions |
|----------|--------------------|
| General | Model ID, display name |
| Endpoint overrides | API type, API Base URL, Headers |
| Capabilities and limits | Reasoning, input types, Context Window, Maximum Output Tokens |
| Thinking | `thinkingLevelMap` for `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and mapped `max` values |
| Cost | Input, Output, Cache Read, Cache Write, and complete `cost.tiers` |
| Compatibility | Compat |
| Request parameters | private Payload |
| Actions | Copy Model, Delete Model |

False and zero are displayed literally. Absent values are shown as inherited or not set according to field semantics. API key literals are masked and never pre-filled. Replacing a key opens an empty native input after warning that Pi's input is visible while typing.

## Endpoint discovery

`Fetch Models from endpoint` is always available for every Provider and is never run automatically during creation. Discovery tries the supported `{baseUrl}/models` and `{baseUrl}/v1/models` routes, normalizes valid IDs, removes duplicates in endpoint order, and shows the sanitized source and count summary before any mode is selected.

The preview offers:

- `Merge`: preserve every existing Model object and append only new IDs.
- `Replace`: require a second confirmation, replace the list, and remove private identities for Models that disappear.
- `Cancel`: write nothing.

Merge and Replace both preview introduced identities and private identity collisions. Collision reuse or replacement requires explicit confirmation, and current files are revalidated under the shared coordinator before commit.

## Native and private data

Pi Model Config reads Pi 0.80.6 `models.json` as JSONC, including comments and trailing commas. A successful native save emits canonical JSON. Blank, malformed, or schema-invalid native configuration is never replaced.

Private request values are stored in `~/.pi/agent/model-config-payloads.json`, or `<PI_CODING_AGENT_DIR>/model-config-payloads.json`. Each key is the JSON encoding of the exact `[provider, model-id]` tuple, so slash characters are unambiguous. The selected Model's object is shallowly merged during `before_provider_request`; unrelated Models are unchanged.

Payload and API-key values are secret-bearing data. They are not included in diagnostics, recovery previews, action results, errors, logs, or test output. Private storage and transaction snapshots use private file permissions. Valid legacy `extraPayload` rows can migrate through confirmed editor actions; malformed rows require an explicit discard preview.

## Locking and recovery

All model and private Payload mutations use an OS-owned IPC lock: a named pipe on Windows, an abstract Unix socket on Linux, or a loopback identity handshake on macOS. The endpoint disappears when its owner exits or crashes. There is no lock file, stale-owner deletion, force unlock, or prompt while the lock is held.

Cross-file changes use `model-config-transaction.json` as a private transaction journal. The coordinator writes the journal, native candidate, private candidate, and journal removal through atomic replacements while checking the same live endpoint before each write. Request-time Payload resolution uses stable snapshots and fails closed rather than mixing transaction sides.

Diagnostics can complete unambiguous recovery automatically. Recovery requiring a decision is two-phase: inspect under a fresh IPC lock, release it, show a non-secret preview with `Cancel` and `Retry`, then reacquire and apply only if exact hashes and parse states still match. Busy, endpoint collision, unsupported adapter, malformed journal, and blocked native states produce generic non-secret diagnostics. Recovery never overwrites native configuration to resolve a mismatched journal.

## Subagent configuration

The Subagent UI and behavior are unchanged in 1.2.0. It edits `subagents.agentOverrides` for the builtin `context-builder`, `delegate`, `oracle`, `planner`, `researcher`, `reviewer`, `scout`, and `worker` agents.

Each override can set `model`, `thinking`, ordered `fallbackModels`, and `tools`. Tools support the agent default, a searchable allowlist, the parent Agent's current active tools, manual MCP or path-like tool IDs, and `false` to disable all tools. Selecting `subagent` asks for confirmation because it permits nested fanout.

Project settings live at `<project>/.pi/settings.json`; user settings live at `~/.pi/agent/settings.json`. Sync actions copy only the complete `subagents.agentOverrides` subtree and preserve other settings fields.

## Data files

| Data | Path |
|------|------|
| Native Providers and Models | `~/.pi/agent/models.json` |
| Private Model Payloads | `~/.pi/agent/model-config-payloads.json` |
| Recovery journal while needed | `~/.pi/agent/model-config-transaction.json` |
| User Subagent overrides | `~/.pi/agent/settings.json` |
| Project Subagent overrides | `<project>/.pi/settings.json` |

The first three paths use `<PI_CODING_AGENT_DIR>` when that environment variable is set.

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

The published package contains only root runtime TypeScript modules, the bilingual documentation, license, and package metadata. Tests, `.pi-subagents`, journals, temporary agent data, and generated archives are excluded.

## Development

```bash
npm test
npm run check
npm pack --dry-run --json | node --experimental-strip-types tests/fixtures/assert-package.ts
```

## License

MIT. See [LICENSE](LICENSE).
