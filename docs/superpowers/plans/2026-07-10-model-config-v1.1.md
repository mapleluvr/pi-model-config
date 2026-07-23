# Model Config v1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release `pi-model-config` 1.1.0 with Pi 0.80.6-compatible model editing, safe JSONC persistence, functional private request payloads, and non-destructive configuration updates.

**Architecture:** Keep Pi-native configuration in `models.json`, parsed as JSONC and written as canonical JSON only after successful parsing. Add focused modules for native record merging and extension-private payload storage, then make `index.ts` orchestrate those modules without re-registering native providers. The payload hook identifies the selected `ctx.model` and returns a shallowly merged replacement payload only for the matching `provider/id` key.

**Tech Stack:** Node.js TypeScript, Node built-in test runner, `jsonc-parser@3.3.1`, `@earendil-works/pi-coding-agent@0.80.6` extension API, `@earendil-works/pi-tui@0.79.1`.

## Global Constraints

- Work only in `D:/Projects/PiAgent/plugins/model-config/.worktrees/model-config-v1.1` on branch `codex/model-config-v1.1`.
- Preserve user/project Subagent settings behavior and selected parent-tool metadata behavior unchanged.
- Use ASCII for new source and documentation text unless an existing Chinese document requires Chinese text.
- Do not add emoji anywhere in the plugin UI, tests, source, or documentation.
- `models.json` accepts JSONC comments and trailing commas; a parse failure must abort the operation and leave the file unmodified.
- Saving native configuration may normalize comments and whitespace into canonical JSON, but must preserve every parsed field not explicitly changed by the UI.
- Do not call `pi.registerProvider()` to replay `models.json`; Pi's native `ModelRegistry` owns model loading and refresh.
- Do not write extension `extraPayload` data to `models.json`.
- Extension-private payload configuration is stored at `<PI_CODING_AGENT_DIR>/model-config-payloads.json`, keyed by exact `provider/model-id`.
- `before_provider_request` must not log payload values and must not mutate either the event payload or the stored payload object.
- `thinkingLevelMap.max` and Subagent `thinking: "max"` are Pi 0.80.6 compatibility requirements.
- Cost tiers use Pi's complete `ModelCostTier` shape: positive `inputTokensAbove` and non-negative `input`, `output`, `cacheRead`, and `cacheWrite` rates.
- The release version is `1.1.0`; update both `README.md` and `README-CN.md`.
- Commit each completed task before handing it to the next task or reviewer.

---

## File Map

| File | Responsibility |
|---|---|
| `package.json`, `package-lock.json` | Add the JSONC parser and publish the 1.1.0 package metadata. |
| `types.ts` | Define permissive native config records, `max` thinking, cost tiers, and all Pi 0.80.6 compat fields. |
| `config.ts` | Parse/write Pi `models.json` safely as JSONC, retaining the complete root object. |
| `model-fields.ts` | Pure native provider/model merge and cost-tier validation helpers used by UI and tests. |
| `payload-config.ts` | Validate, persist, migrate, remove, and inject extension-private model payload objects. |
| `compat-settings.ts` | Define editable compat option metadata and pure tri-state/JSON-object update helpers. |
| `index.ts` | Present TUI workflows, call the pure helpers, migrate identities only after native saves, and register the payload hook. |
| `tests/config.test.ts` | Exercise JSONC reads, canonical writes, malformed-file protection, and root-field retention. |
| `tests/model-fields.test.ts` | Exercise patch merging, `max`, field preservation, and valid/invalid cost tiers. |
| `tests/payload-config.test.ts` | Exercise payload persistence, isolation, migration, cleanup, invalid-file fail-closed behavior, and non-mutating injection. |
| `tests/compat-settings.test.ts` | Exercise the expanded compat metadata and explicit value/clear transitions. |
| `tests/index-runtime.test.ts` | Exercise activation without dynamic provider registration and model-keyed request payload injection. |
| `README.md`, `README-CN.md` | Describe the v1.1 persistence contract, native fields, payload location, and `max` Subagent requirement. |

## Task 1: Safe Native Models JSONC I/O

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `types.ts`
- Modify: `config.ts`
- Create: `tests/config.test.ts`

**Interfaces:**
- Produces `readModelsConfig(filePath?: string): ModelsConfig`, `writeModelsConfig(config: ModelsConfig, filePath?: string): void`, and `ModelsConfigError` from `config.ts`.
- Produces `ModelsConfig` with a required `providers: Record<string, ProviderConfig>` plus an index signature that retains unknown top-level native keys.
- Consumes `jsonc-parser` `parse(text, errors, options)` and its parse error list.
- Later tasks rely on `readModelsConfig()` throwing instead of returning an empty replacement configuration after malformed JSONC.

- [ ] **Step 1: Write JSONC I/O tests before changing runtime code**

Create `tests/config.test.ts` with an isolated `PI_CODING_AGENT_DIR` per test. Cover comments, trailing commas, unknown root data, canonical writes, missing files, and malformed-file protection:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelsConfigError, readModelsConfig, writeModelsConfig } from "../config.ts";

function withAgentDir(run: (agentDir: string) => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-jsonc-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

test("reads Pi models.json JSONC and preserves unknown root fields", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, `// Pi accepts comments\n{\n  "feature": true,\n  "providers": {\n    "local": { "models": [], },\n  },\n}\n`);

  assert.deepEqual(readModelsConfig(), {
    feature: true,
    providers: { local: { models: [] } },
  });
}));

