# Pi Model Config Two-Pane Editor Design

**Status:** User-approved design, pending independent review
**Date:** 2026-07-18
**Target:** The next `pi-model-config` release after 1.1.0

## Purpose

Replace the Provider and Model editors' linear prompt pipelines with a
field-oriented settings interface. A user editing one existing value must be
able to select that field directly, change it, and return to the same place
without confirming every unrelated field.

The new interface uses a responsive two-pane TUI on wide terminals, preserves
the existing lightweight creation paths, exposes the common Pi-native fields
that the current editor only preserves, and retains endpoint-based Model
discovery as a first-class Provider action.

## Confirmed Product Decisions

- Existing Providers and Models use a two-pane settings editor.
- New Providers and Models keep a minimal creation wizard and open the settings
  editor immediately after creation.
- Simple fields save immediately after the user confirms a valid value.
- Nested values are edited as local drafts and commit only through an explicit
  save action.
- The UI exposes Pi's common Provider and Model fields, not only the fields in
  the current linear editor.
- The extension does not add a raw editor for the complete Provider or Model
  object.
- Endpoint-based Model discovery remains available for every Provider, whether
  or not that Provider already contains Models.
- User-visible labels remain Chinese, matching the current extension; native
  field identifiers may appear alongside those labels when useful.
- The panel uses text and Pi theme states rather than emoji markers.

## Goals

- Make every exposed field directly reachable by category or global field
  search.
- Keep editing context after a successful field change: active category,
  selected field, and scroll positions are restored.
- Distinguish inherited, absent, explicit false, explicit zero, and populated
  nested values in the UI.
- Preserve unknown Pi-native and extension fields during every edit.
- Add direct editing for Provider `headers` and `modelOverrides`, plus Model
  `api`, `baseUrl`, `headers`, complete base pricing, and existing advanced
  fields.
- Preserve Provider/Model rename, copy, delete, payload lifecycle, compatibility
  editing, cost tiers, and endpoint Model discovery.
- Remain usable on terminals too narrow for two panes.

## Non-Goals

- Redesign the Subagent settings UI in this change.
- Build a general JSON or JSONC IDE.
- Change the `models.json` schema, private payload schema, or Pi ModelRegistry
  behavior.
- Change endpoint discovery's URL probing or credential resolution contract.
- Make unknown fields editable; they remain preserved but are not surfaced.
- Add mouse interaction or require a terminal overlay.

## User Experience

### Entry Flow

The existing `/model-config` command and Provider/Model selection lists remain.
Selecting `Edit settings` for a Provider or `Edit` for a Model opens the new
settings panel instead of invoking the old linear editor.

Wide terminals render two panes:

```text
+ Provider: openrouter ------------------------------------------------------+
| Categories               | Fields                                         |
|                          |                                                |
| > General                | > Provider ID       openrouter                 |
|   HTTP and Auth          |   Display name      OpenRouter                 |
|   Models                 |   API Base URL      https://...                |
|   Compatibility          |   API type          openai-completions         |
|   Actions                |   Auth Header       true                       |
|                          |                                                |
| Tab/Left/Right switch pane  Up/Down move  Enter edit  / search  Esc back  |
+---------------------------------------------------------------------------+
```

The left pane selects a category. The right pane lists that category's fields
and current values. The focused pane and selected row have explicit cursor and
theme states; color is not the only focus signal.

### Keyboard Behavior

- In wide mode, `Tab`, `Left`, and `Right` switch pane focus. Moving in the
  category pane previews that category immediately; Enter or Right moves focus
  into its field pane. Enter in the field pane activates the selected field.
- Pi's configured `tui.select.up` and `tui.select.down` bindings move within
  the focused pane. In wide mode, Pi's configured `tui.select.cancel` binding
  closes the settings panel from either pane.
- In narrow mode, the category list is one screen and the selected category's
  field list is the next screen. Enter opens the field list; Left or Pi's
  configured `tui.select.cancel` returns from fields to categories. Cancelling
  from categories closes the settings panel.
- `/` closes the panel into the existing searchable selector populated with all
  exposed fields. Selecting a result reopens the panel at that category/field;
  cancelling search restores the previous panel state.
- The footer always shows the active bindings and available actions.

### Responsive Layout

- At 88 columns or wider, the component renders side-by-side panes.
- Below 88 columns, it renders a single field pane with the current category as
  a breadcrumb. `Left` or `Esc` returns to the category list.
- Both layouts preserve the same field descriptors, actions, and selection
  state.
- Every rendered line is ANSI-aware truncated to the `render(width)` contract.
- Lists have bounded visible windows and scroll around the selected row.

### Display Values

The panel never relies on JavaScript truthiness to format values:

- `(inherited)` means the field is absent and inherits from an enclosing Pi
  definition.
