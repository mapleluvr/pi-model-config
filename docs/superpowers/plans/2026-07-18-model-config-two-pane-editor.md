# Pi Model Config Two-Pane Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release `pi-model-config` 1.2.0 with directly addressable Provider and Model settings, responsive two-pane navigation, complete common Pi fields, preserved endpoint discovery, and crash-coherent native/private payload writes.

**Architecture:** Keep `index.ts` as the extension entry point and top-level router, move field catalogs and controller loops into Provider/Model modules, and render both through one I/O-free `TwoPaneSettingsPanel`. Put all persistence behind candidate validation, atomic file primitives, a process-owner lock, and a journaled payload coordinator; UI controllers submit semantic patches and never coordinate files themselves.

**Tech Stack:** Node.js 22 TypeScript with native type stripping, Node built-in test runner, `jsonc-parser@3.3.1`, `@earendil-works/pi-coding-agent@0.80.6` extension API, and `@earendil-works/pi-tui@0.79.1` components/utilities.

## Global Constraints

- Work only in `D:/Projects/PiAgent/plugins/model-config/.worktrees/model-config-v1.1` on branch `codex/model-config-v1.1`.
- The approved source of product behavior is `docs/superpowers/specs/2026-07-18-model-config-two-pane-editor-design.md`; this plan must not weaken its safety or interaction contracts.
- User-visible labels remain Chinese; native field identifiers may appear beside them where useful.
- Do not add emoji to source, tests, or documentation.
- Existing Provider/Model objects open the settings panel; new objects use only the approved minimal wizard and then open the panel.
- Do not add a raw full-Provider, full-Model, or full-file JSON editor.
- Editing Provider API/Base URL never implicitly propagates values into child Models; only the selected field or subtree changes.
- Simple confirmed fields save immediately; Headers, Model Overrides, Thinking Level Map, Cost, Compat, and Payload use explicit save/discard drafts.
- Wide mode starts at exactly 88 columns; narrower terminals remain fully operable in single-pane mode.
- Unknown fields are preserved unless unsupported Model Override paths are explicitly previewed and confirmed for removal. Every nested editor patches a deep clone of the exact stored subtree so unknown keys in Cost, individual tiers, Thinking Map, Headers, Compat, Payload, and allowed Override objects survive known-field edits.
- Every native write validates the full post-patch candidate against the Pi 0.80.6 shapes and cross-field rules before replacement.
- Do not call `pi.registerProvider()` to replay `models.json`; Pi's native ModelRegistry remains authoritative.
- Do not change the native `models.json` schema or private `model-config-payloads.json` schema.
- Mutation authority is an OS-owned local IPC endpoint: Windows named pipe, Linux abstract UDS, or one deterministic macOS loopback port with full-hash identity handshake. There is no persisted lock, stale takeover, boot/PID inference, claim, or force-unlock path.
- Never wait for human input while holding the mutation lock; confirmation uses preview hashes followed by lock-time revalidation.
- Payload values and literal API keys never appear in logs, notifications, errors, snapshots, or pre-filled replacement inputs.
- Endpoint discovery keeps the existing URL probing, credential resolution, and 15-second request timeout contract.
- Preserve Subagent settings scope, sync, tools metadata, and current UI behavior unchanged.
- Non-TUI invocation reports that `/model-config` requires TUI mode and performs no mutation.
- Follow TDD for every behavioral task and commit each completed task before review or handoff.

---

## File Map

| File | Responsibility |
|---|---|
| `atomic-file.ts` | Hash raw artifacts, preserve absent-file identity, write same-directory temporary files, fsync, atomically replace/remove, and quarantine malformed storage. |
| `config-validation.ts` | Validate every known Provider, Model, Model Override, cost, thinking, headers, and compat field plus Pi 0.80.6 cross-field rules while allowing unknown future fields. |
| `config.ts` | Parse/serialize JSONC native config and delegate durable replacement to `atomic-file.ts`; no UI or payload knowledge. |
| `process-lock.ts` | Derive local IPC endpoint identities, acquire/release OS-owned mutation authority, serve non-secret handshakes, and fence writes after handle loss. |
| `payload-config.ts` | Parse/serialize/clone the unchanged private payload schema and provide pure identity transformations; direct uncoordinated writes are removed. |
| `payload-coordinator.ts` | Read coherent native/private snapshots, commit journaled mutations, resolve request-time payload views, and expose deterministic automatic/manual recovery APIs. |
| `config-actions.ts` | Provide Provider/Model CRUD, field/subtree patches, payload edits, collision previews, optimistic conflicts, and identity lifecycle operations to controllers. |
| `endpoint-models.ts` | Fetch, normalize, deduplicate, summarize, merge, and replace endpoint Model records without UI-specific persistence logic. |
| `settings-panel.ts` | Render and navigate the responsive, I/O-free two-pane settings component and return semantic actions plus restorable panel state. |
| `field-editors.ts` | Format values/secrets and run shared draft editors for string maps, Compat, Thinking Map, Cost, and Payload. |
| `model-editor.ts` | Define Model and restricted Model Override descriptors, run Model list/create/edit/copy/delete loops, and stage override entry edits. |
| `provider-editor.ts` | Define Provider descriptors and run create/edit/rename/copy/delete, Headers, Compat, Models, Overrides, and endpoint discovery flows. |
| `types.ts` | Hold native Provider/Model config and dedicated Model Override shapes; panel, lock, transaction, and action result types stay with their owning modules. |
| `index.ts` | Register the extension hook/command, reject non-TUI commands, show top-level menus/diagnostics, and delegate to domain controllers. |
| `tests/helpers/temp-agent-dir.ts` | Isolate `PI_CODING_AGENT_DIR` and restore environment reliably. |
| `tests/helpers/scripted-ui.ts` | Record prompts/notifications and return typed scripted panel, input, select, editor, and confirmation outcomes. |
| `tests/fixtures/lock-worker.ts` | Exercise real Node/Bun cross-process IPC ownership, pause, release, kill, and crash behavior. |
| `tests/fixtures/coordinator-worker.ts` | Exit at selected journal/native/payload boundaries to verify OS endpoint release and next-process recovery. |
| `tests/fixtures/manual-endpoint-server.ts` | Serve deterministic non-secret discovery records for controlled TUI verification. |
| `tests/fixtures/manual-agent-state.ts` | Seed isolated editor and recovery scenarios for controlled TUI verification. |
| `tests/fixtures/assert-package.ts` | Parse `npm pack --dry-run --json` and fail on missing runtime or included private/test artifacts. |
| `tests/atomic-file.test.ts` | Verify atomic replacement, mode handling, hashes, and injected pre-rename failures. |
| `tests/config-validation.test.ts` | Verify known shapes, cross-field constraints, override allowlist, and unknown-field preservation. |
| `tests/process-lock.test.ts` | Verify endpoint derivation, platform adapters, handshakes, real-process exclusion, crash release, fencing, and close behavior. |
| `tests/payload-coordinator.test.ts` | Verify journal boundaries, stable request snapshots, retries, recovery, malformed storage, and fail-closed behavior. |
| `tests/config-actions.test.ts` | Verify patch scope, optimistic conflicts, CRUD collisions, identity transactions, payload lifecycle, and failure injection. |
| `tests/endpoint-models.test.ts` | Verify endpoint probing, normalization, deduplication, merge/replace/cancel semantics, collisions, and failures. |
| `tests/settings-panel.test.ts` | Verify wide/narrow rendering, width bounds, focus/navigation, scrolling, search, cancellation, and state restoration. |
| `tests/field-editors.test.ts` | Verify formatting, API-key secrecy, draft save/discard, validation, and scripted nested editors. |
| `tests/model-editor.test.ts` | Verify Model/Override catalogs, panel routing, simple/nested edits, creation, collisions, and destructive actions. |
| `tests/provider-editor.test.ts` | Verify Provider catalog, panel routing, API key flow, Models actions, Overrides, endpoint discovery, and lifecycle actions. |
| `tests/index-runtime.test.ts` | Verify activation, hook integration, TUI gating, top-level routing, diagnostics/recovery entry, and legacy workflow removal. |
| `tests/no-emoji.test.ts` | Scan every new source/test/UI file for prohibited emoji ranges. |
| `tests/release-docs.test.ts` | Verify 1.2.0 metadata and English/Chinese documentation of the panel, endpoint, and transaction artifacts. |
| `package.json`, `package-lock.json` | Publish 1.2.0 metadata, explicit package contents, and syntax checks for every runtime module. |
| `.gitignore` | Exclude subagent review artifacts and generated package archives from worktree/package status. |
| `README.md`, `README-CN.md` | Document the new field-oriented workflow, responsive controls, data safety, discovery behavior, and recovery artifacts. |
| `LICENSE` | Provide the standard MIT license already linked by both READMEs and required by the package allowlist. |

