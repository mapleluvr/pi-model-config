# Task 4 Report: Centralize Model Config Mutations

## Result

DONE.

## Commit

`23a6d8c refactor: centralize model config mutations`

Parent baseline for Task 4 implementation: `ef9ef61` (pre-Task-4 code). HEAD before this commit was `67b5d7f` (docs-only file-ownership plan correction).

## Committed Files

- Create: `config-actions.ts`
- Modify: `model-fields.ts`
- Modify: `payload-config.ts`
- Modify: `index.ts`
- Create: `tests/config-actions.test.ts`
- Modify: `tests/model-fields.test.ts`
- Modify: `tests/payload-config.test.ts`
- Modify: `tests/index-runtime.test.ts`
- Modify: `package.json`

No edits under `docs/`, plan/ledger, or `.pi-subagents/`. The requested report is intentionally untracked so the commit remains limited to the Task 4 allowlist.

## RED Evidence

Command:

```bash
node --experimental-strip-types --test tests/config-actions.test.ts
```

Initial RED state was established by writing `tests/config-actions.test.ts` against the missing `config-actions.ts` module (`ERR_MODULE_NOT_FOUND` / absent transactional domain API). After scaffolding the module, focused failures drove implementation of subtree deep-clone, lock result mapping, journal boundary coherence, and non-secret result contracts.

## GREEN Evidence

Focused command:

```bash
node --experimental-strip-types --test tests/config-actions.test.ts
```

Exit status: `0` (14/14).

Coverage includes:

- simple patch false/zero preservation and explicit clear
- unknown field preservation
- stable Provider key / Model ID lookup (not array index)
- stale-target and full-candidate validation-error with zero writes
- nested subtree conflict only for the exact edited subtree; unrelated subtree edits succeed
- create/copy native-collision with zero writes
- target payload-collision requiring explicit `replace-target` resolution
- identity commit hash/identity-set revalidation returning stale-target on drift
- Provider rename carrying every model payload in one journaled transaction
- legacy native `extraPayload` migration only on successful previewed model transaction
- distinct `lock-busy` / `lock-collision` / `lock-unsupported` zero-write results
- injected journal-step failure with request resolution exactly before or after
- recovery-required when storage is not mutation-ready
- EditorSnapshot deep clones and non-secret diagnostic results

Adjacent focused suite:

```bash
node --experimental-strip-types --test tests/config-actions.test.ts tests/model-fields.test.ts tests/payload-config.test.ts tests/index-runtime.test.ts
```

Exit status: `0` (45/45).

## Regression And Syntax Evidence

```bash
npm test
npm run check
git diff --check
```

All commands exited `0`.

`npm test` completed with **155** passing tests and **0** failures. `npm run check` parses `config-actions.ts` and `model-fields.ts` alongside every existing runtime module.

`git diff --stat ef9ef61..HEAD` shows Task 4 sources plus the pre-existing docs ownership commit (`67b5d7f`); the Task 4 commit itself touches only the nine allowlisted paths.

## Implementation Summary

### `ModelConfigActions` (`config-actions.ts`)

- Constructed with coordinator options, optional validation options, and injectable `commitMutation` for lock/fault tests.
- Read API: `readEditorSnapshot()` returns deep-cloned native/payload documents and hashes.
- Simple APIs: `patchProvider`, `patchModel`, `createProvider`, `createModel`.
- Nested APIs: `saveProviderSubtree`, `saveModelSubtree`, `saveModelPayload` with deep baselines.
- Identity APIs: two-phase `preview*IdentityAction` / `commit*IdentityAction` for Provider and Model rename/copy/delete.
- Results typed as: `success`, `stale-target`, `validation-error`, `subtree-conflict`, `native-collision`, `payload-collision`, `preview`, `lock-busy`, `lock-collision`, `lock-unsupported`, `recovery-required`.
- Every mutation routes through `commitCoordinatedMutation`; fresh under-lock lookup by Provider key / Model ID; full-candidate validation before write.

### `model-fields.ts`

- Added `deepCloneJson`, `deepEqualJson`, subtree read/write helpers for optimistic nested baselines.

### `payload-config.ts`

- Removed all Task-3 direct-writer compatibility exports (`getModelPayload`, `setModelPayload`, `removeModelPayload`, `copyModelPayload`, `moveModelPayload`, `copyProviderPayloads`, `moveProviderPayloads`, `removeProviderPayloads`).
- Retained pure parse/serialize/clone/lookup/transform APIs only.
- Added pure `copyProviderPayloadDocumentValues` / `moveProviderPayloadDocumentValues`.