- `(not set)` means an optional field is absent without inheritance semantics.
- `false` and `0` are displayed literally.
- Nested fields show summaries such as `3 entries` or `4 overrides`.
- Literal API keys are masked, retaining only a short non-sensitive suffix.
  Environment references and command references may be shown unchanged.

## Component Architecture

### `settings-panel.ts`

`TwoPaneSettingsPanel` is a reusable, I/O-free TUI component. It accepts:

- panel title and optional subtitle;
- ordered category descriptors;
- ordered field descriptors for each category;
- current category, field, focus, and scroll state;
- theme and injected keybinding manager;
- a completion callback.

It returns one of these semantic outcomes:

- edit a field;
- open a nested section;
- run an object action;
- search all fields;
- return to the caller.

The result includes the current panel state so the caller can restore the same
location after another Pi UI primitive runs. The component does not read files,
validate domain values, mutate configuration, or open nested `ctx.ui.custom()`
instances.

### Controller Loop

Provider and Model editor controllers own an outer loop:

1. Read the current object and build field descriptors.
2. Open `TwoPaneSettingsPanel` through `ctx.ui.custom()`.
3. Receive a semantic action and saved panel state.
4. Use the existing Pi `input`, `select`, or `editor` primitive, or a bounded
   nested editor, to collect the new value.
5. Validate and persist the confirmed patch.
6. Rebuild descriptors from persisted configuration and reopen the panel at the
   saved state.

Closing the panel before an input dialog avoids nested custom-component focus
and lifecycle problems. It also preserves Pi's built-in Chinese IME behavior.

### Domain Modules

- `provider-editor.ts` defines Provider categories, field descriptors, edit
  actions, creation, rename, copy, delete, and Model discovery routing.
- `model-editor.ts` defines Model and Model Override categories, field
  descriptors, edit actions, creation, rename, copy, and delete.
- `field-editors.ts` contains shared object editors and value collection for
  headers, compat data, thinking maps, costs, and other nested structures.
- `index.ts` retains command registration, top-level routing, Provider/Model
  selection, and delegates editing to the domain controllers.

Pure formatting, descriptor construction, and patch functions remain
independent of Pi UI calls so they can be tested directly.

## Provider Field Catalog

### General

- Provider ID
- Display name
- API Base URL
- API type

### HTTP and Authentication

- API Key
- Auth Header
- Headers

`Headers` uses a local key/value draft editor with add, edit, and delete. It
commits the complete object through `Save and return`; cancelling leaves the
stored object untouched.

### Models

- Manage Models
- Fetch Models from endpoint
- Model Overrides

`Manage Models` opens the existing searchable Model list. `Model Overrides`
opens a keyed list. Each override reuses Model field descriptors in partial
override mode: absent values display as inherited, payload is unavailable, and
only explicitly set fields are persisted. Override entries can be added,
renamed, or deleted with collision and destructive confirmations.

### Compatibility

- Compat

The existing compatibility field set remains available. It uses a local draft
and explicit save/discard actions while preserving unknown compat fields.

### Actions

- Copy Provider
- Delete Provider

Provider ID editing is a rename operation. It validates uniqueness and migrates
the Provider's private Model payload identities only after native configuration
persistence succeeds.

## Model Field Catalog

### General

- Model ID
- Display name

### Endpoint Overrides

- API type
- API Base URL
- Headers

### Capabilities and Limits

- Reasoning
- Input types
- Context Window
- Maximum Output Tokens

Input types use a multi-select editor and must retain at least one supported
type. Positive token limits are required when explicitly configured.

### Thinking

- Thinking Level Map