---

### Task 1: Reject Pi-invalid candidates and make each artifact replacement atomic

**Purpose:** A confirmed patch can be evaluated as a complete Pi 0.80.6 candidate, and an interrupted single-file write cannot truncate or partially replace existing configuration.

**Files/modules:**
- Create: `atomic-file.ts`
- Create: `config-validation.ts`
- Modify: `config.ts`
- Modify: `types.ts`
- Create: `tests/atomic-file.test.ts`
- Create: `tests/config-validation.test.ts`
- Create: `tests/helpers/temp-agent-dir.ts`
- Modify: `tests/config.test.ts`
- Modify: `package.json`

**Interfaces and dependencies:**
- Produces `readArtifact(path): ArtifactSnapshot`, `hashArtifact(bytesOrAbsent): string`, `atomicReplace(path, bytes, options): void`, `atomicRemove(path): void`, and `quarantineArtifact(path, timestamp): string`.
- Produces `validateModelsCandidate(candidate, options): ValidationIssue[]` and `assertValidModelsCandidate(candidate, options): void`.
- `ValidationOptions` contains `builtInProviders: ReadonlySet<string>`; export the exact Pi 0.80.6 built-in provider set as the runtime default so tests can inject alternatives without importing Pi private modules.
- The pinned set is exactly: `amazon-bedrock`, `ant-ling`, `anthropic`, `azure-openai-responses`, `cerebras`, `cloudflare-ai-gateway`, `cloudflare-workers-ai`, `deepseek`, `fireworks`, `github-copilot`, `google`, `google-vertex`, `groq`, `huggingface`, `kimi-coding`, `minimax`, `minimax-cn`, `mistral`, `moonshotai`, `moonshotai-cn`, `nvidia`, `openai`, `openai-codex`, `opencode`, `opencode-go`, `openrouter`, `together`, `vercel-ai-gateway`, `xai`, `xiaomi`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, `zai`, and `zai-coding-cn`.
- Replaces `ProviderConfig.modelOverrides: Record<string, Partial<ModelConfig>>` with `Record<string, ModelOverrideConfig>` while retaining an index signature for previewed unsupported legacy top-level keys.
- `config.ts` remains the JSONC parser boundary and calls `atomicReplace` only after parsing the current file and validating the supplied complete candidate.

**Constraints and invariants:**
- Unknown root, Provider, Model, Model Override, and nested Compat fields survive read/patch/write unless explicitly removed by a supported action.
- Known optional strings must be non-empty when present; headers are string records; input values are only `text`/`image` and the editor contract requires at least one; explicit token limits are positive integers; rates are finite and non-negative; tier thresholds are positive integers.
- Model Override known keys are exactly `name`, `reasoning`, `thinkingLevelMap`, `input`, `cost`, `contextWindow`, `maxTokens`, `headers`, and `compat`.
- A custom Provider with Models requires `baseUrl`; every Model under a non-built-in Provider inherits or defines an API; an empty Provider retains at least one of `baseUrl`, `headers`, `compat`, or non-empty `modelOverrides`.
- Native file mode is retained when present. Private-artifact mode support is exposed for later tasks but no private schema changes here.

**Acceptance evidence:**
- RED: `node --experimental-strip-types --test tests/atomic-file.test.ts tests/config-validation.test.ts` -> fails because both modules and dedicated override type are absent.
- GREEN: the same command -> passes shape, cross-field, built-in/custom, override, unknown-field, atomic replacement, quarantine, and injected failure cases with zero failures.
- Regression: `npm test && npm run check` -> all existing tests and syntax checks pass.

**Risk and rollback:**
- Risk: an over-strict mirror could reject a file Pi accepts. Keep unknown fields permissive and version-pin only the known Pi 0.80.6 field/cross-rule catalog.
- Rollback: revert this commit; no persistent format or migration is introduced.

**Implementation intent:**
- [ ] Add failing tests for every known field family, malformed known values, built-in/custom cross-rules, empty Providers, and unknown-field retention.
- [ ] Add failing atomic I/O tests that preserve old bytes when a fault is injected before rename and leave no temporary file after cleanup.
- [ ] Define `ModelOverrideConfig` and partial override cost types without exposing `id`, `api`, `baseUrl`, or Payload as typed fields.
- [ ] Implement pure recursive known-field validation that collects `{path, message}` issues and never serializes inspected secret values.
- [ ] Implement atomic replacement with this fragile boundary:

```text
create same-directory temp with exclusive mode
write all bytes -> fsync temp -> close
verify destination precondition/hash when supplied
rename temp over destination atomically
fsync parent directory where supported
on any failure close/unlink only this temp and preserve destination
```

- [ ] Route `writeModelsConfig` through complete-candidate validation and atomic replacement while retaining parsed root fields.
- [ ] Add all new runtime modules to `npm run check`, then run focused and regression evidence.

**Commit:**
```bash
git add atomic-file.ts config-validation.ts config.ts types.ts tests/atomic-file.test.ts tests/config-validation.test.ts tests/helpers/temp-agent-dir.ts tests/config.test.ts package.json
git commit -m "feat: validate and atomically write model config"
```

---

### Task 2: Serialize editor processes with an OS-owned local IPC lock

**Purpose:** Two Pi processes cannot mutate configuration concurrently; a paused process retains authority, while process exit or crash releases authority without a stale-file takeover protocol.

**Files/modules:**
- Create: `process-lock.ts`
- Create: `tests/process-lock.test.ts`
- Create: `tests/fixtures/lock-worker.ts`
- Modify: `package.json`