test("writes canonical JSON while retaining parsed root and provider fields", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, `{ "rootSetting": "keep", "providers": { "local": { "headers": { "X-Test": "yes" }, "models": [] } } }`);
  const config = readModelsConfig();
  config.providers.local!.name = "Local";
  writeModelsConfig(config);

  const written = fs.readFileSync(filePath, "utf8");
  assert.deepEqual(JSON.parse(written), {
    rootSetting: "keep",
    providers: { local: { headers: { "X-Test": "yes" }, models: [], name: "Local" } },
  });
}));

test("refuses to overwrite malformed models.json", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  const malformed = `{ "providers": {`;
  fs.writeFileSync(filePath, malformed);

  assert.throws(() => readModelsConfig(), ModelsConfigError);
  assert.throws(() => writeModelsConfig({ providers: {} }), ModelsConfigError);
  assert.equal(fs.readFileSync(filePath, "utf8"), malformed);
}));

test("returns an empty provider map only when models.json is absent", () => withAgentDir(() => {
  assert.deepEqual(readModelsConfig(), { providers: {} });
}));
```

- [ ] **Step 2: Run the new test and verify it fails because JSONC support is absent**

Run:

```bash
npm test -- --test-name-pattern="JSONC|malformed|canonical|empty provider"
```

Expected: FAIL because `ModelsConfigError` is not exported and commented/trailing-comma input reaches `JSON.parse`.

- [ ] **Step 3: Add the parser dependency and native record types**

Run:

```bash
npm install jsonc-parser@3.3.1 --save
```

Update `types.ts` so native records retain unedited values and cost tiers match Pi's required rate shape:

```ts
export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

export interface ModelCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ProviderConfig {
  [key: string]: unknown;
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: ModelConfig[];
  modelOverrides?: Record<string, Partial<ModelConfig>>;
  compat?: CompatConfig;
}

export interface ModelConfig {
  [key: string]: unknown;
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: ModelCostTier[];
  };
  headers?: Record<string, string>;
  compat?: CompatConfig;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
```

Remove the `ExtraPayloadParam` export and `ModelConfig.extraPayload` declaration; Task 3 owns the private replacement.

- [ ] **Step 4: Implement fail-safe JSONC read/write**

Replace `config.ts` with a parser boundary that retains the full root object and never replaces an invalid source file:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import type { ModelsConfig, ProviderConfig } from "./types.ts";

export class ModelsConfigError extends Error {
  constructor(public readonly filePath: string, message: string) {
    super(`Failed to read models.json at ${filePath}: ${message}`);
    this.name = "ModelsConfigError";
  }
}

export function getModelsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "models.json");
}

function parseModelsDocument(filePath: string, raw: string): ModelsConfig {
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new ModelsConfigError(filePath, errors.map((error) => `offset ${error.offset}: ${error.error}`).join("; "));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelsConfigError(filePath, "root must be a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  if (root.providers !== undefined && (!root.providers || typeof root.providers !== "object" || Array.isArray(root.providers))) {
    throw new ModelsConfigError(filePath, "providers must be a JSON object when present");
  }
  return { ...root, providers: (root.providers as Record<string, ProviderConfig> | undefined) ?? {} } as ModelsConfig;
}

export function readModelsConfig(filePath = getModelsPath()): ModelsConfig {
  if (!fs.existsSync(filePath)) return { providers: {} };
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return { providers: {} };
  return parseModelsDocument(filePath, raw);
}

export function writeModelsConfig(config: ModelsConfig, filePath = getModelsPath()): void {
  if (fs.existsSync(filePath)) parseModelsDocument(filePath, fs.readFileSync(filePath, "utf8"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function upsertProvider(providerId: string, config: ProviderConfig): void {
  const modelsConfig = readModelsConfig();
  modelsConfig.providers[providerId] = config;
  writeModelsConfig(modelsConfig);
}

export function deleteProvider(providerId: string): void {
  const modelsConfig = readModelsConfig();
  delete modelsConfig.providers[providerId];
  writeModelsConfig(modelsConfig);
}

export function listProviderIds(): string[] {
  return Object.keys(readModelsConfig().providers);
}

export function getProvider(providerId: string): ProviderConfig | undefined {
  return readModelsConfig().providers[providerId];
}
```

- [ ] **Step 5: Run focused and full Model Config tests**

Run:

```bash
npm test -- --test-name-pattern="JSONC|malformed|canonical|empty provider"
npm test
npm run check
```

Expected: All focused tests PASS; existing tests remain green; syntax checks PASS.

- [ ] **Step 6: Commit JSONC I/O support**

```bash
git add package.json package-lock.json types.ts config.ts tests/config.test.ts
git commit -m "feat: support JSONC model configuration"
```

## Task 2: Native Field Merging, Cost Tiers, and Compatibility Metadata

**Files:**
- Create: `model-fields.ts`
- Modify: `types.ts`
- Modify: `compat-settings.ts`
- Modify: `tests/compat-settings.test.ts`
- Create: `tests/model-fields.test.ts`

**Interfaces:**
- Produces `mergeProviderConfig(existing, changes)`, `mergeModelConfig(existing, changes)`, `validateCostTier(candidate)`, and `replaceCostTiers(cost, tiers)` from `model-fields.ts`.
- Produces `COMPAT_BOOLEAN_FIELDS`, `THINKING_FORMATS`, `COMPAT_JSON_OBJECT_FIELDS`, `applyCompatBooleanChoice`, and `applyCompatObjectChoice` from `compat-settings.ts`.
- Consumes `ProviderConfig`, `ModelConfig`, `ModelCostTier`, and `CompatConfig` defined in `types.ts`.
- Later UI code uses these pure functions rather than reconstructing provider/model records.

- [ ] **Step 1: Write failing pure-helper tests**

