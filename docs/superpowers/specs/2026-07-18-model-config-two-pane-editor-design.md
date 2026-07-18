# Pi Model Config Two-Pane Editor Design

**Status:** User-approved design, revised after independent review, pending re-review
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
- Stored literal API keys are masked, retaining only a short non-sensitive
  suffix. Environment references and command references may be shown unchanged.
- Selecting API Key first offers keep, replace, and clear actions. Replace opens
  an empty Pi input and never pre-fills the stored value. Pi's native input has
  no password mode, so characters typed during that explicit replacement are
  the one visible-entry exception; the UI warns about this before entry.

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

- `types.ts` replaces `Record<string, Partial<ModelConfig>>` with a dedicated
  `ModelOverrideConfig` matching Pi's documented override subset.
- `provider-editor.ts` defines Provider categories, field descriptors, edit
  actions, creation, rename, copy, delete, and Model discovery routing.
- `model-editor.ts` defines full Model descriptors plus a separate restricted
  Model Override descriptor set. It owns Model edit actions, creation, rename,
  copy, and delete.
- `field-editors.ts` contains shared object editors and value collection for
  headers, compat data, thinking maps, costs, and other nested structures.
- `config-validation.ts` validates the complete post-edit candidate against
  Pi's known native field shapes and cross-field rules before a native write.
- `payload-coordinator.ts` owns atomic writes, the cross-process mutation lock,
  multi-file transaction journals, request-time transaction resolution, and
  crash recovery.
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
opens a keyed list. Each entry uses a dedicated restricted descriptor set that
matches Pi's `ModelOverrideSchema`; it does not reuse the unrestricted Model
catalog.

An override may expose only:

- target Model ID as the record key, never as a stored `id` property;
- `name`;
- `reasoning`;
- `thinkingLevelMap`;
- `input`;
- partial `cost`, including optional rates and tiers;
- `contextWindow`;
- `maxTokens`;
- `headers`;
- `compat`.

Absent values display as inherited and only explicitly set fields are
persisted. Override entries can be added, renamed, or deleted with collision
and destructive confirmations. The editor must never introduce `api`,
`baseUrl`, `id`, or private Payload fields into an override.

A pre-existing override key outside this allowlist is preserved while merely
viewing or cancelling. Normal save is blocked and lists each unsupported path.
The user may explicitly choose `Remove unsupported fields and save`; only that
confirmation prunes the listed keys. This is the sole exception to unknown-field
preservation, because the cleanup is deliberate and previewed rather than a
side effect of editing another field.

### Compatibility

- Compat

The existing compatibility field set remains available. It uses a local draft
and explicit save/discard actions while preserving unknown compat fields.

### Actions

- Copy Provider
- Delete Provider

Provider ID editing is a rename operation. It validates uniqueness and uses the
journaled commit protocol defined under Native and Private Payload Transactions.

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

Model ID editing is a rename operation. It validates uniqueness and uses the
journaled commit protocol defined under Native and Private Payload Transactions.

## Creation Flows

New objects use short wizards rather than the settings panel's immediate-save
contract before an identity exists:

- Provider: ID, Base URL, API type, then create.
- Model: ID, then create with the extension's Pi-compatible defaults.

The object is not written until the wizard's required values are valid and
confirmed. Immediately before writing, creation re-reads native configuration
and rejects an existing Provider key or same-Provider Model ID without mutation.
After creation, the corresponding two-pane panel opens at General. An empty
Provider may suggest endpoint Model discovery, but discovery is never forced as
part of creation.

Provider and Model copy ask for a target ID, pre-filled with a `-copy` suffix.
They re-read configuration and reject an occupied target rather than overwrite
or append a duplicate. The user may choose another target and retry.

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

Each nested editor records a deep baseline of its exact stored subtree when it
opens. Before save it re-reads that subtree and compares it with the baseline.
If another process changed the same object, save is blocked; the user may reload
the external value and discard the draft, or return to the draft without
writing. Changes elsewhere in the configuration do not conflict. The conflict
scope is the entire edited object: one headers map, compat object, thinking map,
cost object, Provider's Model Overrides map, or exact Model payload object.