**Interfaces and dependencies:**
- Produces `EndpointIdentity`, `IpcHandshakeV1`, `MutationLockHandle`, and `AcquireLockResult`.
- Produces async `tryAcquireMutationLock(agentDir, deps): Promise<AcquireLockResult>`; acquired handles expose `token`, synchronous `assertOwned(): void`, and async `release(): Promise<void>`.
- `AcquireLockResult` is exactly `acquired`, `busy`, `collision`, or `unsupported`; only `acquired` carries a handle. Other results never mutate files.
- `LockDependencies` injects canonical realpath, SHA-256, token generation, platform/runtime identity, `node:net` server/client factories, and a bounded Windows/macOS diagnostic-probe timer for deterministic tests.
- `IpcHandshakeV1` contains only `version: 1`, full endpoint identity hash, opaque owner token, and PID.

**Constraints and invariants:**
- Endpoint identity is SHA-256 of the canonical native real agent-directory path. Windows normalizes separators and drive-letter form but preserves component casing returned by `realpath.native`, so case-sensitive directories are not conflated. Canonicalization failure returns `unsupported` without a write.
- Windows listens on `\\.\pipe\pi-model-config-<full-hash>`. Node `EADDRINUSE` is `busy`. Bun 1.3.14 may report `ERR_INVALID_ARG_TYPE` with `Failed to listen at <exact-pipe>` for an occupied pipe; only for that exact derived pipe/error pair, one bounded connection probe is allowed. Successful connection is `busy` even when the owner event loop is blocked; connection failure is `collision`/`unsupported` and never retries bind. Linux listens on the abstract UDS name `\0pi-model-config-<full-hash>`. Both full-hash names are process-owned and leave no persistent filesystem entry.
- macOS uses one loopback-only port: `49152 + (firstUnsigned16BitWord(hash) % 16384)`. On `EADDRINUSE`, a valid matching handshake is `busy`; a valid different identity, unrecognized listener, timeout, or protocol error is `collision`. It never tries another port or permits takeover, so endpoint identity cannot drift while an owner is alive.
- `listen` success is the sole ownership transition. There is no persisted lock/claim, mtime lease, boot/PID liveness inference, stale cleanup, or force-unlock path.
- Acquisition does not wait for owner release. The only bounded waits are the exact-pipe Windows connection probe for Bun's occupied-listen error and the macOS identity probe after `EADDRINUSE`; a failed/unresponsive probe fails closed rather than replacing an owner.
- The owner server accepts only local IPC/loopback connections, caps handshake input/output, emits no path or secret, and installs `error`, peer-`end`, and `close` handlers before any socket write. It tracks every accepted socket. Windows/Linux sockets are destroyed immediately without a response; macOS writes at most one handshake and destroys on write callback or an injectable lifetime timer. Client `EPIPE`/`ECONNRESET` never marks the server handle lost.
- A handle is write-capable only while its exact server instance remains `listening` and has emitted neither unexpected `error` nor `close`. `assertOwned()` checks that state immediately before a synchronous journal/native/payload replacement in the same JavaScript turn with no intervening `await`; loss throws before the write.
- `release()` marks the close as expected, destroys every tracked accepted socket, awaits their removal plus `server.close()`, and invalidates the handle. A second release is idempotent; any later `assertOwned()` fails. No mutation runs after release.
- Process pause keeps the OS endpoint bound. Process exit, kill, or crash releases it automatically; the next process may acquire and then recover any journal.

**Acceptance evidence:**
- RED: `node --experimental-strip-types --test tests/process-lock.test.ts` -> fails because IPC acquisition does not exist.
- GREEN: the same command -> passes endpoint derivation, handshake, fake-adapter faults, and real cross-process exclusion/release/crash tests with zero failures.
- Regression: `npm test && npm run check` -> zero failures.

**Risk and rollback:**
- Risk: IPC behavior differs by platform/runtime. Keep endpoint derivation pure, adapters narrow, unsupported states fail closed, and execute real current-platform Node/Bun probes.
- Rollback: revert this commit; production mutation paths do not use it until Task 3 and no persistent lock artifact exists.

**Implementation intent:**
- [ ] Add pure endpoint tests for Windows named-pipe and Linux abstract-UDS full hashes, Windows case/path normalization, the exact macOS port formula, and secret-free `IpcHandshakeV1` serialization.
- [ ] Add fake-`net` tests for listen success, Node `EADDRINUSE`, Bun's exact occupied-pipe error plus successful/failed/timed-out exact-pipe connection probes, matching/different/malformed/timed-out macOS handshakes, bind errors, unexpected server error/close, expected close, idempotent release, and post-release fencing. Cover accepted-client disconnect before response, `EPIPE`, `ECONNRESET`, lifetime timeout, tracked-set removal, and forced destruction during release; client errors must not revoke server authority. Assert no failed probe retries bind and a different macOS identity never advances to another port.
- [ ] Implement `lock-worker.ts` modes for acquire-and-hold, fixed-duration event-loop block with `READY`/`RESUMED` markers, clean release, and process kill/crash. Its stdout protocol contains only readiness/result markers.
- [ ] Run the exact real owner/contender matrix `Node/Node`, `Node/Bun`, `Bun/Node`, and `Bun/Bun` when Bun is available. On Windows/Linux, an owner enters a fixed block, the first contender returns typed `busy`, the owner emits `RESUMED`, and a second contender remains `busy`. On macOS, the fixed block exceeds the bounded handshake window, so the first contender deterministically returns fail-closed `collision`; after `RESUMED`, a matching handshake returns `busy`. In every case the owner resumes without uncaught client-socket error, clean release completes, and the next contender returns `acquired`. A separate owner-kill case must also permit immediate `acquired` with no cleanup step. Add a forced-Darwin real-loopback regression on non-macOS hosts so this timeout/resume distinction is exercised in the ordinary suite; native macOS execution remains release-gate evidence.
- [ ] On Windows, exercise the real named-pipe adapter under both runtimes. On Linux, exercise the real abstract UDS adapter. On macOS, exercise loopback matching/different identity and foreign-listener fail-closed behavior. Platform-specific tests skip only when not running on that platform and remain mandatory in that platform's release evidence.
- [ ] Implement owner server lifecycle and bounded one-message macOS handshake; register client handlers before writes, track/remove every accepted socket, immediately destroy Windows/Linux diagnostic sockets, and destroy all remaining clients before awaiting server close. Never listen beyond named-pipe/abstract-UDS/`127.0.0.1` scopes.
- [ ] Verify injected endpoint loss fences simulated journal, native step 3, and payload step 4 calls before each write.

**Commit:**
```bash
git add process-lock.ts tests/process-lock.test.ts tests/fixtures/lock-worker.ts package.json
git commit -m "feat: coordinate model config mutations over local IPC"
```

---

### Task 3: Journal native/private mutations and resolve stable request payload views

**Purpose:** Any request observes one coherent before-or-after private payload view across crashes and concurrent file transitions, and malformed transaction state has an explicit recoverable representation.

**Files/modules:**
- Create: `payload-coordinator.ts`
- Modify: `payload-config.ts`
- Modify: `config.ts`
- Modify: `index.ts`
- Create: `tests/payload-coordinator.test.ts`
- Create: `tests/fixtures/coordinator-worker.ts`
- Modify: `tests/payload-config.test.ts`
- Modify: `tests/index-runtime.test.ts`
- Modify: `package.json`