Create `tests/model-fields.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mergeModelConfig, mergeProviderConfig, replaceCostTiers, validateCostTier } from "../model-fields.ts";

test("provider merge changes managed values while retaining headers, modelOverrides, and unknown values", () => {
  const result = mergeProviderConfig({
    name: "Old", baseUrl: "https://old", headers: { "X-Keep": "1" },
    modelOverrides: { "known/model": { maxTokens: 99 } }, nativeFlag: true,
  }, { name: "New", baseUrl: "https://new", api: "openai-completions" });
  assert.deepEqual(result, {
    name: "New", baseUrl: "https://new", api: "openai-completions",
    headers: { "X-Keep": "1" }, modelOverrides: { "known/model": { maxTokens: 99 } }, nativeFlag: true,
  });
});

test("model merge retains native values, thinking max, compat, and existing cost tiers", () => {
  const result = mergeModelConfig({
    id: "old", api: "openai-completions", baseUrl: "https://host", headers: { "X-Keep": "1" },
    thinkingLevelMap: { max: "max" }, compat: { supportsTemperature: true },
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, tiers: [{ inputTokensAbove: 1000, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }] },
  }, { id: "new", name: "New" });
  assert.equal(result.id, "new");
  assert.deepEqual(result.thinkingLevelMap, { max: "max" });
  assert.deepEqual(result.cost?.tiers, [{ inputTokensAbove: 1000, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }]);
  assert.deepEqual(result.headers, { "X-Keep": "1" });
  assert.deepEqual(result.compat, { supportsTemperature: true });
});

test("cost tiers require a positive integer threshold and non-negative finite rates", () => {
  assert.deepEqual(validateCostTier({ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }), {
    inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5,
  });
  assert.equal(validateCostTier({ inputTokensAbove: 0, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }), undefined);
  assert.equal(validateCostTier({ inputTokensAbove: 100, input: -1, output: 1, cacheRead: 1, cacheWrite: 1 }), undefined);
});

test("replaces only tiers while retaining base cost rates", () => {
  assert.deepEqual(replaceCostTiers({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, [
    { inputTokensAbove: 100, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
  ]), {
    input: 1, output: 2, cacheRead: 3, cacheWrite: 4,
    tiers: [{ inputTokensAbove: 100, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }],
  });
});
```

Extend `tests/compat-settings.test.ts`:

```ts
import { COMPAT_BOOLEAN_FIELDS, COMPAT_JSON_OBJECT_FIELDS, THINKING_FORMATS, applyCompatObjectChoice } from "../compat-settings.ts";

test("declares every Pi 0.80.6 boolean, object, and thinking-format option", () => {
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "requiresAssistantAfterToolResult"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "requiresReasoningContentOnAssistantMessages"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "sendSessionAffinityHeaders"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "zaiToolStream"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "sendSessionIdHeader"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "supportsCacheControlOnTools"));
  assert.ok(COMPAT_BOOLEAN_FIELDS.some((field) => field.key === "supportsTemperature"));
  assert.deepEqual(COMPAT_JSON_OBJECT_FIELDS.map((field) => field.key), ["chatTemplateKwargs", "openRouterRouting", "vercelGatewayRouting"]);
  assert.ok(THINKING_FORMATS.includes("zai"));
  assert.ok(THINKING_FORMATS.includes("chat-template"));
  assert.ok(THINKING_FORMATS.includes("string-thinking"));
  assert.ok(THINKING_FORMATS.includes("ant-ling"));
});

test("sets, replaces, and clears compat object fields", () => {
  assert.deepEqual(applyCompatObjectChoice({}, "openRouterRouting", { only: ["bedrock"] }), { openRouterRouting: { only: ["bedrock"] } });
  assert.deepEqual(applyCompatObjectChoice({ openRouterRouting: { only: ["bedrock"] } }, "openRouterRouting", undefined), {});
});
```

- [ ] **Step 2: Run the focused tests and verify the helpers are missing**

Run:

```bash
npm test -- --test-name-pattern="provider merge|model merge|cost tiers|replaces only tiers|declares every Pi|compat object"
```

Expected: FAIL because `model-fields.ts` and new compat exports do not exist.

- [ ] **Step 3: Implement the pure native merge and tier validation helpers**

Create `model-fields.ts`:

```ts
import type { ModelConfig, ModelCostTier, ProviderConfig } from "./types.ts";

type ConfigPatch<T extends Record<string, unknown>> = Partial<T> & Record<string, unknown>;

function mergeDefined<T extends Record<string, unknown>>(existing: T | undefined, changes: ConfigPatch<T>): T {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

export function mergeProviderConfig(existing: ProviderConfig | undefined, changes: ConfigPatch<ProviderConfig>): ProviderConfig {
  return mergeDefined(existing, changes);
}

export function mergeModelConfig(existing: ModelConfig | undefined, changes: ConfigPatch<ModelConfig>): ModelConfig {
  return mergeDefined(existing, changes);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateCostTier(candidate: unknown): ModelCostTier | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const value = candidate as Record<string, unknown>;
  if (typeof value.inputTokensAbove !== "number" || !Number.isInteger(value.inputTokensAbove) || value.inputTokensAbove <= 0) return undefined;
  if (!finiteNonNegative(value.input) || !finiteNonNegative(value.output) || !finiteNonNegative(value.cacheRead) || !finiteNonNegative(value.cacheWrite)) return undefined;
  return {
    inputTokensAbove: value.inputTokensAbove,
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
  };
}

export function replaceCostTiers(
  cost: NonNullable<ModelConfig["cost"]>,
  tiers: ModelCostTier[],
): NonNullable<ModelConfig["cost"]> {
  return { ...cost, ...(tiers.length > 0 ? { tiers: tiers.map((tier) => ({ ...tier })) } : {}) };
}
```