### `index.ts`

- All Provider/Model save and payload lifecycle paths await `ModelConfigActions`.
- Removed controller imports/calls to `writeModelsConfig` and direct payload writers.
- Preserved old prompt sequences; surfaces non-secret failure types without partial writes.
- Identity ops use preview then commit; payload collisions never overwrite implicitly.

### Tests

- `tests/config-actions.test.ts`: full transactional domain suite (RED→GREEN).
- `tests/payload-config.test.ts`: pure transforms only (no direct writers).
- `tests/index-runtime.test.ts`: seeds/asserts via pure transforms + coordinated UI path.
- `tests/model-fields.test.ts`: clone/equality/subtree helpers.

## Self-Review

- No direct filesystem mutation remains on the UI write path for Provider/Model/payload lifecycle.
- No bypass payload writer API remains in `payload-config.ts`.
- Identity operations revalidate native/payload hashes and identity sets under lock before commit.
- Target payload reuse/removal is never inferred; collisions return `payload-collision` until an explicit resolution is previewed.
- Legacy `extraPayload` is stripped/migrated only inside the successful model transaction that previewed it.
- Lock results preserve coordinator `busy` / `collision` / `unsupported` as distinct `lock-*` outcomes with unchanged bytes.
- Action results and tests avoid embedding secret/private payload literals in diagnostic result types (snapshots may carry editor values by design; errors/locks do not).
- Request resolution after injected journal/native boundary failure remains exactly one coherent side.

## Residual Risks

- Endpoint discovery still uses `patchProvider({ models })` without Task 5 collision previews for introduced IDs; Task 5 owns that surface.
- Old UI still uses sequential prompts; panel replacement (later tasks) will consume the same `ModelConfigActions` contracts.
- Provider same-ID edit patches a managed field set reconstructed from the form result rather than a raw whole-object replace API; unknown top-level provider keys that the form never rehydrates could theoretically be cleared if the form produced a sparse object. Current `editProvider` merges from the existing base, so unknown keys are retained.
- Payload-collision resolution UX in the old UI only notifies; explicit replace/reuse dialogs arrive with the two-pane controllers.

## Recommended Next Step

Task 5: normalize and transact endpoint Model discovery through `ModelConfigActions.previewEndpointChange` / `commitEndpointChange`.

---

## Follow-up Review Fix Commit

### Commit

`8c08c6c fix: harden model config identity and patch safety`

### Finding → Fix Mapping

1. **Provider identity union (native + payload-only tuples)**
   - `collectProviderSourceIdentities` unions native model IDs with `providerPayloadIdentities` exact JSON tuples.
   - Rename/copy/delete disclose, move/copy/remove that union; slash IDs covered in tests.

2. **`reuse-target` absolute preservation**
   - `applyPayloadDisposition` / `migrateProviderLegacyPayloads` never overwrite target when `reuse-target` even if explicit payload/null is present.
   - Rename removes source only; copy retains source+target. `replace-target` overwrites with source/new semantics. Tests cover both.

3. **Opaque bound preview tokens**
   - Public `IdentityPreviewToken` is a `string` UUID.
   - Private `Map` holds deep-cloned request, hashes, identity set, collisions, resolution.
   - Commit uses only bound state; unknown/forged tokens → `stale-target`.
   - Public preview/descriptor is secret-free; resolved previews carry exact collisions (not hard-coded empty).

4. **No stale full-object overwrite**
   - Provider/Model identity uses `providerPatch`/`modelPatch` + optional `fieldBaselines`.
   - Under lock, merge into fresh source; concurrent models/headers/unknowns preserved.
   - Same-ID Provider patch never sends `models` (stripped unless explicit endpoint models patch).
   - Field baseline drift → `subtree-conflict`. Index uses managed patches + baselines.

5. **Unique Model IDs in validation**
   - `config-validation.ts` rejects duplicate IDs within a Provider.
   - `createProvider` with duplicates → `validation-error`, zero write.

6. **Secret-free ActionResult diagnostics**
   - `stale-target` / `subtree-conflict` carry hashes/path/refreshed sanitized preview only — never `EditorSnapshot`/native/private docs.
   - Tests recursively assert non-success diagnostics lack secret markers.

7. **Legacy `extraPayload` lifecycle**
   - Provider rename/copy strip target native `extraPayload` and migrate legacy → private with private-existing precedence.
   - Model copy migrates legacy to target private (not only strip).
   - Collision/stale/lock failure → zero migration/removal.