**Interfaces and dependencies:**
- `payload-config.ts` produces strict `parsePayloadDocument`, `serializePayloadDocument`, clone, lookup, and pure set/remove/copy/move transformations. Its existing direct-writer exports remain as temporary compatibility shims in this commit so the old UI still compiles; Task 4 reroutes every caller and then removes those shims.
- `payload-coordinator.ts` produces `readCoordinatedSnapshot()`, async `commitCoordinatedMutation(request)`, `resolveRequestPayload(provider, modelId)`, async `inspectRecovery()`, and async `applyRecovery(snapshotToken, choice)`; mutation/recovery APIs await IPC acquisition and release, while request-time resolution remains synchronous and lock-free.
- `MutationRequest.build(snapshot)` returns complete validated native and payload candidates plus affected identities; it runs only after lock acquisition and hash/baseline revalidation.
- `TransactionJournalV1` contains version, operation ID, native before/after hashes, payload before/after hashes, and complete before/after payload documents.
- `index.ts` registers one `before_provider_request` hook that asks the coordinator for a payload object and shallow-merges it without mutation.

**Constraints and invariants:**
- Journal and payload artifacts use owner-only mode where supported and never render payload values in errors.
- Both-changing mutations write journal -> native -> payload -> remove journal. Each `assertOwned()` and synchronous atomic replacement are adjacent in one JavaScript turn; no protected write follows an `await` without another ownership check.
- Native-only and payload-only writes still hold the lock and use atomic replacement; a journal is required whenever both candidate hashes change.
- The request hook never acquires or waits on the lock and performs exactly three immediate stable-snapshot attempts.
- Manual recovery is two-phase: inspect/hash under lock, release before prompting, reacquire and require byte/hash/parse-state equality before applying a choice.

**Acceptance evidence:**
- RED: `node --experimental-strip-types --test tests/payload-coordinator.test.ts` -> fails because journal, stable snapshot, and recovery APIs are absent.
- GREEN: the same command -> passes every journal boundary, interleaving, retry exhaustion, built-in/current/dynamic identity, malformed storage, automatic recovery, manual recovery, and preview-race test.
- Regression: `npm test && npm run check` -> existing payload identity and activation tests pass with the new hook.

**Risk and rollback:**
- Risk: request-time code is latency-sensitive and secret-bearing. It uses synchronous local reads only, has three non-waiting attempts, and returns no extension payload on ambiguity.
- Rollback: revert this commit; any test journal is versioned and confined to temporary agent directories.

**Implementation intent:**
- [ ] Move private document parsing/serialization and identity transformations into pure exported helpers; retain exact JSON-encoded `[provider, model-id]` keys and legacy-read behavior.
- [ ] Write RED tests with injectable file-read hooks that interleave journal creation/removal, native replacement, payload replacement, and consecutive transactions between first and validation reads.
- [ ] Implement stable request resolution:

```text
repeat three times:
  read journal-1, native-1, payload-1
  re-read native hash, payload hash, journal-2
  accept only when journal bytes/operation identity and both file hashes stayed stable
  no journal -> parse payload-1
  valid journal + native before hash -> parse journal.beforePayload
  valid journal + native after hash -> parse journal.afterPayload
  otherwise fail closed
```

- [ ] Implement mutation commit with fault hooks after journal, native, payload, and journal removal so deterministic unit tests can restart a fresh coordinator against persisted bytes.
- [ ] Add real child-process cases that exit without releasing at the journal/native/payload boundaries; the next worker must acquire the same IPC endpoint and recover the persisted before/after view without lock-file cleanup.
- [ ] Implement automatic recovery for valid journal/native-before and journal/native-after states, including quarantine and replacement of a malformed current payload from the journal snapshot.
- [ ] Implement `inspectRecovery`/`applyRecovery` for mismatched valid journals, malformed journals, and malformed payload without a journal; tokens include exact artifact hashes and parse states.
- [ ] For a valid journal whose native hash matches neither side, offer the complete before or after payload snapshot and never overwrite native bytes. For a malformed journal, offer authoritative-current only when native and payload parse; if payload is malformed, offer quarantine-and-empty; if native is invalid, remain blocked until external repair.
- [ ] Enforce timestamped quarantine, choice-specific preconditions, and refresh-without-write when confirmation-time bytes or parse states differ.
- [ ] Replace the request hook's direct `getModelPayload` call with `resolveRequestPayload`; emit only a generic non-secret warning when resolution fails closed.

**Commit:**
```bash
git add payload-coordinator.ts payload-config.ts config.ts index.ts tests/payload-coordinator.test.ts tests/fixtures/coordinator-worker.ts tests/payload-config.test.ts tests/index-runtime.test.ts package.json
git commit -m "feat: journal private model payload mutations"
```

---

### Task 4: Put all Provider and Model storage actions behind the coordinator

**Purpose:** Existing command flows gain fresh-read patching, full-candidate validation, optimistic subtree conflicts, complete collision rejection, and journaled identity/payload lifecycle before the UI is replaced.

**Files/modules:**
- Create: `config-actions.ts`
- Modify: `model-fields.ts`
- Modify: `payload-config.ts`
- Modify: `index.ts`
- Create: `tests/config-actions.test.ts`
- Modify: `tests/model-fields.test.ts`
- Modify: `tests/payload-config.test.ts`
- Modify: `tests/index-runtime.test.ts`
- Modify: `package.json`

**Interfaces and dependencies:**
- Produces `ModelConfigActions`, constructed with `PayloadCoordinator` and validation options; every mutating or recovery-capable action returns `Promise<ActionResult>` and controllers await it.
- Read APIs return `EditorSnapshot` containing deep-cloned native/private values and native/payload hashes.
- Simple APIs: `patchProvider`, `patchModel`, `createProvider`, and `createModel`.
- Nested APIs: `saveProviderSubtree`, `saveModelSubtree`, and `saveModelPayload`, each requiring a deep baseline of the exact object.
- Identity APIs use `previewProviderIdentityAction`/`commitProviderIdentityAction` and Model equivalents for rename, copy, and delete; previews carry native/payload hashes, affected identities, and exact target-payload collisions.
- Results are typed as success, stale-target, validation-error, subtree-conflict, native-collision, payload-collision, lock-busy, lock-collision, lock-unsupported, or recovery-required; lock results preserve the coordinator reason and no result embeds secret values.

**Constraints and invariants:**
- Every operation re-reads under the lock and applies only its confirmed patch to the fresh object.
- A changed unrelated subtree does not conflict; the exact edited subtree does.
- Create/copy/rename occupied targets reject without mutation.
- Target payload reuse/removal is never inferred; a collision returns a preview requiring a separate explicit resolution and hash revalidation.
- Rename/copy/delete carry private payloads through the same journal as native identity changes.
- Legacy native `extraPayload` is removed/migrated only in the successful Model transaction that previews it.

**Acceptance evidence:**
- RED: `node --experimental-strip-types --test tests/config-actions.test.ts` -> fails because transactional domain actions do not exist.
- GREEN: the same command -> passes simple patch, unknown preservation, nested conflict, every CRUD collision, target payload resolution, legacy migration, distinct zero-write lock-busy/collision/unsupported propagation, and injected journal-step failure cases.
- Regression: `npm test && npm run check` -> old scripted UI tests remain green after their persistence calls are routed through `ModelConfigActions`.