### Full-Candidate Validation and Preservation

Before every native save, the controller re-reads `models.json`, locates the
target by stable identity, applies only the confirmed patch, and validates the
complete resulting candidate. Validation mirrors Pi's known Provider, Model,
Model Override, cost, thinking, headers, and compat shapes plus Pi's cross-field
rules. In particular, a non-built-in Provider with Models requires `baseUrl`
and an API at Provider level or on every Model. A Provider with no Models must
retain at least one of `baseUrl`, `headers`, `compat`, or a non-empty
`modelOverrides` map. An invalid clear or patch is rejected before writing and
leaves storage unchanged.

If another process removed or renamed the target, the operation stops, reports
the conflict, and refreshes the panel. Unknown future fields remain preserved
and are not rejected solely for being unknown; the validator checks every known
field it encounters and all cross-field invariants affected by the candidate.

### Native and Private Payload Transactions

The private payload config schema remains unchanged. Coordination uses two
implementation-private artifacts beside it:

- a cross-process lock record containing an opaque owner token, local process
  identity, and process-start evidence when the platform exposes it;
- `model-config-transaction.json`, an atomically written recovery journal.

The lock has no time-based stale takeover. An owner that is alive but paused can
never lose ownership. Automatic recovery is allowed only when a platform
adapter positively proves that the recorded local process cannot resume. An
unknown liveness result or possible PID reuse remains locked and requires
explicit operator recovery rather than guessing that the owner is dead.

Dead-owner recovery uses an atomic token-checked claim: contenders compete to
move the exact observed owner record into one unique recovery claim, acquisition
checks for a claim both before and after creating a successor record, and only
the claim winner may install the next owner token. A token mismatch aborts the
claim. No contender unlinks a path by filename after merely observing staleness.
A dead-owner lock with no journal has no recoverable transaction; the claim
winner validates both current files and then releases its successor lock.

Every extension mutation re-reads both files after ownership, revalidates its
baselines and candidate, and verifies the same owner token immediately before
each journal, native, and payload replacement. Token loss stops before that
write and leaves any existing journal for recovery. Release is bound to the
same token. These checks fence externally replaced ownership, while the
proof-of-death rule ensures a former automatic owner cannot resume after a
successful takeover. A live owner causes a no-write "operation in progress"
result with a retry action.

Human confirmation is never awaited while holding the lock. A preview records
native and payload hashes; after confirmation, the operation acquires the lock,
re-reads both files, and commits only if the hashes and previewed identity set
still match. Otherwise it releases the lock and returns to a refreshed preview.
This applies to payload edits, unsupported-override cleanup, payload-identity
reuse/removal, and endpoint discovery. Each native, payload, and journal write
uses a temporary file in the same directory followed by atomic replacement. A
transaction that changes both native identities and private payload entries
proceeds as follows:

1. Compute complete validated native and payload candidates in memory.
2. Write a journal containing a unique operation ID, before/after native hashes,
   before/after payload hashes, and the complete payload document in both before
   and after states. Journal payload values receive the same file protection as
   private config and never appear in logs or error text.
3. Atomically write the native candidate.
4. Atomically write the private payload candidate.
5. Atomically remove the journal and release the owner-bound lock handle.

`before_provider_request` never acquires or waits on the mutation lock. It uses
at most three immediate stable-snapshot attempts. One attempt reads journal,
native, and payload bytes, then re-reads native and payload hashes and the
journal. It accepts the attempt only when both journal reads represent the same
absence or the same unique operation ID and bytes, and both file hashes remained
unchanged. Consecutive transactions, journal creation/removal, or a file change
causes retry. If three attempts remain unstable, the hook fails closed for that
request and emits only a non-secret diagnostic.