When `tiers.length === 0`, explicitly remove any prior `tiers` field before returning so an empty UI editor is a deliberate clear:

```ts
const next = { ...cost };
if (tiers.length === 0) delete next.tiers;
else next.tiers = tiers.map((tier) => ({ ...tier }));
return next;
```

- [ ] **Step 4: Expand type-safe compatibility metadata**

Extend `CompatConfig` in `types.ts` with these fields:

```ts
supportsTemperature?: boolean;
zaiToolStream?: boolean;
sendSessionIdHeader?: boolean;
chatTemplateKwargs?: Record<string, unknown>;
openRouterRouting?: Record<string, unknown>;
vercelGatewayRouting?: { only?: string[]; order?: string[] };
```

Change `thinkingFormat` to this exact union:

```ts
"openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" |
"chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling"
```

Replace `compat-settings.ts` with declarative metadata plus the existing tri-state function:

```ts
export type CompatBooleanChoice = "default" | "false" | "true";

export const COMPAT_BOOLEAN_FIELDS = [
  { key: "supportsStore", label: "supportsStore" },
  { key: "supportsDeveloperRole", label: "supportsDeveloperRole" },
  { key: "supportsReasoningEffort", label: "supportsReasoningEffort" },
  { key: "supportsUsageInStreaming", label: "supportsUsageInStreaming" },
  { key: "requiresToolResultName", label: "requiresToolResultName" },
  { key: "requiresAssistantAfterToolResult", label: "requiresAssistantAfterToolResult" },
  { key: "requiresThinkingAsText", label: "requiresThinkingAsText" },
  { key: "requiresReasoningContentOnAssistantMessages", label: "requiresReasoningContentOnAssistantMessages" },
  { key: "supportsStrictMode", label: "supportsStrictMode" },
  { key: "supportsLongCacheRetention", label: "supportsLongCacheRetention" },
  { key: "supportsTemperature", label: "supportsTemperature" },
  { key: "zaiToolStream", label: "zaiToolStream" },
  { key: "sendSessionIdHeader", label: "sendSessionIdHeader" },
  { key: "supportsEagerToolInputStreaming", label: "supportsEagerToolInputStreaming (Anthropic)" },
  { key: "sendSessionAffinityHeaders", label: "sendSessionAffinityHeaders (Anthropic)" },
  { key: "supportsCacheControlOnTools", label: "supportsCacheControlOnTools (Anthropic)" },
  { key: "forceAdaptiveThinking", label: "forceAdaptiveThinking (Anthropic)" },
  { key: "allowEmptySignature", label: "allowEmptySignature (Anthropic)" },
] as const;

export const COMPAT_JSON_OBJECT_FIELDS = [
  { key: "chatTemplateKwargs", label: "chatTemplateKwargs" },
  { key: "openRouterRouting", label: "openRouterRouting" },
  { key: "vercelGatewayRouting", label: "vercelGatewayRouting" },
] as const;

export const THINKING_FORMATS = [
  "openai", "openrouter", "deepseek", "together", "zai", "qwen",
  "chat-template", "qwen-chat-template", "string-thinking", "ant-ling",
] as const;

export function applyCompatBooleanChoice(compat: Record<string, unknown>, key: string, choice: CompatBooleanChoice): Record<string, unknown> {
  const next = { ...compat };
  if (choice === "default") delete next[key];
  else next[key] = choice === "true";
  return next;
}

export function applyCompatObjectChoice(compat: Record<string, unknown>, key: string, value: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = { ...compat };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}
```

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
npm test -- --test-name-pattern="provider merge|model merge|cost tiers|replaces only tiers|declares every Pi|compat object"
npm test
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit native merge and compat contracts**

```bash
git add types.ts model-fields.ts compat-settings.ts tests/model-fields.test.ts tests/compat-settings.test.ts
git commit -m "feat: preserve native model configuration fields"
```

## Task 3: Private Payload Storage and Request Injection

**Files:**
- Create: `payload-config.ts`
- Create: `tests/payload-config.test.ts`
- Create: `tests/index-runtime.test.ts`
- Modify: `index.ts`
- Modify: `package.json` only if the syntax-check script needs to cover `payload-config.ts`

**Interfaces:**
- Produces `getPayloadConfigPath()`, `readPayloadConfig()`, `setModelPayload()`, `getModelPayload()`, `removeModelPayload()`, `removeProviderPayloads()`, `moveModelPayload()`, `mergePayloadIntoRequest()`, and `modelPayloadKey()` from `payload-config.ts`.
- `readPayloadConfig()` returns `{ version: 1, extraPayloads: {} }` for a missing or malformed private file, so request handling fails closed. Mutating helpers must first parse the existing private file with `readPayloadConfigForWrite()` and throw `PayloadConfigError` instead of overwriting a malformed file.
- `mergePayloadIntoRequest(payload, extraPayload)` returns a replacement object only if both inputs are plain JSON objects; it does not mutate inputs.
- `index.ts` registers one `before_provider_request` handler; it reads `ctx.model.provider` and `ctx.model.id` and returns the merged object only for the exact key.

- [ ] **Step 1: Write failing payload module tests**