**Risk and rollback:**
- Risk: this changes the write path before changing the UI. Keep old prompt sequencing intact in this task and assert its observable storage behavior through existing runtime tests.
- Rollback: revert this commit to restore the previous persistence path; at this intermediate point the coordinator/action layer is deliberately active behind the existing UI and remains independent of the later panel replacement.

**Implementation intent:**
- [ ] Define typed patch/result contracts and RED tests for false/zero preservation, explicit clear, stale identity, invalid full candidate, unrelated-versus-same-subtree external edits, and exact non-secret propagation of IPC busy/collision/unsupported with unchanged native/private bytes.
- [ ] Implement fresh snapshot lookup by Provider key and Model ID, never by stale array index.
- [ ] Implement creation and copy collision checks under lock; Model IDs must remain unique within their Provider.
- [ ] Implement two-phase previews for rename/copy/delete and target payload collisions; commit rejects changed hashes or identity sets and returns a refreshed preview result.
- [ ] Build complete native/private candidates for Provider and Model rename/copy/delete and commit both through one coordinator request.
- [ ] Add injected faults at journal/native/payload/journal-removal boundaries and assert the stable request resolver returns exactly before or after data.
- [ ] Route every current `index.ts` Provider/Model save and payload lifecycle call through `ModelConfigActions`; remove direct `writeModelsConfig`, `setModelPayload`, move/copy/remove payload calls from controller code, then delete the temporary direct-writer compatibility exports from `payload-config.ts` and update their tests to exercise the pure transformations or coordinated actions instead.
- [ ] Preserve the old UI for this commit so failures isolate storage changes from the later panel replacement.

**Commit:**
```bash
git add config-actions.ts model-fields.ts payload-config.ts index.ts tests/config-actions.test.ts tests/model-fields.test.ts tests/payload-config.test.ts tests/index-runtime.test.ts package.json
git commit -m "refactor: centralize model config mutations"
```

---

### Task 5: Normalize and transact endpoint Model discovery

**Purpose:** `Fetch Models from endpoint` preserves hand-edited Models, rejects malformed discovery data, and commits Merge/Replace through the same collision and journal rules.

**Files/modules:**
- Create: `endpoint-models.ts`
- Modify: `config-actions.ts`
- Modify: `index.ts`
- Create: `tests/endpoint-models.test.ts`
- Create: `tests/fixtures/manual-endpoint-server.ts`
- Modify: `tests/config-actions.test.ts`
- Modify: `tests/index-runtime.test.ts`
- Modify: `package.json`

**Interfaces and dependencies:**
- Produces `fetchEndpointModels(provider, deps): Promise<EndpointDiscoveryResult>` and pure `normalizeEndpointModels(raw): NormalizedEndpointModels`.
- Produces pure `mergeDiscoveredModels(existing, discovered)` and `replaceDiscoveredModels(existing, discovered)` candidate builders.
- `ModelConfigActions.previewEndpointChange` and `commitEndpointChange` own introduced-ID payload collision detection, confirmation-time hash/identity revalidation, and private cleanup for removed Models.
- Fetch dependencies inject `fetch`, timeout signal creation, and environment lookup; command references keep the existing non-expansion behavior.

**Constraints and invariants:**
- Probe `{baseUrl}/models` then `{baseUrl}/v1/models`; a failed first endpoint may fall through to the second. Accept only a top-level array, `{data: [...]}`, or `{models: [...]}`.
- Preserve credential behavior exactly: require configured `apiKey`; resolve `$VAR` from the environment; do not execute `!command` and pass that reference literally as today; omit Authorization only for an empty resolved key or the literal `ollama` sentinel.
- Trim before validity/fallback. Accept object records only, prefer a non-empty trimmed `id`, fall back to a non-empty trimmed `name`, omit empty optional names, and keep the first normalized duplicate in endpoint order. Each accepted record becomes `{id}` plus `name` only when present; discovery does not invent capability, price, or token-limit values.
- Merge never replaces an existing same-ID object and updates its seen-ID set as each new record is appended.
- Replace requires a second confirmation and removes only payload identities for Models no longer present.
- All-invalid, unsupported, empty, timeout, HTTP failure, and Cancel paths write neither file.

**Acceptance evidence:**
- RED: `node --experimental-strip-types --test tests/endpoint-models.test.ts` -> fails because extraction, normalization, and transaction APIs are absent.
- GREEN: the same command -> passes both URL probes, all supported shapes, whitespace/fallback, duplicate, malformed/all-invalid, Merge, Replace, Cancel, payload collision, and fault-injection cases.
- Regression: `npm test && npm run check` -> current endpoint menu remains available and all tests pass.

**Risk and rollback:**
- Risk: endpoint data is untrusted and may be very large. Normalize to bounded summaries for UI and never embed full raw responses in diagnostics.
- Rollback: revert this commit; no endpoint response format or stored schema changes.

**Implementation intent:**
- [ ] Extract fetch/response-shape handling from `index.ts` and write fake-fetch RED tests for status, parse, timeout, and fallback behavior.
- [ ] Implement trim-first normalization, skipped/duplicate counts, endpoint-order deduplication, and all-invalid failure.
- [ ] Add pure merge/replace tests proving same-ID hand edits survive Merge and every new ID appears once.
- [ ] Add action previews containing source, counts, bounded ID summary, introduced IDs, removed IDs, and exact private payload collisions without values.
- [ ] Reacquire/re-read/recompute after confirmation; return refreshed preview on any hash, introduced-ID, removed-ID, or collision-set change.
- [ ] Route the existing endpoint action through this module and coordinator before the Provider panel is introduced; endpoint action/controller tests require distinct non-secret lock-busy/collision/unsupported results and zero writes.

**Commit:**
```bash
git add endpoint-models.ts config-actions.ts index.ts tests/endpoint-models.test.ts tests/fixtures/manual-endpoint-server.ts tests/config-actions.test.ts tests/index-runtime.test.ts package.json
git commit -m "feat: harden endpoint model discovery"
```

---

### Task 6: Render and navigate the responsive settings panel

**Purpose:** A domain-neutral custom component returns field/search/back actions with complete restorable state in wide and narrow terminals.

**Files/modules:**
- Create: `settings-panel.ts`
- Create: `tests/settings-panel.test.ts`
- Modify: `package.json`

**Interfaces and dependencies:**
- Produces `SettingsCategoryDescriptor`, `SettingsFieldDescriptor`, `SettingsPanelState`, and `SettingsPanelResult`.
- Field descriptors contain stable IDs, label, display value, optional warning text, search text, and semantic action kind: `edit-field`, `open-section`, or `run-action`.
- `TwoPaneSettingsPanel` accepts title/subtitle, ordered descriptors, initial state, Pi theme, injected `KeybindingsManager`, render request callback, and completion callback.
- `openSettingsPanel(ctx, model, state)` is the only `ctx.ui.custom()` wrapper; the component itself has no Pi context or file access.