8. **Commit drift → refreshed preview**
   - Identity commit revalidates under lock; on hash/identity drift rebuilds bound preview and returns `stale-target` with sanitized `preview` + new token; no write.
   - Removed unused `preferRefreshedStale`.

9. **Order-insensitive deep equality**
   - `deepEqualJson` compares plain objects by key set (order-insensitive); arrays remain order-sensitive.

10. **All four journal boundaries via ModelConfigActions**
    - Injected faults at `journal`, `native`, `payload`, `journal-removed`; request resolution is exactly before or after.

### RED / GREEN Evidence (follow-up)

```bash
node --experimental-strip-types --test tests/config-actions.test.ts
# GREEN: 23/23

node --experimental-strip-types --test tests/config-actions.test.ts tests/model-fields.test.ts tests/payload-config.test.ts tests/index-runtime.test.ts tests/config-validation.test.ts
# GREEN: 62/62 (later 63 with unique-id validation test)

npm test
# GREEN: 165/165

npm run check
git diff --check
# GREEN
```

### Residual Risks After Follow-up

- Endpoint discovery still patches `models` explicitly (Task 5 collision previews).
- Old UI still only notifies on payload-collision (no replace/reuse dialogs); action contracts are complete for later panels.

## Second re-review follow-up

### Result

DONE.

### Commit

`73afaaa`

### Finding → fix mapping

| # | Finding | Fix |
|---|---------|-----|
| 1 | Own-key-safe Provider/payload maps for `__proto__`/`constructor`/`prototype` | Added `own-keys.ts` (`hasOwnKey`/`getOwnValue`/`setOwnValue`/`deleteOwnKey`/`emptyOwnMap`). Applied in `config-actions`, `payload-config`, `config` lookup/set/delete. Shielded `jsonc-parser` `__proto__` keys in `parseModelsDocument` via sentinel restore. Tests: create/read/patch/rename for prototype-looking Provider IDs and payload tuples. |
| 2 | Legacy `extraPayload` is array rows | Centralized `parseLegacyExtraPayload` matching UI row schema (`string`/`bool`/`json`). Object shapes invalid. Identity ops reject invalid legacy when it is the only migration source (zero-write); field save may strip after UI warn. Fixtures updated to real rows. |
| 3 | Provider previews disclose legacy delimiter keys | Exported `listProviderPayloadIdentities` from `payload-config` (tuples + unambiguous `provider/model` legacy). Shared by preview and cleanup. Ambiguous multi-slash keys inert. |
| 4 | `createProvider` payload collisions | Detects payload-only targets for every introduced Model; requires `reuse-target`/`replace-target`; never attaches private payloads implicitly. |
| 5 | `replace-target` clears absent source | `applyPayloadDisposition` removes collided target when no source/new payload; reuse absolute; createModel replace without payload clears target. |
| 6 | Bound preview TTL/capacity/discard | Injectable `now`, `previewTtlMs` (5m), `maxPreviews` (32), `discardIdentityPreview`, prune on bind/take; consume token on every terminal commit attempt. |
| 7 | Secret-free assertion messages | Diagnostics assert only type/booleans; validation reasons omit private field names/values. |

### RED → GREEN evidence

- Focused `tests/config-actions.test.ts`: 29/29 pass after RED failures on prototype parse, legacy format, create collisions, TTL, replace-absent.
- Adjacent: payload-config, model-fields, validation, index-runtime, coordinator pass.
- `npm test`: 171/171
- `npm run check`: pass
- `git diff --check`: pass

### Prior closures preserved

Opaque tokens, field baselines, payload-only tuples, reuse absolute, legacy precedence, refreshed preview, secret-free public objects, unique IDs, fault boundaries, direct-writer removal.


## Third re-review follow-up

### Result

DONE.

### Commit

`713cee4`

### Finding → fix mapping

| # | Finding | Fix |
|---|---------|-----|
| 1 | No textual `__proto__` sentinel | `parseModelsDocument` uses `parseTree` + recursive `materializeJsoncNode` with `setOwnValue`. Tests: literal, unicode-escaped, `__mc_own_proto__`, nested, roundtrip. |
| 2 | Malformed legacy never silent-vanish | `LegacyDiscardResolution = "discard-malformed-legacy"` required on every touch (patch/rename/copy/create/provider identity). Bound into preview token. Controller confirms; cancel preserves. |
| 3 | Valid legacy migrates on create | createProvider/createModel: no collision → write private+strip; reuse → keep target; replace → write legacy (or clear if none). |
| 4 | `provider/` empty model id | `listProviderPayloadIdentities` includes `[provider, ""]`; cleanup/rename/copy/delete agree. Ambiguous multi-slash inert. |
| 5 | Physical TTL without later API call | Injectable schedule/cancel, nearest-expiry timer, unref, reschedule on bind/take/discard, clear when empty. Commit token forget in `finally`. |
| 6 | No private values in assertion messages | Fault boundary message reports only booleans/types. |