The map covers `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
It remains editable and preserved when `reasoning` is false, but the UI shows a
warning that the map is inactive for the current capability flag.

### Pricing

- Input price
- Output price
- Cache Read price
- Cache Write price
- Cost Tiers

Prices must be finite and non-negative. Cost tiers remain ordered local-draft
entries with a positive integer threshold and finite non-negative rates.

### Compatibility

- Compat

### Request Parameters

- Payload

Payload continues to use private extension storage keyed by exact Provider and
Model identity. It is never added to native `models.json` and is excluded from
Model Override editing.

### Actions

- Copy Model
- Delete Model

Model ID editing is a rename operation. It migrates the exact private payload
identity only after native configuration persistence succeeds.

## Creation Flows

New objects use short wizards rather than the settings panel's immediate-save
contract before an identity exists:

- Provider: ID, Base URL, API type, then create.
- Model: ID, then create with the extension's Pi-compatible defaults.

The object is not written until the wizard's required values are valid and
confirmed. After creation, the corresponding two-pane panel opens at General.
An empty Provider may suggest endpoint Model discovery, but discovery is never
forced as part of creation.

## Edit and Persistence Semantics

### Simple Fields

- Cancelling the input leaves storage unchanged.
- Required fields reject blank values and retain the old value.
- Optional fields provide an explicit `Clear` or `Use default/inherited`
  action; blank strings and magic words do not encode deletion.
- Valid confirmed values are persisted immediately.
- Success returns to the same category and field.

### Nested Fields

Headers, Model Overrides, Thinking Level Map, Cost Tiers, Compat, and Payload
use cloned local drafts. Each nested editor exposes `Save and return` and
`Discard changes`. Escape is equivalent to discard. Model Override entry
creation, rename, deletion, and child-field edits remain staged in the one
Model Overrides draft until that editor is saved. A failed save retains the
draft so the user can correct it or discard it.

### Fresh Reads and Preservation

Before every save, the controller re-reads and validates `models.json`, locates
the target by its stable identity, and applies only the confirmed field patch.
If another process removed or renamed the target, the operation stops, reports
the conflict, and refreshes the panel. The patch layer preserves unknown root,
Provider, Model, cost, compat, and nested fields.

The private payload file follows its existing fail-closed behavior. Native
configuration is persisted before payload identity migrations. A private
payload failure is reported explicitly and must not be presented as a complete
rename success.

## Endpoint Model Discovery

`Fetch Models from endpoint` is always present in the Provider's Models
category. The existing discovery request contract remains:

- use the current Provider Base URL and credential resolution behavior;
- try `{baseUrl}/models`, then `{baseUrl}/v1/models`;
- accept the response formats already supported by the extension;
- time out and report failure without changing configuration.

After a successful fetch, the UI shows the source endpoint, count, and an ID
summary, then offers:

- `Merge`: keep every existing Model object unchanged and append only IDs that
  are not already present;
- `Replace`: require a second confirmation, replace the native list, and remove
  private payload entries for Models no longer present;
- `Cancel`: write nothing.

Endpoint records are treated as discovery data, not authoritative replacements
for hand-edited records with the same ID.

## Errors and Safety

- Malformed or blank native configuration is never overwritten.
- File, parse, validation, stale-target, and collision errors name the affected
  object and provide a recovery action.
- Destructive delete, rename collision resolution, and endpoint replacement are
  explicit confirmation paths.
- API key literals do not appear in panel rows, notifications, test snapshots,
  or error messages.
- The component uses Pi's injected theme and keybindings, requests a render
  after state changes, and never emits lines wider than the provided width.
- Non-TUI invocation reports that the interactive editor requires TUI mode and
  performs no mutation.

## Test Strategy

Implementation follows TDD for new behavior. Focused tests cover:

### Component Tests

- side-by-side rendering at and above 88 columns;
- single-pane rendering below 88 columns;
- ANSI-aware line-width bounds;
- pane focus, category changes, scrolling, selection, confirm, cancel, and
  search outcomes;
- panel state restoration after an external edit dialog;
- explicit selected/focused indicators without relying only on color.

### Descriptor and Patch Tests

- every Provider, Model, and Model Override field is present in the expected
  category;
- absent, inherited, false, zero, nested-count, and masked-secret formatting;
- immediate patches edit only the chosen field;
- explicit clear behavior and required-field rejection;
- unknown field preservation after every supported patch;
- complete pricing, thinking-map `max`, headers, and endpoint overrides.

### Controller and Nested-Editor Tests

- simple edit confirmation and cancellation;
- nested draft save and discard;
- Provider/Model rename collisions and private payload migration;
- stale-target refresh after an external modification;
- creation wizard minimum fields and post-create panel state;
- destructive confirmations.

### Endpoint Discovery Tests

- the endpoint action remains available with zero or many Models;
- timeout, HTTP failure, unsupported shape, and empty response do not mutate
  configuration;
- merge preserves existing same-ID Model objects and appends new IDs;
- replace requires confirmation and removes payloads for deleted Models;
- cancel performs no write.

The existing test suite and syntax checks must continue to pass.

## Acceptance Criteria

1. Editing an existing Provider or Model never starts the old full prompt
   pipeline.
2. Every exposed field is reachable through a category and through global
   field search.
3. A simple field edit returns to the same panel location after immediate
   persistence.
4. Every nested object has explicit save and discard behavior.
5. New Providers and Models use only the approved minimal wizard and then open
   the settings panel.
6. Common Provider and Model fields listed in this design are directly
   editable, while unknown fields remain intact.
7. `Fetch Models from endpoint` remains available and satisfies the specified
   merge, replace, cancel, and failure behavior.
8. Provider/Model identity changes preserve private payload lifecycle and reject
   collisions.
9. Wide terminals use two panes and narrow terminals remain fully operable.
10. API key literals are masked throughout the interface.
11. New focused tests, the full existing test suite, and syntax checks pass.