**Constraints and invariants:**
- Exactly 88 columns selects wide mode; 87 selects narrow mode.
- Use injected `tui.select.up`, `tui.select.down`, `tui.select.confirm`, and `tui.select.cancel` bindings; use `Tab`, Left, Right, and `/` for the specified pane/search semantics. Footer labels for configured actions come from `KeybindingsManager.getKeys()` and never hard-code their default keys.
- Every state mutation requests render. Every emitted line passes ANSI-aware `truncateToWidth` and has `visibleWidth(line) <= width`.
- Focus and selection have textual markers in addition to theme colors.
- Narrow-field cancel returns to categories; narrow-category cancel and any wide cancel close the panel.

**Acceptance evidence:**
- RED: `node --experimental-strip-types --test tests/settings-panel.test.ts` -> fails because component/types do not exist.
- GREEN: the same command -> passes width 120/88/87/40 render snapshots, line bounds, focus, category preview, field activation, warning text, search/back outcomes, scroll windows, restored-state tests, and non-default configured key handling/footer labels.
- Regression: `npm test && npm run check` -> zero failures.

**Risk and rollback:**
- Risk: terminal width and ANSI styling can produce off-by-one layouts. Keep layout calculations pure and test visible width at boundary values.
- Rollback: revert this unused component commit.

**Implementation intent:**
- [ ] Define stable descriptor/result/state types; state stores category ID, field ID, focused pane, category/field scroll offsets, and narrow screen.
- [ ] Write pure visible-window and state-normalization helpers so removed/reordered fields fall back deterministically.
- [ ] Implement wide rendering with a bounded category column, separator, flexible field column, title/subtitle, and a state-specific footer. Format `getKeys()` results for up/down/confirm/cancel, show only actions available in the current wide/narrow screen, and show literal custom controls only for Tab/Left/Right/`/`.
- [ ] Implement narrow category and field screens from the same descriptors, with breadcrumb and identical action IDs.
- [ ] Implement key handling and semantic completion without opening nested custom UI or mutating descriptors.
- [ ] Add a wrapper that calls `ctx.ui.custom()` non-overlay and returns typed results.

**Commit:**
```bash
git add settings-panel.ts tests/settings-panel.test.ts package.json
git commit -m "feat: add responsive settings panel"
```

---

### Task 7: Provide shared value formatting and explicit nested draft editors

**Purpose:** Provider/Model controllers can collect safe scalar values and edit shared nested objects with explicit save/discard and predictable validation.

**Files/modules:**
- Create: `field-editors.ts`
- Create: `tests/field-editors.test.ts`
- Create: `tests/helpers/scripted-ui.ts`
- Modify: `compat-settings.ts`
- Modify: `model-fields.ts`
- Modify: `tests/compat-settings.test.ts`
- Modify: `tests/model-fields.test.ts`
- Modify: `package.json`

**Interfaces and dependencies:**
- Produces `formatSettingValue`, `formatNestedCount`, `maskApiKey`, and `formatApiKeyReference`.
- Produces `collectOptionalString`, `collectRequiredString`, `collectPositiveInteger`, `collectNonNegativeRate`, and `collectApiKeyAction` using Pi `input`/`select` without persistence.
- Produces `editStringMapDraft`, `editCompatDraft`, `editThinkingMapDraft`, `editCostDraft`, and `editPayloadDraft`, each returning `{status: "save", value}` or `{status: "discard"}`. `editThinkingMapDraft` accepts the current reasoning state and renders the same inactive-map warning contract used by Model descriptors.
- Controllers retain subtree baselines and pass saved drafts to `ModelConfigActions`; field editors never read or write files.

**Constraints and invariants:**
- Formatters distinguish inherited, not set, false, zero, and populated nested objects without truthiness shortcuts.
- Literal API keys retain only a short suffix in panel rows. `$ENV` and `!command` references may display unchanged.
- API Key selection is Keep/Replace/Clear; Replace warns, calls `ctx.ui.input` with no stored default, and never passes the literal key as title, placeholder, initial value, or notification.
- Escape and `Discard changes` return discard. Only `Save and return` returns a candidate draft.
- Thinking Map includes `off` through `max`; Cost includes four base rates and complete ordered tiers.
- Every draft starts from a deep clone of the complete stored subtree and patches only selected known paths. Unknown keys in Thinking Map, Cost root, each retained tier, Headers, Compat, Payload, and allowed Override nested objects survive known-field edits.

**Acceptance evidence:**
- RED: `node --experimental-strip-types --test tests/field-editors.test.ts` -> fails because shared formatter/editor APIs are absent.
- GREEN: the same command -> passes display-state, API-key leakage scan, save/discard, clear, invalid numeric/JSON, `max`, complete cost, and unknown-preservation scripts with sentinel future keys at every nested depth including individual retained tiers.
- Regression: `npm test && npm run check` -> existing compat/model helper tests pass.

**Risk and rollback:**
- Risk: scripted menus can accidentally encode clear through blank input. Require explicit clear outcomes at the collector boundary and test blank required input as rejection.
- Rollback: revert this unused shared-editor commit.

**Implementation intent:**
- [ ] Build a scripted UI helper that records every title, placeholder, initial value, notification, and returned result; add a recursive secret-leak assertion.
- [ ] Implement scalar collectors with explicit cancel/clear/value result types instead of magic strings.
- [ ] Implement API-key Keep/Replace/Clear and verify the original literal appears only in the test's stored fixture, never in recorded UI calls.
- [ ] Implement new Compat, tier, and Payload local-draft functions with explicit terminal actions and no success notifications before persistence. Leave legacy `index.ts` loops untouched in this task; Tasks 8-9 switch callers and remove them.
- [ ] Add Headers/string-map editing with duplicate-key rejection and complete-object save.
- [ ] Add Thinking and Cost drafts with exact field/rate constraints and ordered tiers.

**Commit:**
```bash
git add field-editors.ts compat-settings.ts model-fields.ts tests/field-editors.test.ts tests/helpers/scripted-ui.ts tests/compat-settings.test.ts tests/model-fields.test.ts package.json
git commit -m "feat: add nested model field editors"
```

---

### Task 8: Replace the Model pipeline and define restricted Override editing

**Purpose:** Existing Models open directly at any field, new Models use only the minimal ID wizard, and Model Override drafts can emit only Pi's allowed subset.

**Files/modules:**
- Create: `model-editor.ts`
- Modify: `index.ts`
- Create: `tests/model-editor.test.ts`
- Modify: `tests/index-runtime.test.ts`
- Modify: `tests/no-emoji.test.ts`
- Modify: `package.json`

**Interfaces and dependencies:**
- Produces `buildModelCategories(model, payloadSummary)`, `buildModelOverrideCategories(targetId, override)`, `runModelEditor`, `runModelList`, `createModelAndOpen`, and `editModelOverrideEntryDraft`.
- Stable field IDs map one-to-one to the approved Model catalog; global search uses existing `searchableSelect` and reopens the panel at the selected category/field.
- Override draft results include the changed restricted object and a list of unsupported stored paths; normal save cannot prune those paths.
- Controllers call only `ModelConfigActions` for storage and reuse Task 7 nested editors.