Create `tests/payload-config.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getModelPayload, mergePayloadIntoRequest, modelPayloadKey, moveModelPayload,
  readPayloadConfig, removeModelPayload, removeProviderPayloads, setModelPayload,
} from "../payload-config.ts";

function withAgentDir(run: (agentDir: string) => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-payload-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

test("stores payloads by exact provider/model identity without cross-model leakage", () => withAgentDir(() => {
  setModelPayload("local", "model-a", { temperature: 0.2 });
  setModelPayload("local", "model-b", { top_p: 0.9 });
  assert.deepEqual(getModelPayload("local", "model-a"), { temperature: 0.2 });
  assert.deepEqual(getModelPayload("local", "model-b"), { top_p: 0.9 });
  assert.equal(getModelPayload("other", "model-a"), undefined);
  assert.equal(modelPayloadKey("local", "model-a"), "local/model-a");
}));

test("moves and removes payload identities", () => withAgentDir(() => {
  setModelPayload("local", "old", { seed: 7 });
  moveModelPayload("local", "old", "local", "new");
  assert.equal(getModelPayload("local", "old"), undefined);
  assert.deepEqual(getModelPayload("local", "new"), { seed: 7 });
  removeModelPayload("local", "new");
  assert.equal(getModelPayload("local", "new"), undefined);
  setModelPayload("local", "one", { a: 1 });
  setModelPayload("local", "two", { b: 2 });
  setModelPayload("other", "one", { c: 3 });
  removeProviderPayloads("local");
  assert.deepEqual(readPayloadConfig().extraPayloads, { "other/one": { c: 3 } });
}));

test("fails closed for malformed private payload configuration without overwriting it", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "model-config-payloads.json");
  fs.writeFileSync(filePath, "{ broken");
  assert.deepEqual(readPayloadConfig(), { version: 1, extraPayloads: {} });
  assert.equal(getModelPayload("local", "model"), undefined);
  assert.throws(() => setModelPayload("local", "model", { temperature: 0.2 }));
  assert.equal(fs.readFileSync(filePath, "utf8"), "{ broken");
}));

test("injects shallow payload values without mutating stored or event objects", () => {
  const eventPayload = { model: "model", nested: { keep: true } };
  const configuredPayload = { temperature: 0.2, nested: { replace: true } };
  const result = mergePayloadIntoRequest(eventPayload, configuredPayload);
  assert.deepEqual(result, { model: "model", temperature: 0.2, nested: { replace: true } });
  assert.deepEqual(eventPayload, { model: "model", nested: { keep: true } });
  assert.deepEqual(configuredPayload, { temperature: 0.2, nested: { replace: true } });
});
```

Create `tests/index-runtime.test.ts` using a minimal fake extension API:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../index.ts";
import { setModelPayload } from "../payload-config.ts";

test("activation does not dynamically register native providers and injects only the selected model payload", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-runtime-"));
  const handlers = new Map<string, Function>();
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    setModelPayload("local", "one", { temperature: 0.4 });
    const fakePi = {
      registerCommand: () => {},
      registerProvider: () => { throw new Error("native providers must not be re-registered"); },
      on: (event: string, handler: Function) => handlers.set(event, handler),
    };
    await extension(fakePi as any);
    const handler = handlers.get("before_provider_request");
    assert.ok(handler);
    assert.deepEqual(handler!({ payload: { model: "one" } }, { model: { provider: "local", id: "one" } }), { model: "one", temperature: 0.4 });
    assert.equal(handler!({ payload: { model: "two" } }, { model: { provider: "local", id: "two" } }), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run focused payload tests and verify they fail**

Run:

```bash
npm test -- --test-name-pattern="payloads by exact|moves and removes|fails closed|injects shallow|activation does not"
```

Expected: FAIL because `payload-config.ts` and the hook do not exist; the existing activation calls `registerProvider`.

- [ ] **Step 3: Implement private payload storage**

Create `payload-config.ts` with a strict plain-object guard and a fail-closed reader:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface PayloadConfig {
  version: 1;
  extraPayloads: Record<string, Record<string, unknown>>;
}

const EMPTY_CONFIG: PayloadConfig = { version: 1, extraPayloads: {} };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function clonePayload(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function getPayloadConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "model-config-payloads.json");
}

export function modelPayloadKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function parsePayloadConfig(filePath: string, raw: string): PayloadConfig {
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.extraPayloads)) {
    throw new PayloadConfigError(filePath, "expected { version: 1, extraPayloads: object }");
  }
  const extraPayloads: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(parsed.extraPayloads)) {
    if (!isPlainObject(value)) throw new PayloadConfigError(filePath, `payload '${key}' must be an object`);
    extraPayloads[key] = clonePayload(value);
  }
  return { version: 1, extraPayloads };
}

export class PayloadConfigError extends Error {
  constructor(public readonly filePath: string, message: string) {
    super(`Failed to read Model Config payloads at ${filePath}: ${message}`);
    this.name = "PayloadConfigError";
  }
}

export function readPayloadConfigForWrite(filePath = getPayloadConfigPath()): PayloadConfig {
  if (!fs.existsSync(filePath)) return { ...EMPTY_CONFIG, extraPayloads: {} };
  try {
    return parsePayloadConfig(filePath, fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof PayloadConfigError) throw error;
    throw new PayloadConfigError(filePath, error instanceof Error ? error.message : String(error));
  }
}

export function readPayloadConfig(filePath = getPayloadConfigPath()): PayloadConfig {
  try {
    return readPayloadConfigForWrite(filePath);
  } catch {
    return { ...EMPTY_CONFIG, extraPayloads: {} };
  }
}

