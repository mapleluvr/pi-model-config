# Pi Model Config v1.1 Design

**Status:** Approved design, pending implementation-plan review
**Date:** 2026-07-10
**Target:** `pi-model-config` 1.1.0, compatible with Pi Coding Agent 0.80.6

## Purpose

Bring the Model Config extension in line with Pi 0.80.6's native model
configuration contract without replaying native configuration through a
second, semantically different registration path. Preserve every supported
field that the extension does not explicitly edit, and make the extension's
custom request payload feature actually affect outgoing provider requests.

The release also coordinates a narrowly scoped upstream `pi-subagents` fix so
subagent overrides accept the Pi-native `max` thinking level.

## Goals

- Parse Pi-native `models.json` as JSONC, including comments and trailing
  commas, and never overwrite a file that failed to parse.
- Remove startup calls that re-register `models.json` providers through
  `pi.registerProvider()`.
- Expose Pi 0.80.6 model capabilities that the editor currently omits:
  `thinkingLevelMap.max`, `cost.tiers`, and supported compat fields.
- Preserve native provider/model fields that are not edited in the current UI.
- Move custom payload parameters out of native `models.json` into extension
  storage and inject them with `before_provider_request` for the selected
  model only.
- Teach `pi-subagents` to recognize, validate, display, and pass through
  `max` alongside the existing thinking levels.
- Add focused regression tests and update public documentation for both
  projects.

## Non-Goals

- Build a raw JSONC IDE or expose every future Pi configuration property.
- Preserve comments and whitespace byte-for-byte after an extension save.
  Reads accept JSONC; writes produce canonical JSON only after a successful
  parse and preserve data rather than presentation.
- Change Pi's native provider authentication, model discovery, or model
  override behavior.
- Fix unrelated `pi-subagents` test-environment failures caused by a user-home
  `.pi` directory being discovered above Windows temporary directories, or
  Windows symlink creation restrictions.
- Release a new `pi-subagents` package version from this work. The upstream PR
  leaves versioning to its maintainers.

## Native Model Configuration

### JSONC I/O

`config.ts` will use a JSONC parser rather than `JSON.parse`. Read errors are
returned to the caller with the source path and leave the original file
untouched. The save path writes a canonical JSON representation only after the
source has parsed successfully. A malformed native file must never be replaced
by an empty provider map.

The parser and serializer boundaries will be covered by tests for comments,
trailing commas, empty configuration, and malformed input.

### Provider and Model Preservation

Editing is patch-based:

1. Read and clone the existing provider/model record.
2. Apply only fields the user explicitly confirmed in the current flow.
3. Delete a field only when the user chose an explicit clear action.
4. Save the merged configuration after JSONC parsing succeeds.

This preserves fields such as provider `headers` and `modelOverrides`, plus
model `api`, `baseUrl`, `headers`, custom native fields, compat entries,
thinking maps, and price tiers that are not being edited. Optional prompts
distinguish cancellation, unchanged input, and an explicit clear; cancellation
must never be interpreted as deletion.

### Provider Registration

The extension will no longer read `models.json` and replay it with
`pi.registerProvider()` during activation. Pi owns native configuration loading
and `ModelRegistry` refresh behavior. This avoids dynamic registration's model
replacement semantics, unsupported `modelOverrides`, and its stricter
provider-local authentication requirements.

### Thinking and Cost Fields

The model editor will expose all Pi 0.80.6 thinking levels through `max`.
`thinkingLevelMap` values are stored only when explicitly selected and are
validated as booleans.

The cost editor adds zero or more `tiers`. A tier has a positive
`inputTokensAbove` threshold and optional non-negative `input`, `output`,
`cacheRead`, and `cacheWrite` rates. The UI supports add, edit, remove, and
ordered display. It keeps existing tiers untouched unless the user enters the
tier editor and confirms a mutation.

### Compatibility Configuration

The advanced compatibility editor is grouped by its corresponding request
contract and preserves unknown entries. It adds missing Pi 0.80.6 fields:

- `requiresAssistantAfterToolResult`
- `requiresReasoningContentOnAssistantMessages`
- `sendSessionAffinityHeaders`
- `zaiToolStream`
- `chatTemplateKwargs`
- `openRouterRouting`
- `vercelGatewayRouting`
- `sendSessionIdHeader`
- `supportsCacheControlOnTools`
- `supportsTemperature`

`thinkingFormat` includes all currently supported values, including `zai`,
`chat-template`, `string-thinking`, and `ant-ling`. Existing compatible fields
such as `maxTokensField`, `thinkingFormat`, and `cacheControlFormat` can be
added as well as changed or removed; their absence no longer hides the editor.

## Extension Payload Parameters

`extraPayload` is not a Pi-native `models.json` property and runtime model
objects drop it. v1.1 removes it from native model persistence.

The extension instead stores payload objects in its private config file:

```json
{
  "version": 1,
  "extraPayloads": {
    "provider/model-id": {
      "provider_specific_option": true
    }
  }
}
```

Model identity is the exact `provider/id` pair. The editor validates that a
payload is a JSON object. Values are never logged. On
`before_provider_request`, the extension resolves the current model identity,
copies the configured object, and shallow-merges it into that request's body.
It must not alter requests for other models. A missing or malformed private
payload file fails closed: no payload is injected and the request otherwise
continues.

Deleting a model removes its exact payload entry; deleting a provider removes
all entries with that provider prefix. An identity change migrates the entry
only after the native model save succeeds. Tests cover isolation, migration,
cleanup, invalid JSON, and injection without mutation of the stored object.

## Pi Subagents Compatibility PR

The separate `fix/thinking-max` branch starts from upstream `main` at
`c940fe2` (v0.34.0 line). It adds `max` at the one shared thinking-level source
and updates every parser/formatter/argument path that uses that source.

Required tests demonstrate that:

- a configured `model:max` suffix resolves to `thinking: "max"`;
- `max` is emitted when launching a child Pi process;
- existing thinking-level suffixes and unset overrides remain unchanged.

No behavior beyond Pi's new native level is changed, and no release version is
bumped in the upstream PR.

## Test Strategy

`pi-model-config` gains unit tests before implementation for:

- JSONC comments/trailing commas and malformed-file write protection;
- non-destructive provider/model editing and explicit clearing;
- `max` thinking-map values and cost-tier validation/mutation;
- every newly exposed compat value and absent-field creation;
- private payload persistence, request injection, identity migration, and
  cleanup.

`pi-subagents` gains focused tests for the new `max` thinking level and runs
its affected parser/launch tests. Its full suite is run with a temporary root
outside the Windows user home, avoiding a false project-root match. One
remaining local symlink test may be skipped only when Windows denies symlink
creation with `EPERM`; Linux CI is expected to exercise it normally.

## Documentation and Release

`pi-model-config` updates its package version to 1.1.0 and documents:

- Pi 0.80.6 support and the `max`/cost-tier additions;
- JSONC read support and canonical JSON saves;
- plugin-private payload storage and request-time behavior;
- the need for an updated `pi-subagents` build when configuring subagent
  `thinking: "max"`.

The `pi-subagents` PR includes its focused compatibility note or changelog
entry only if that repository's contribution conventions require it.

## Acceptance Criteria

1. A Pi-valid commented/trailing-comma `models.json` loads and can be edited
   without dropping unrelated native fields.
2. A malformed `models.json` is never overwritten.
3. Activation does not call `pi.registerProvider()` for native configuration.
4. The editor can add `max`, manage cost tiers, and create or update every
   listed compatibility field.
5. Configured payload parameters reach only their selected model's provider
   request and never appear in native `models.json`.
6. `pi-subagents` accepts and forwards `max` while preserving other levels.
7. New focused tests pass; project checks pass; final diffs are reviewed; the
   Model Config release and the Subagents PR branch are committed and pushed.