**Constraints and invariants:**
- Use these stable Model categories/fields: `general` (`id`, `name`), `endpoint` (`api`, `baseUrl`, `headers`), `capability` (`reasoning`, `input`, `contextWindow`, `maxTokens`), `thinking` (`thinkingLevelMap`), `cost` (`input`, `output`, `cacheRead`, `cacheWrite`, `tiers`), `compatibility` (`compat`), `payload` (`payload`), and `actions` (`copy`, `delete`).
- Model input editing uses the existing searchable multi-select and must return at least one of `text` or `image`; optional Model API/Base URL fields use explicit clear/default actions.
- Model Override categories expose only target key/name, reasoning/input/context/max tokens, thinking map, partial cost/tiers, headers, and compat.
- `id`, `api`, `baseUrl`, and Payload never appear as editable/stored override properties.
- Unsupported top-level override keys block save until the user explicitly confirms `Remove unsupported fields and save`; cancel/view preserves them byte-for-value in parsed data. Unknown nested keys inside an allowed object such as `cost` or `compat` remain preserved and are not classified as unsupported solely for being unknown.
- Model ID rename, copy, delete, and create use collision previews and coordinator actions.
- New Model defaults remain reasoning false, text input, context 128000, max tokens 16384, and four zero cost rates.
- When a stored Thinking Map is non-empty and `reasoning` is false, its panel descriptor and child editor display the non-destructive warning `Reasoning 已关闭；Thinking Map 会保留但当前不生效`; the warning is absent when reasoning is true, and toggling reasoning never deletes the map.

**Acceptance evidence:**
- RED: `node --experimental-strip-types --test tests/model-editor.test.ts` -> fails because catalogs/controllers do not exist.
- GREEN: the same command -> passes exact field catalogs, inactive/active Thinking Map warning states, search/state restoration, scalar cancel/save, all nested routes, creation/copy/rename/delete, payload lifecycle, override allowlist, unsupported cleanup, identity collisions, and distinct lock-busy/collision/unsupported zero-write diagnostics.
- Regression: `npm test && npm run check` -> top-level runtime scripts use the new Model panel with zero failures.

**Risk and rollback:**
- Risk: replacing a large linear flow can leave dead branches or duplicate persistence. Route one Model action at a time in tests and remove old helpers only after all new tests pass.
- Rollback: revert this commit; Provider management remains compatible with the prior Model list entry contract.

**Implementation intent:**
- [ ] Write descriptor tests that compare exact category/field ID arrays and assert false/zero/inherited/nested summaries.
- [ ] Implement the Model controller loop: fresh read -> panel -> close -> collect/edit -> `ModelConfigActions` -> reopen at returned state; map lock-busy/collision/unsupported to distinct non-secret notifications without changing panel state or files.
- [ ] Add `/` all-field search and cancelled-search state restoration.
- [ ] Wire scalar fields to immediate patches and nested fields to deep-baseline save calls; retain failed drafts after validation/conflict errors.
- [ ] Implement ID-only creation, post-create General panel state, copy target input, rename, delete confirmations, and collision retry.
- [ ] Build the separate override descriptor/controller in draft-only mode; detect top-level keys outside the exact allowlist and require a previewed cleanup confirmation before pruning only those keys.
- [ ] Replace `editModel`/`manageModels` in `index.ts`, remove their old prompt pipeline, and retain the searchable Model selection list.
- [ ] Add `model-editor.ts` and its test to no-emoji/check coverage.

**Commit:**
```bash
git add model-editor.ts index.ts tests/model-editor.test.ts tests/index-runtime.test.ts tests/no-emoji.test.ts package.json
git commit -m "feat: add field-oriented model editor"
```

---

### Task 9: Replace Provider editing and expose endpoint discovery in the Models category

**Purpose:** Existing Providers open in the two-pane panel, complete common Provider fields and Models actions are directly reachable, and endpoint discovery remains a permanent first-class action.

**Files/modules:**
- Create: `provider-editor.ts`
- Modify: `index.ts`
- Create: `tests/provider-editor.test.ts`
- Modify: `tests/index-runtime.test.ts`
- Modify: `tests/no-emoji.test.ts`
- Modify: `package.json`

**Interfaces and dependencies:**
- Produces `buildProviderCategories`, `runProviderEditor`, and `createProviderAndOpen`.
- The Provider controller routes Manage Models to `runModelList`, Model Overrides to one Provider-map draft using `editModelOverrideEntryDraft`, and endpoint discovery to Task 5 APIs.
- API-key collection comes only from Task 7; Provider/native/private mutation comes only from `ModelConfigActions`.

**Constraints and invariants:**
- Use these stable Provider categories/fields: `general` (`id`, `name`, `baseUrl`, `api`), `http-auth` (`apiKey`, `authHeader`, `headers`), `models` (`manageModels`, `fetchModels`, `modelOverrides`), `compatibility` (`compat`), and `actions` (`copy`, `delete`).
- Optional `authHeader` uses explicit default/true/false choices; name, API key, and other optional values use explicit clear actions rather than blank-input magic.
- `Fetch Models from endpoint` is visible with zero or many existing Models and never runs automatically during creation.
- Provider creation collects ID, required Base URL, and API type, rejects a collision under lock, writes once, then opens General.
- The complete Model Overrides map is one optimistic subtree draft; entry add/rename/delete/field edits remain staged until `Save and return`.
- Rename/copy/delete use two-phase previews, destructive confirmations, payload collision resolution, and journaled actions.
- Stored literal API keys are masked in every descriptor rebuild and are not pre-filled during replacement.

**Acceptance evidence:**
- RED: `node --experimental-strip-types --test tests/provider-editor.test.ts` -> fails because Provider panel/controller do not exist.
- GREEN: the same command -> passes exact field catalog, panel navigation/search restoration, API secrecy, scalar/nested save/discard, Model routing, Overrides draft/conflict, endpoint action, creation/lifecycle, identity collisions, and distinct lock-busy/collision/unsupported zero-write diagnostics.
- Regression: `npm test && npm run check` -> old Provider pipeline assertions are replaced by equivalent storage assertions and all tests pass.

**Risk and rollback:**
- Risk: Provider ID changes affect every child payload identity. Keep rename/copy/delete as one `ModelConfigActions` call and never assemble cross-file updates in the UI controller.
- Rollback: revert this commit; Model editor and persistence foundation remain independently usable.

**Implementation intent:**
- [ ] Write exact Provider descriptor and display tests, including masked literal API key and unchanged `$`/`!` references.
- [ ] Implement fresh-read Provider controller and global field search with panel state restoration; map lock-busy/collision/unsupported from ordinary and endpoint actions to distinct non-secret notifications without changing panel state or files.
- [ ] Wire scalar immediate patches, Headers/Compat drafts, Manage Models, and permanent Fetch action.
- [ ] Implement Model Overrides keyed-list draft, entry collision checks, restricted child editor, unsupported-path preview, optimistic whole-map comparison, and retained draft after failed save.
- [ ] Implement the minimal creation wizard and post-create panel; do not prompt for API key, auth header, Compat, or discovery during creation.
- [ ] Implement Provider rename/copy/delete through action previews and explicit resolution screens without holding the lock across prompts.
- [ ] Replace `editProvider` and old Provider action menu in `index.ts`; preserve top-level Provider selection and Subagent menus.
- [ ] Add `provider-editor.ts` and its tests to no-emoji/check coverage.

**Commit:**
```bash
git add provider-editor.ts index.ts tests/provider-editor.test.ts tests/index-runtime.test.ts tests/no-emoji.test.ts package.json
git commit -m "feat: add field-oriented provider editor"
```