function writePayloadConfig(config: PayloadConfig, filePath = getPayloadConfigPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function getModelPayload(provider: string, modelId: string): Record<string, unknown> | undefined {
  const value = readPayloadConfig().extraPayloads[modelPayloadKey(provider, modelId)];
  return value ? clonePayload(value) : undefined;
}

export function setModelPayload(provider: string, modelId: string, payload: Record<string, unknown>): void {
  if (!isPlainObject(payload)) throw new Error("Model payload must be a JSON object");
  const config = readPayloadConfigForWrite();
  config.extraPayloads[modelPayloadKey(provider, modelId)] = clonePayload(payload);
  writePayloadConfig(config);
}

export function removeModelPayload(provider: string, modelId: string): void {
  const config = readPayloadConfigForWrite();
  delete config.extraPayloads[modelPayloadKey(provider, modelId)];
  writePayloadConfig(config);
}

export function removeProviderPayloads(provider: string): void {
  const config = readPayloadConfigForWrite();
  const prefix = `${provider}/`;
  for (const key of Object.keys(config.extraPayloads)) if (key.startsWith(prefix)) delete config.extraPayloads[key];
  writePayloadConfig(config);
}

export function moveModelPayload(fromProvider: string, fromModelId: string, toProvider: string, toModelId: string): void {
  const config = readPayloadConfigForWrite();
  const value = config.extraPayloads[modelPayloadKey(fromProvider, fromModelId)];
  if (!value) return;
  config.extraPayloads[modelPayloadKey(toProvider, toModelId)] = clonePayload(value);
  delete config.extraPayloads[modelPayloadKey(fromProvider, fromModelId)];
  writePayloadConfig(config);
}

export function mergePayloadIntoRequest(payload: unknown, extraPayload: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(payload) || !isPlainObject(extraPayload)) return undefined;
  return { ...payload, ...clonePayload(extraPayload) };
}
```

- [ ] **Step 4: Replace dynamic provider replay with the request hook**

In `index.ts`:

1. Import `getModelPayload` and `mergePayloadIntoRequest`.
2. Delete the `initialConfig`, `loadedCount`, `for (const [pid, p] ...)`, `pi.registerProvider`, and `session_start` notification block.
3. Register this hook at the top of the default export before `registerCommand`:

```ts
pi.on("before_provider_request", (event, ctx) => {
  const model = ctx.model;
  if (!model) return undefined;
  const extraPayload = getModelPayload(model.provider, model.id);
  if (!extraPayload) return undefined;
  return mergePayloadIntoRequest(event.payload, extraPayload);
});
```

Do not log payload values. Do not use `modelRegistry` for identity, and do not call `registerProvider` anywhere.

Add `payload-config.ts` to `npm run check` in `package.json`.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
npm test -- --test-name-pattern="payloads by exact|moves and removes|fails closed|injects shallow|activation does not"
npm test
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit payload injection and native-registration removal**

```bash
git add payload-config.ts tests/payload-config.test.ts tests/index-runtime.test.ts index.ts package.json
git commit -m "feat: inject model payloads at request time"
```

## Task 4: TUI Integration for Non-Destructive Editing, Max, Tiers, Compat, and Payload Lifecycle

**Files:**
- Modify: `index.ts`
- Modify: `types.ts` only if UI-driven type narrowing requires it
- Modify: `tests/index-runtime.test.ts`
- Modify: `tests/model-fields.test.ts`
- Modify: `tests/payload-config.test.ts`

**Interfaces:**
- Consumes Task 1 `readModelsConfig`/`writeModelsConfig`, Task 2 merge/tier helpers and compat metadata, and Task 3 payload lifecycle helpers.
- Produces TUI behavior that preserves unedited fields, distinguishes cancellation from explicit clear, supports `max`, and performs payload cleanup/migration after a successful native save.
- `persistConfig(config, ctx)` must allow errors to propagate to the handler. Every management action clones the current root configuration, mutates the clone, and replaces the live in-memory value only after the write succeeds; the handler catches errors, displays `ctx.ui.notify(error.message, "error")`, and leaves both live config and private payload identities unchanged.

- [ ] **Step 1: Add red tests for identity cleanup/migration helpers and runtime compat metadata**

Add these tests to `tests/payload-config.test.ts`:

```ts
test("does not migrate a payload until the caller has committed the native identity", () => withAgentDir(() => {
  setModelPayload("local", "old", { seed: 7 });
  assert.deepEqual(getModelPayload("local", "old"), { seed: 7 });
  assert.equal(getModelPayload("local", "new"), undefined);
  moveModelPayload("local", "old", "local", "new");
  assert.equal(getModelPayload("local", "old"), undefined);
  assert.deepEqual(getModelPayload("local", "new"), { seed: 7 });
}));
```

Add a test to `tests/model-fields.test.ts` that an explicit `null` change clears a field while omitted changes leave it alone:

```ts
test("only explicit null clears a native field", () => {
  const retained = mergeModelConfig({ id: "model", headers: { "X-Keep": "yes" } }, { id: "model", name: "Renamed" });
  assert.deepEqual(retained.headers, { "X-Keep": "yes" });
  const cleared = mergeModelConfig(retained, { headers: null });
  assert.equal(cleared.headers, undefined);
});
```

- [ ] **Step 2: Run the narrow tests and verify the pre-UI merge behavior**

Run:

```bash
npm test -- --test-name-pattern="does not migrate|only explicit null"
```

Expected: PASS after Tasks 2 and 3. This is a regression gate before refactoring the interactive flow.

- [ ] **Step 3: Make prompts and edits patch-based**

In `index.ts`, change `promptText` so an explicit empty editor response remains an empty string and only cancellation yields `undefined`:

```ts
async function promptText(ctx: ExtensionCommandContext, title: string, message: string, defaultValue?: string): Promise<string | undefined> {
  const result = await ctx.ui.editor(
    `${title}\n\n${message}${defaultValue != null ? `\n\nCurrent value: ${defaultValue}` : ""}`,
    defaultValue ?? "",
  );
  return result === undefined ? undefined : result.trim();
}
```

Use `mergeProviderConfig(base, changes)` in `editProvider` instead of constructing a new object. Build `changes` only from the prompts shown in that edit. Use `null` only when an optional field is intentionally cleared with an empty confirmed value. Do not omit `headers`, `modelOverrides`, `compat`, native plugin fields, or existing `models` from the base record.

Use `mergeModelConfig(base, changes)` in `editModel`. Prompt for a model ID in both create and edit modes, using the existing ID as the default. Reject empty IDs. Preserve `api`, `baseUrl`, `headers`, all existing compat keys, thinking map entries, and cost tiers until the relevant editor explicitly changes them.

- [ ] **Step 4: Add max thinking-map and cost-tier editing**

Replace the hard-coded thinking level list with `THINKING_LEVELS` imported from `types.ts`. Start from a clone of `base.thinkingLevelMap` rather than an empty map. For each level, retain the existing entry if the prompt is cancelled, delete it only for `default`, set `null` for `null`, and set a non-empty custom string otherwise. This makes `max` available and prevents prior map entries from being silently discarded.

Add a `manageCostTiers(ctx, modelId, existingTiers): Promise<ModelCostTier[] | undefined>` helper in `index.ts` with Add, Edit, Delete, and Done actions. For each add/edit, prompt for all five values and validate through `validateCostTier` before updating the copied list:

```ts
const candidate = validateCostTier({
  inputTokensAbove: Number.parseInt(threshold, 10),
  input: Number.parseFloat(inputRate),
  output: Number.parseFloat(outputRate),
  cacheRead: Number.parseFloat(cacheReadRate),
  cacheWrite: Number.parseFloat(cacheWriteRate),
});
if (!candidate) {
  ctx.ui.notify("Cost tier requires a positive integer threshold and non-negative finite rates", "error");
  continue;
}
```

Only call `replaceCostTiers(base.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tiers)` after the user entered the tier editor and selected Done. Do not touch tiers otherwise.

- [ ] **Step 5: Expand the compat TUI without hiding absent fields**

Refactor `editCompat` to import `COMPAT_BOOLEAN_FIELDS`, `COMPAT_JSON_OBJECT_FIELDS`, and `THINKING_FORMATS`. Always include the scalar options in the select list, with `(unset)` labels for absent fields. Keep explicit clear choices for `maxTokensField`, `thinkingFormat`, and `cacheControlFormat`; do not gate them on whether a field existed before.

For each `COMPAT_JSON_OBJECT_FIELDS` member, add an item that opens `ctx.ui.editor`. Parse only non-empty values with `JSON.parse`; require a non-array object and show an error notification when parsing or shape validation fails. For empty confirmed input, use `applyCompatObjectChoice(c, field.key, undefined)`. For valid input, use `applyCompatObjectChoice(c, field.key, parsedObject)`.

The exact thinking-format menu must be:

```ts
[...THINKING_FORMATS, "(clear)"]
```

- [ ] **Step 6: Move payload editing to private objects and sequence lifecycle writes safely**

Remove all references to `ExtraPayloadParam` and `ModelConfig.extraPayload`. Keep the existing field-by-field payload menu, but change its in-memory representation to `Record<string, unknown>`. A new parameter stores plain string, boolean, or parsed JSON values. Reject JSON values that are not objects only when the full payload editor is asked to persist; the final payload must be one JSON object.

At model edit start, load `getModelPayload(providerId, existing.id)`. If no private payload exists and the untyped legacy record contains an `extraPayload` array, convert its `{ key, type, value }` rows to a single object only when every row parses successfully; retain the legacy data and notify an error if any row is invalid. On successful model save:

```ts
persistConfig(config, ctx);
if (payloadObject && Object.keys(payloadObject).length > 0) setModelPayload(providerId, updated.id, payloadObject);
else removeModelPayload(providerId, updated.id);
if (existing && existing.id !== updated.id) moveModelPayload(providerId, existing.id, providerId, updated.id);
```

Perform the native `persistConfig` call first. If it throws, do not write, delete, or move a private payload. After a successful save, remove the legacy `extraPayload` own property from the saved native model via the merged record so the extension no longer persists that non-native field.

On model deletion, call `persistConfig` first and then `removeModelPayload(providerId, existing.id)`. On provider deletion, call `persistConfig` first and then `removeProviderPayloads(pid)`. On provider rename, after the successful native save, loop over the prior provider models and call `moveModelPayload(oldProviderId, model.id, newProviderId, model.id)`.

- [ ] **Step 7: Make UI persistence errors transactional and preserve the command session**

Add a `cloneModelsConfig(config): ModelsConfig` helper using `structuredClone(config)`. For every provider/model add, edit, copy, delete, fetched-model merge, and provider rename, mutate a cloned root configuration first, call `persistConfig(nextConfig, ctx)`, then assign the live command-loop `config = nextConfig` only after the write succeeds. Keep `config` as a `let`, not a `const`.

Wrap the initial `readModelsConfig()` and every `persistConfig` call invoked from the command handler in `try/catch`. Report `ModelsConfigError.message` and `PayloadConfigError.message` through `ctx.ui.notify(message, "error")` and return to the previous menu; do not replace `config` with `{ providers: {} }`, mutate the live configuration, or execute payload cleanup after a failed native write.

Update the diagnostics menu to attempt `readModelsConfig()` and display either provider/model counts or the parse error. It must not claim an invalid file is usable.

- [ ] **Step 8: Run complete Model Config verification**

Run:

```bash
npm test
npm run check
node --experimental-strip-types --check config.ts
node --experimental-strip-types --check model-fields.ts
node --experimental-strip-types --check payload-config.ts
git diff --check
```

Expected: all tests and syntax checks PASS; `git diff --check` prints no errors.

- [ ] **Step 9: Commit the interactive v1.1 configuration editor**

```bash
git add index.ts types.ts tests/model-fields.test.ts tests/payload-config.test.ts tests/index-runtime.test.ts
git commit -m "feat: add Pi 0.80.6 model editor support"
```

## Task 5: Version, Documentation, and Release Verification

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `README-CN.md`
- Modify: `tests/no-emoji.test.ts` only if the documented source-file allowlist must cover new files

**Interfaces:**
- Consumes completed runtime behavior from Tasks 1-4.
- Produces version `1.1.0` and bilingual public documentation matching actual persistence and request behavior.

- [ ] **Step 1: Add documentation assertions before editing docs**

Extend `tests/no-emoji.test.ts` only if it enumerates source files rather than recursively scanning them. Add a separate test file `tests/release-docs.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";