For an accepted snapshot with no journal, the hook uses the payload document it
read. With a valid journal, the native hash must match the journal's before or
after hash and the hook uses the corresponding complete journal payload view;
it does not mix that view with the persisted payload file. A stable malformed
journal, malformed payload without a valid journal, or native hash matching
neither journal side fails closed for all extension payload injection. This
point-in-time protocol remains coherent for current-session Models, built-in
fallback Models, dynamically registered Models, and journal boundaries.

Recovery paths that require no choice run to completion under the owner-bound
lock: when a valid journal's native hash equals `before`, restore the complete
before payload snapshot and report rollback; when it equals `after`, restore
the complete after snapshot and report roll-forward. Either path quarantines a
malformed current payload when necessary, removes the journal, and checks the
owner token before each write.

Every recovery requiring human choice uses the same two-phase protocol:

1. Acquire the lock, read exact journal/native/payload bytes and parse states,
   derive the available choices, record a recovery snapshot token containing
   their hashes and journal operation ID when present, then release the lock.
2. Show the recovery screen without a lock.
3. After confirmation, reacquire the lock and re-read all three artifacts. Apply
   the choice only if the exact snapshot token and parse states still match;
   otherwise release without writing and return to a refreshed recovery preview.

This protocol governs a valid journal whose native hash matches neither side,
a malformed journal, and a malformed payload with no journal. A mismatched valid
journal keeps payload injection and mutations blocked; the user may select the
full before or after payload snapshot, but recovery never overwrites native
configuration.

A malformed journal cannot identify affected fields, so all extension payload
injection and editor mutations remain blocked. If current native and payload
files are valid, the user may explicitly accept them as authoritative and
quarantine the malformed journal. If native configuration is invalid, recovery
remains blocked until it is repaired externally. If payload storage is malformed,
the user may remain blocked or explicitly quarantine it and initialize an empty
payload document; this is the only path allowed to replace unreadable payload
storage without a valid journal snapshot. Quarantine uses an atomic timestamped
rename, retains private file protections, and never displays payload contents.

There is no generic "orphan" inference or registry-based cleanup. Existing
unrelated private keys remain untouched. If create, rename, or copy finds a
pre-existing payload at a target identity that is not the operation's source,
it performs no write; reuse or removal requires a separate previewed confirmation
under the same lock.

## Endpoint Model Discovery

`Fetch Models from endpoint` is always present in the Provider's Models
category. The existing discovery request contract remains:

- use the current Provider Base URL and credential resolution behavior;
- try `{baseUrl}/models`, then `{baseUrl}/v1/models`;
- accept the response formats already supported by the extension;
- time out and report failure without changing configuration.

Before presenting choices, discovery normalizes records as follows:

- for each object record, trim a string `id` first and use it only when the
  trimmed result is non-empty; otherwise trim a string `name` and use that as
  the fallback ID only when non-empty;
- retain an optional display name only when its trimmed result is non-empty;
- discard malformed records and report the skipped count;
- deduplicate by normalized ID in endpoint order, keeping the first record;
- treat an all-invalid result as fetch failure with no choice dialog or write.

After successful normalization, the UI shows the source endpoint, valid count,
skipped/duplicate counts, and an ID summary, then offers:

- `Merge`: keep every existing Model object unchanged and append only IDs that
  are not already present;
- `Replace`: require a second confirmation, replace the native list, and remove
  private payload entries for Models no longer present;
- `Cancel`: write nothing.

After Merge or Replace is chosen, discovery previews introduced IDs and any
exact private payload identities. Reuse requires explicit `Reuse existing
payloads` confirmation. After confirmation it acquires the shared lock, re-reads
both files, and recomputes the candidate and collision list; any mismatch
returns to a refreshed preview instead of writing. Cancelling performs no native
or private write. This check applies equally to Merge and Replace and occurs
before journal creation.

Endpoint records are treated as discovery data, not authoritative replacements
for hand-edited records with the same ID.

## Errors and Safety

- Malformed or blank native configuration is never overwritten.
- File, parse, full-candidate validation, nested-conflict, transaction-recovery,
  and collision errors name the affected object and provide a recovery action.