### RED → GREEN

- config-actions + config + payload-config + index-runtime expanded tests pass
- `npm test`: 176/176
- `npm run check`: pass
- `git diff --check`: pass


## Fourth re-review follow-up

### Result

DONE.

### Commit

`fc9b8c2`

### Finding → fix mapping

| # | Finding | Fix |
|---|---------|-----|
| 1 | `patchProvider({models})` bypassed legacy/payload safety | Dedicated `buildProviderModelsPatch`: malformed requires discard; valid legacy migrates with private precedence; removed models preserve/migrate private; new payload-only collisions need reuse/replace. Endpoint path confirms discard. |
| 2 | `patchModel` must auto-migrate valid legacy | On strip: explicit payload/null wins; else private wins; else write migrated legacy. Malformed still needs discard. |
| 3 | Controller discard for provider rename/copy/delete/models | `confirmLegacyDiscard` + `providerHasMalformedLegacy` wired on delete/copy/rename/endpoint models patch; cancel preserves bytes. |
| 4 | Own-key-only root schema access | config.ts providers via hasOwn/getOwnValue; payload-config own version/extraPayloads; validation own providers. Pollution probes with finally cleanup. |
| 5 | Unicode escape regression | `String.raw` JSON escapes + simultaneous sentinel + roundtrip. |

### RED → GREEN

- Expanded config/config-actions/payload-config tests
- `npm test`: 181/181
- `npm run check`: pass



## Follow-up 5 — bound simple-action resolution tokens (2026-07-18)

### Finding → fix

1. **Bare simple resolutions unsafe** → `createProvider` / `createModel` / `patchProvider({models})` / `patchModel` now bind opaque `resolutionToken`s on first collision/malformed result (deep-cloned request + native/payload hashes + exact collisionSet + malformedSet). Retry requires token + selected resolution; caller-mutated request fields ignored; under-lock revalidation; bare resolution without token → `stale-target` zero write; drift → refreshed token / stale; take-simple consumes token; TTL/capacity/scheduler shared with identity previews. Old UI uses `completeSimpleAction` (confirm discard + notify-only collisions).
2. **`writeModelsConfig` own providers** → rejects inputs lacking own `providers` before merge; pollution regression with try/finally.
3. **Empty legacy `[]`** → `parseLegacyExtraPayload` treats `[]` as valid empty; strip-only, never create empty private identity.

### RED → GREEN

- RED: bare `payloadCollisionResolution` retries now fail; empty-legacy / writeModelsConfig pollution gaps.
- GREEN: token-first retries; drift/forged token tests; empty `[]` regression; `writeModelsConfig` pollution test.
- Validation: focused actions+config green; full `npm test` 183/183; `npm run check` + `git diff --check` pass.


## Follow-up 6 — final review (2026-07-18)

### Finding -> fix

1. **Inherited nested validation** -> `materializeOwnOnly` + own-key field access in `validateModelsCandidate`; prototype pollution cannot satisfy baseUrl/api/models.
2. **Legacy row parser** -> require own `key`/`type`/`value`; polluted `{}` rows malformed, zero-write, no private migration.
3. **Exact subtree baseline** -> `describeSubtreePresence` / `subtreePresenceEqual`; absent, null, `{}` distinct for provider/model subtrees.
4. **Simple-action drift** -> always `stale-target` + fresh `resolutionToken` when requirements remain; no either/or; new confirm required.
5. **Identity drift** -> always stale with refreshed preview; `clearIdentityResolutions` so old replace/discard cannot auto-apply.
6. **Model delete** -> malformed check before mutation; `legacyDiscardResolution` on delete; controller confirm/cancel.
7. **completeSimpleAction** -> discard on same `ModelConfigActions` instance that created the token.
8. **patchProvider non-models** -> reject resolutionToken/collision/discard flags as stale zero-write.

### RED -> GREEN

- RED: inherited prototype validation; polluted empty legacy rows; absent vs {}; either/or drift; model delete without discard; wrong-instance discard; non-models resolution flags.
- GREEN: expanded focused suites; full `npm test` 192/192; `npm run check` + `git diff --check` pass.