for (const file of ["README.md", "README-CN.md"]) {
  test(`${file} documents v1.1 model configuration behavior`, () => {
    const content = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(content, /1\.1\.0/);
    assert.match(content, /JSONC/);
    assert.match(content, /model-config-payloads\.json/);
    assert.match(content, /max/);
    assert.doesNotMatch(content, /Register configured providers at Pi startup|启动时从 `models\.json` 注册/);
  });
}
```

- [ ] **Step 2: Run the new docs test and verify it fails**

Run:

```bash
npm test -- --test-name-pattern="documents v1.1"
```

Expected: FAIL because the package and README files still describe 1.0.0, native `extraPayload`, and startup provider replay.

- [ ] **Step 3: Update package metadata and English README**

Set `"version": "1.1.0"` in `package.json`.

Update `README.md` to state all of these facts precisely:

```md
## Pi 0.80.6 compatibility

Version 1.1.0 supports Pi 0.80.6 `thinkingLevelMap.max`, complete `cost.tiers`, and the current compatibility options. It reads Pi `models.json` as JSONC, so comments and trailing commas are accepted. Saving writes canonical JSON after a successful parse; malformed native configuration is never replaced.

Pi owns native provider registration and model refresh. After saving, reopen `/model` to refresh Pi's selector.

## Request payloads