---

### Task 10: Finish recovery routing, remove legacy code, document and verify 1.2.0

**Purpose:** The extension has one production path for editing/recovery, rejects non-TUI mutation, ships accurate bilingual documentation, and passes automated plus controlled interactive verification.

**Files/modules:**
- Modify: `index.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `README-CN.md`
- Create: `LICENSE`
- Create: `tests/fixtures/manual-agent-state.ts`
- Create: `tests/fixtures/assert-package.ts`
- Modify: `tests/index-runtime.test.ts`
- Modify: `tests/no-emoji.test.ts`
- Modify: `tests/release-docs.test.ts`
- Delete only obsolete Provider/Model pipeline helpers from `index.ts`; preserve Subagent helpers and behavior.

**Interfaces and dependencies:**
- `/model-config` checks `ctx.mode === "tui"` before reading or mutating configuration.
- Top-level diagnostics calls coordinator recovery inspection, displays only non-secret journal state or IPC busy/collision metadata, and routes automatic, two-phase manual, busy, collision, and unsupported outcomes.
- Package and lock root versions become exactly `1.2.0`; syntax-check script includes every runtime module; `package.json.files` explicitly includes root runtime `*.ts`, both READMEs, and `LICENSE` while excluding tests, `.pi-subagents`, and runtime artifacts. `LICENSE` contains the standard MIT text with year 2026 and the package author from `package.json`.

**Constraints and invariants:**
- Recovery UI offers no force-unlock. `busy` shows a generic operation-in-progress result with Cancel/Retry; `collision` or `unsupported` shows non-secret adapter diagnostics and performs no write. Journal recovery starts only after acquiring a fresh OS endpoint; process crash requires no stale-lock cleanup.
- No human prompt runs while a lock handle is owned; tests record lock ownership at every scripted prompt.
- README files document two-pane/narrow controls, simple versus draft saves, full field scope, endpoint Merge/Replace/Cancel, the OS-owned IPC lock and transaction journal/recovery, payload secrecy, and unchanged Subagent behavior.
- No stale linear `editProvider`/`editModel` implementation or direct config/payload write remains in `index.ts`.

**Acceptance evidence:**
- RED: `node --experimental-strip-types --test tests/index-runtime.test.ts tests/release-docs.test.ts tests/no-emoji.test.ts` -> fails before version/docs/non-TUI/recovery/legacy-removal assertions are updated.
- GREEN: the same command -> passes activation, TUI gating, recovery routing, documentation, metadata, and complete source scan.
- Full regression: `npm test` -> all tests pass with zero failures.
- Syntax: `npm run check` -> every runtime `.ts` file parses successfully.
- Package: `npm pack --dry-run --json | node --experimental-strip-types tests/fixtures/assert-package.ts` -> asserts every runtime module/README/LICENSE is present and rejects `.pi-subagents`, tests, transaction journals, temp-agent data, or generated archive paths.
- Controlled TUI uses deterministic fixtures: in terminal A run `node --experimental-strip-types tests/fixtures/manual-endpoint-server.ts --port 43123`; in terminal B create `EDITOR_DIR="$(mktemp -d)"` and `EDITOR_MANIFEST="$(mktemp)"`, run `node --experimental-strip-types tests/fixtures/manual-agent-state.ts --agent-dir "$EDITOR_DIR" --scenario editor --base-url http://127.0.0.1:43123`, then run `PI_CODING_AGENT_DIR="$EDITOR_DIR" pi --no-extensions -e ./index.ts`. Verify wide (>=88) and narrow (<88) navigation, one Provider/Model scalar edit, one nested save/discard, global search, and the masked API key replacement warning. Immediately before endpoint discovery, run the fixture in terminal C with `--capture-manifest "$EDITOR_MANIFEST"`; after a successful discovery preview choose Cancel and run it again with `--assert-manifest "$EDITOR_MANIFEST"`.
- Controlled recovery routing uses `RECOVERY_DIR="$(mktemp -d)"` and `RECOVERY_MANIFEST="$(mktemp)"`; seed it with `manual-agent-state.ts --scenario malformed-journal-valid-files`, capture its manifest, run Pi against it, open diagnostics, verify the non-secret recovery preview, Cancel, and assert the manifest is unchanged. Automated coordinator tests remain the authority for applying recovery transitions.

**Risk and rollback:**
- Risk: final dead-code cleanup can accidentally remove Subagent behavior or hide an adapter limitation. Use symbol search and existing Subagent tests before deletion, keep cleanup isolated, and record current-platform IPC evidence.
- Rollback: revert this release commit; preceding commits remain testable and the branch is not installed/published automatically.

**Implementation intent:**
- [ ] Add non-TUI tests that snapshot native/private bytes before invocation and assert no file is created or changed.
- [ ] Add recovery-menu tests for automatic completion, two-phase refresh on concurrent change, IPC busy/collision/unsupported results, crash-then-reacquire routing, endpoint-handle loss, and no secret output.
- [ ] Remove old linear Provider/Model editors, obsolete persistence wrappers, and now-unused payload imports; use `rg` to prove production writes occur only through coordinator/action modules.
- [ ] Expand no-emoji scanning to all runtime `.ts`, all `tests/**/*.ts`, and both READMEs rather than maintaining a partial static list.
- [ ] Add `.pi-subagents/` and `*.tgz` to `.gitignore`; set `package.json.files` to the explicit runtime/documentation allowlist; set package and both package-lock root version fields to `1.2.0`; update check script for every runtime module.
- [ ] Implement deterministic manual endpoint/state fixtures and the stdin JSON package assertion; fixture payloads and recovery data contain no secrets. `manual-agent-state.ts` supports `--capture-manifest <path>` and `--assert-manifest <path>` over exact native/payload/journal bytes so Cancel evidence is machine-checked.
- [ ] Update English and Chinese docs plus project tree; preserve Pi 0.80.6 JSONC, payload, native registry, and Subagent guidance.
- [ ] Run focused, full, syntax, package, and controlled TUI verification; record any platform-specific manual limitation before claiming completion.

**Commit:**
```bash
git add index.ts package.json package-lock.json .gitignore README.md README-CN.md LICENSE tests/fixtures/manual-agent-state.ts tests/fixtures/assert-package.ts tests/index-runtime.test.ts tests/no-emoji.test.ts tests/release-docs.test.ts
git commit -m "release: prepare model config 1.2.0"
```

---

## Final Verification Gate

After all ten task commits and task-level reviews:

```bash
npm test
npm run check
npm pack --dry-run --json | node --experimental-strip-types tests/fixtures/assert-package.ts
git status --short
git log --oneline --decorate -12
```

Expected evidence:

- every Node test passes with zero failures;
- every runtime module passes syntax checking;
- the package archive contains the new modules/docs and no runtime artifacts;
- the worktree is clean;
- commit history contains one reviewable commit per task plus the approved design/plan commits;
- controlled TUI evidence uses deterministic local fixtures and covers both responsive modes, direct scalar editing, nested save/discard, field search, API-key secrecy warning, a successful endpoint preview followed by hash-stable Cancel, and a seeded non-secret recovery preview; automated tests own recovery-transition correctness.