- Destructive delete, unsupported-override cleanup, payload-identity resolution,
  transaction recovery, and endpoint replacement are explicit confirmation
  paths.
- Create, copy, and rename collision rejection never mutates native or private
  storage.
- Stored API key literals do not appear in panel rows, notifications, test
  snapshots, error messages, or replacement-input initial values. User-typed
  characters are visible only during the warned native-input replacement step.
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
- complete-candidate validation and rejection of cross-field-invalid clears;
- unknown field preservation after every supported patch;
- complete pricing, thinking-map `max`, headers, and endpoint overrides;
- the exact Model Override allowlist, persisted-output pruning only after
  explicit confirmation, and absence of `api`, `baseUrl`, `id`, and private
  Payload descriptors from normal output.

### Controller and Nested-Editor Tests

- simple edit confirmation and cancellation;
- nested draft save and discard;
- optimistic same-subtree conflict rejection for headers, compat, thinking map,
  cost, Model Overrides, and Payload;
- Provider/Model rename, delete, and copy transactions with injected failure or
  crash after journal creation, native replacement, payload replacement, and
  journal removal;
- stable hook snapshots across journal creation/removal and consecutive
  transactions, including retry exhaustion and fail-closed behavior;
- before/after request-hook resolution for current-session Models, built-in
  fallback identities, and dynamically registered identities;
- cross-process lock exclusion, simultaneous dead-owner claim contenders,
  paused-live-owner takeover refusal and safe resume, dead-owner-lock-without-
  journal handling, and owner-bound release;
- a simulated former owner whose token was externally replaced attempts native
  step 3 and payload step 4 writes and is fenced before both replacements;
- valid-journal recovery with a malformed current payload, malformed-journal
  quarantine with valid files, malformed-payload quarantine/reset, and invalid
  native recovery blocking;
- concurrent changes between manual recovery preview and confirmation for both
  valid mismatched and malformed journals, requiring refresh without write;
- stale-target refresh after an external modification;
- creation wizard minimum fields, post-create panel state, and collision
  rejection without mutation;
- copy target collision rejection without mutation;
- stored API Key values are never pre-filled and the active-entry warning is
  shown;
- destructive confirmations.

### Endpoint Discovery Tests

- the endpoint action remains available with zero or many Models;
- timeout, HTTP failure, unsupported shape, empty response, and all-invalid
  records do not mutate configuration;
- malformed and whitespace-only IDs/names are skipped, fallback occurs only
  after trim, empty optional names are omitted, and duplicate normalized IDs
  keep the first endpoint record;
- merge preserves existing same-ID Model objects, appends each new ID once, and
  updates its seen-ID set while processing;
- Merge and Replace revalidate introduced IDs under the lock and require
  explicit confirmation before reusing any exact private payload identities;
- replace requires confirmation and commits native/payload changes through the
  same journal; injected failures preserve the before or after request view;
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
   editable, while unknown fields remain intact; Model Overrides emit only
   Pi's documented subset and remove unsupported stored keys only after an
   explicit previewed confirmation.
7. Every native write validates the complete post-edit candidate and rejects
   Pi-invalid cross-field states without mutation.
8. Nested saves reject same-subtree concurrent changes rather than overwriting
   them.
9. `Fetch Models from endpoint` remains available and satisfies the specified
   normalization, deduplication, merge, replace, cancel, and failure behavior.
10. Create, copy, and rename reject all target collisions without mutation.
11. Journaled cross-file operations and stable hook snapshots preserve a
   coherent before or after payload view under injected failures, crashes,
   built-in fallback, current-session Models, dynamic registrations, and
   concurrent editor processes; malformed storage has an explicit quarantined
   recovery path.
12. Wide terminals use two panes and narrow terminals remain fully operable.
13. Stored API key literals are masked outside the explicitly warned active
   replacement input and are never pre-filled.
14. New focused tests, the full existing test suite, and syntax checks pass.