Extra request-body values are extension data, not `models.json` fields. The extension stores them in `~/.pi/agent/model-config-payloads.json` (or `<PI_CODING_AGENT_DIR>/model-config-payloads.json`) under exact `provider/model-id` keys. On `before_provider_request`, the selected model's object is shallowly merged into its outgoing payload. Other models are unchanged, and payload values are never logged.
```

Replace the old typed payload table with wording that describes string, boolean, and JSON values as inputs to one private JSON object. State that legacy `extraPayload` entries migrate when that model is next saved. Update the Subagent thinking list to include `max` and state that it requires a `pi-subagents` build containing the companion `max` compatibility PR.

- [ ] **Step 4: Update Chinese README with the same contract**

Set the Chinese feature and workflow text to convey all of the following:

```md
## Pi 0.80.6 兼容性

v1.1.0 支持 `thinkingLevelMap.max`、完整的 `cost.tiers` 和 Pi 当前兼容性选项。`models.json` 使用 JSONC 读取，因此允许注释和尾逗号；只有成功解析后才会写回规范 JSON。原生配置损坏时插件会停止保存，不会用空配置覆盖文件。

Pi 本体负责 Provider 注册和 ModelRegistry 刷新。保存后关闭并重新打开 `/model` 即可刷新选择器。

## 请求 Payload 参数

额外请求体参数不再写入 `models.json`。插件把它们按精确 `provider/model-id` 键保存在 `~/.pi/agent/model-config-payloads.json`（或 `<PI_CODING_AGENT_DIR>/model-config-payloads.json`）中，并在 `before_provider_request` 对当前模型的最终请求体做浅合并。其他模型不会受到影响，插件不会记录 payload 值。
```

State that older `extraPayload` content moves when that model is next saved. Change the Subagent thinking list to include `max` and reference the updated `pi-subagents` requirement.

- [ ] **Step 5: Run release checks**

Run:

```bash
npm test
npm run check
git diff --check
git status --short
```

Expected: all tests and checks PASS; only intended v1.1 files are modified.

- [ ] **Step 6: Commit release docs and version**

```bash
git add package.json README.md README-CN.md tests/release-docs.test.ts tests/no-emoji.test.ts
git commit -m "docs: prepare Model Config v1.1 release"
```

## Task 6: Independent Model Config Review and Push

**Files:**
- Review: all changes on `codex/model-config-v1.1`

**Interfaces:**
- Consumes all completed Model Config commits.
- Produces a reviewed, pushed branch suitable for a release PR or merge.

- [ ] **Step 1: Run the whole verification suite from the isolated worktree**

Run:

```bash
npm test
npm run check
git diff --check
git status --short
git log --oneline origin/master..HEAD
```

Expected: tests and checks PASS; no whitespace errors; the log contains the design, plan, and v1.1 implementation commits only.

- [ ] **Step 2: Review behavior against the acceptance criteria**

Inspect these concrete invariants:

```bash
rg -n "registerProvider\(" index.ts
rg -n "extraPayload" index.ts types.ts config.ts payload-config.ts
rg -n '"max"' types.ts index.ts README.md README-CN.md
rg -n "model-config-payloads" payload-config.ts README.md README-CN.md
```

Expected: no `registerProvider(` call in `index.ts`; no native `extraPayload` type/persistence path; `max` appears in type/UI/docs; private storage is documented and implemented.

- [ ] **Step 3: Commit any review corrections and push the branch**

```bash
git status --short
git push -u origin codex/model-config-v1.1
```

Expected: `origin/codex/model-config-v1.1` is created and contains all v1.1 commits.
