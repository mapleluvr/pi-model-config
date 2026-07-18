import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { ModelConfigActions } from "../config-actions.ts";
import { getModelsPath, readModelsConfig, writeModelsConfig } from "../config.ts";
import { fetchEndpointModels, type EndpointDiscoverySuccess } from "../endpoint-models.ts";
import {
  getPayloadConfigPath,
  lookupModelPayload,
  modelPayloadKey,
  readPayloadConfig,
  setPayloadDocumentValue,
  serializePayloadDocument,
} from "../payload-config.ts";
import { buildProviderCategories, runProviderEditor } from "../provider-editor.ts";
import type { SettingsPanelResult } from "../settings-panel.ts";

function catalog(categories: ReturnType<typeof buildProviderCategories>): Array<[string, string[]]> {
  return categories.map((category) => [category.id, category.fields.map((field) => field.id)]);
}

test("Provider catalog uses the exact stable category and field IDs", () => {
  assert.deepEqual(catalog(buildProviderCategories("example", { models: [] })), [
    ["general", ["id", "name", "baseUrl", "api"]],
    ["http-auth", ["apiKey", "authHeader", "headers"]],
    ["models", ["manageModels", "fetchModels", "modelOverrides"]],
    ["compatibility", ["compat"]],
    ["actions", ["copy", "delete"]],
  ]);
});

test("Provider descriptors mask literals, preserve references, and always expose endpoint discovery", () => {
  const literal = buildProviderCategories("example", {
    apiKey: "literal-secret-value-9876",
    authHeader: false,
    headers: {},
    models: [],
    modelOverrides: {},
  });
  const literalFields = new Map(literal.flatMap((category) => category.fields.map((field) => [field.id, field])));
  assert.equal(literalFields.get("apiKey")?.displayValue, "************9876");
  assert.equal(literalFields.get("authHeader")?.displayValue, "false");
  assert.equal(literalFields.get("headers")?.displayValue, "0 项");
  assert.equal(literalFields.get("modelOverrides")?.displayValue, "0 个覆盖");
  assert.ok(literalFields.has("fetchModels"));

  for (const reference of ["$MODEL_API_KEY", "!credential read model"]) {
    const categories = buildProviderCategories("example", { apiKey: reference, models: [{ id: "one" }] });
    const apiKey = categories.find((category) => category.id === "http-auth")?.fields.find((field) => field.id === "apiKey");
    assert.equal(apiKey?.displayValue, reference);
    assert.ok(categories.find((category) => category.id === "models")?.fields.some((field) => field.id === "fetchModels"));
  }
});

function panelResult(type: SettingsPanelResult["type"], categoryId = "general", fieldId = "id"): SettingsPanelResult {
  return {
    type: type as any,
    categoryId,
    fieldId,
    state: {
      categoryId,
      fieldId,
      focusedPane: "fields",
      categoryScrollOffset: 0,
      fieldScrollOffset: 0,
      narrowScreen: "fields",
    },
  } as SettingsPanelResult;
}

function providerSnapshot(provider: Record<string, unknown>): any {
  return {
    type: "snapshot",
    native: { providers: { local: provider } },
    payload: { version: 1, extraPayloads: {} },
    nativeHash: "native",
    payloadHash: "payload",
  };
}

function model(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, ...extra };
}

async function withAgentDir(run: (agentDir: string, actions: ModelConfigActions) => Promise<void>): Promise<void> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-provider-editor-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await run(agentDir, new ModelConfigActions({ agentDir }));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

function writePayload(payload: any): void {
  fs.writeFileSync(getPayloadConfigPath(), serializePayloadDocument(payload), { mode: 0o600 });
}

async function fakeEndpointDiscovery(provider: any, records: unknown[]): Promise<EndpointDiscoverySuccess | null> {
  const result = await fetchEndpointModels(provider, {
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: records }) }),
    timeoutSignal: () => AbortSignal.abort(),
    getEnv: () => undefined,
  });
  return result.type === "success" ? result : null;
}

test("Override map save scans untouched and renamed entries before top-level-only cleanup", async () => {
  const original = {
    untouched: {
      api: "forbidden",
      cost: { input: 1, futureNested: { keep: true } },
    },
    old: {
      baseUrl: "forbidden",
      compat: { futureNested: { keep: "compat" } },
    },
  } as any;
  const provider = { models: [], modelOverrides: original };
  let saved: Record<string, unknown> | undefined;
  const actions = {
    readEditorSnapshot: () => providerSnapshot(provider),
    saveProviderSubtree: async (_providerId: string, _key: string, _baseline: unknown, next: Record<string, unknown>) => {
      saved = next;
      return { type: "success" };
    },
  } as any;
  const panels = [panelResult("open-section", "models", "modelOverrides"), panelResult("back")];
  const selects = [
    "编辑 old",
    "重命名",
    "保存并返回",
    "查看不支持字段",
    "移除不支持字段并保存",
  ];
  const notifications: string[] = [];
  const ctx = {
    ui: {
      select: async () => selects.shift(),
      editor: async () => "renamed",
      confirm: async () => true,
      notify: (message: string) => notifications.push(message),
    },
  } as any;
  await runProviderEditor(ctx, "local", { actions, openPanel: async () => panels.shift()! });
  assert.deepEqual(saved, {
    untouched: { cost: { input: 1, futureNested: { keep: true } } },
    renamed: { compat: { futureNested: { keep: "compat" } } },
  });
  assert.ok(notifications.some((message) => message.includes("untouched") && message.includes("renamed")));
  assert.deepEqual(selects, []);
});

test("Provider identity drift discards refreshed token, reruns malformed and collision prompts, and commits", async () => withAgentDir(async (agentDir, actions) => {
  writeModelsConfig({
    providers: {
      source: { baseUrl: "http://localhost", api: "openai-completions", models: [model("m")] },
    },
  });
  writePayload({ version: 1, extraPayloads: {} });
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  let confirms = 0;
  const panels = [panelResult("edit-field", "general", "id"), panelResult("back")];
  const selects = ["复用目标 Payload"];
  const ctx = {
    ui: {
      input: async () => "dest",
      select: async () => selects.shift(),
      confirm: async () => {
        confirms += 1;
        if (confirms === 1) {
          const drifted = readModelsConfig();
          drifted.providers.source!.models![0]!.extraPayload = { malformed: true };
          writeModelsConfig(drifted);
          writePayload(setPayloadDocumentValue(readPayloadConfig(), "dest", "m", { external: true }));
        }
        return true;
      },
      notify() {},
    },
  } as any;
  await runProviderEditor(ctx, "source", { actions, openPanel: async () => panels.shift()! });
  const saved = readModelsConfig();
  assert.equal(Object.hasOwn(saved.providers, "source"), false);
  assert.ok(saved.providers.dest);
  assert.equal(Object.hasOwn(saved.providers.dest!.models![0]!, "extraPayload"), false);
  assert.deepEqual(readPayloadConfig().extraPayloads[modelPayloadKey("dest", "m")], { external: true });
  assert.equal(confirms, 3, "initial confirmation, fresh malformed confirmation, and fresh action confirmation");
  assert.equal(actions.boundPreviewCount(), 0, "same action instance must not retain refreshed tokens");
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), false);
}));

test("Provider identity drift collision cancel performs no native write and consumes refreshed state", async () => withAgentDir(async (agentDir, actions) => {
  writeModelsConfig({
    providers: {
      source: { baseUrl: "http://localhost", api: "openai-completions", models: [model("m")] },
    },
  });
  writePayload({ version: 1, extraPayloads: {} });
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  let confirms = 0;
  const panels = [panelResult("edit-field", "general", "id"), panelResult("back")];
  const selects = ["取消"];
  const ctx = {
    ui: {
      input: async () => "dest",
      select: async () => selects.shift(),
      confirm: async () => {
        confirms += 1;
        if (confirms === 1) writePayload(setPayloadDocumentValue(readPayloadConfig(), "dest", "m", { external: true }));
        return true;
      },
      notify() {},
    },
  } as any;
  await runProviderEditor(ctx, "source", { actions, openPanel: async () => panels.shift()! });
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
  assert.ok(readModelsConfig().providers.source);
  assert.equal(readModelsConfig().providers.dest, undefined);
  assert.deepEqual(readPayloadConfig().extraPayloads[modelPayloadKey("dest", "m")], { external: true });
  assert.equal(actions.boundPreviewCount(), 0);
}));

test("Provider identity initially prompts for malformed legacy and cancel preserves the source", async () => withAgentDir(async (agentDir, actions) => {
  writeModelsConfig({
    providers: {
      source: { baseUrl: "http://localhost", api: "openai-completions", models: [model("m", { extraPayload: { malformed: true } })] },
    },
  });
  writePayload({ version: 1, extraPayloads: {} });
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  const panels = [panelResult("edit-field", "general", "id"), panelResult("back")];
  const confirms = [false];
  const ctx = {
    ui: {
      input: async () => "dest",
      select: async () => undefined,
      confirm: async () => confirms.shift(),
      notify() {},
    },
  } as any;
  await runProviderEditor(ctx, "source", { actions, openPanel: async () => panels.shift()! });
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
  assert.ok(readModelsConfig().providers.source);
  assert.equal(actions.boundPreviewCount(), 0);
}));

test("Provider copy moves every native and payload-only child payload through one identity action", async () => withAgentDir(async (_agentDir, actions) => {
  writeModelsConfig({
    providers: {
      "source/provider": {
        baseUrl: "http://localhost",
        api: "openai-completions",
        models: [model("model/one"), model("model/two")],
        future: { keep: true },
      },
    },
  });
  let payload = setPayloadDocumentValue({ version: 1, extraPayloads: {} }, "source/provider", "model/one", { first: true });
  payload = setPayloadDocumentValue(payload, "source/provider", "model/two", { second: true });
  payload = setPayloadDocumentValue(payload, "source/provider", "payload-only", { orphan: true });
  writePayload(payload);
  const panels = [panelResult("run-action", "actions", "copy"), panelResult("back")];
  const ctx = {
    ui: {
      editor: async () => "target/provider",
      confirm: async () => true,
      notify() {},
    },
  } as any;
  await runProviderEditor(ctx, "source/provider", { actions, openPanel: async () => panels.shift()! });
  assert.deepEqual(readModelsConfig().providers["target/provider"], readModelsConfig().providers["source/provider"]);
  const savedPayload = readPayloadConfig();
  assert.deepEqual(lookupModelPayload(savedPayload, "target/provider", "model/one"), { first: true });
  assert.deepEqual(lookupModelPayload(savedPayload, "target/provider", "model/two"), { second: true });
  assert.deepEqual(lookupModelPayload(savedPayload, "target/provider", "payload-only"), { orphan: true });
  assert.equal(actions.boundPreviewCount(), 0);
}));

test("Provider copy native collision preserves both providers and payload documents", async () => withAgentDir(async (agentDir, actions) => {
  const initial = {
    providers: {
      source: { baseUrl: "http://localhost", api: "openai-completions", models: [model("m")] },
      target: { baseUrl: "http://other", api: "anthropic-messages", models: [model("other")] },
    },
  } as any;
  writeModelsConfig(initial);
  let payload = setPayloadDocumentValue({ version: 1, extraPayloads: {} }, "source", "m", { source: true });
  payload = setPayloadDocumentValue(payload, "target", "other", { target: true });
  writePayload(payload);
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  const payloadBefore = fs.readFileSync(getPayloadConfigPath(agentDir));
  const panels = [panelResult("run-action", "actions", "copy"), panelResult("back")];
  const notifications: string[] = [];
  const ctx = {
    ui: {
      editor: async () => "target",
      notify: (message: string) => notifications.push(message),
    },
  } as any;
  await runProviderEditor(ctx, "source", { actions, openPanel: async () => panels.shift()! });
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
  assert.ok(notifications.some((message) => message.includes("目标 ID 已存在")));
  assert.equal(actions.boundPreviewCount(), 0);
}));

test("Provider copy after native parse failure writes no target payload", async () => withAgentDir(async (agentDir, actions) => {
  writeModelsConfig({
    providers: {
      source: { baseUrl: "http://localhost", api: "openai-completions", models: [model("m")] },
    },
  });
  writePayload(setPayloadDocumentValue({ version: 1, extraPayloads: {} }, "source", "m", { keep: true }));
  const payloadBefore = fs.readFileSync(getPayloadConfigPath(agentDir));
  const panels = [panelResult("run-action", "actions", "copy")];
  const blank = " \r\n\t";
  const notifications: string[] = [];
  const ctx = {
    ui: {
      editor: async () => {
        fs.writeFileSync(getModelsPath(agentDir), blank);
        return "target";
      },
      notify: (message: string) => notifications.push(message),
    },
  } as any;
  await runProviderEditor(ctx, "source", { actions, openPanel: async () => panels.shift()! });
  assert.equal(fs.readFileSync(getModelsPath(agentDir), "utf8"), blank);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
  assert.deepEqual(lookupModelPayload(readPayloadConfig(), "source", "m"), { keep: true });
  assert.equal(lookupModelPayload(readPayloadConfig(), "target", "m"), undefined);
  assert.ok(notifications.some((message) => message.includes("恢复")));
  assert.equal(actions.boundPreviewCount(), 0);
}));

test("Endpoint confirmation Cancel discards the bound preview on the creating actions instance", async () => withAgentDir(async (agentDir, actions) => {
  writeModelsConfig({
    providers: {
      local: { baseUrl: "http://service.test", apiKey: "configured-reference", api: "openai-completions", models: [{ id: "old" }] },
    },
  });
  writePayload(setPayloadDocumentValue({ version: 1, extraPayloads: {} }, "local", "old", { keep: true }));
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  const payloadBefore = fs.readFileSync(getPayloadConfigPath(agentDir));
  const panels = [panelResult("run-action", "models", "fetchModels"), panelResult("back")];
  const ctx = {
    ui: {
      select: async () => "合并并保留现有 Models",
      confirm: async () => false,
      notify() {},
    },
  } as any;
  await runProviderEditor(ctx, "local", {
    actions,
    openPanel: async () => panels.shift()!,
    fetchModels: (provider) => fakeEndpointDiscovery(provider, [{ id: "new" }]),
  });
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
  assert.equal(actions.boundPreviewCount(), 0);
}));

test("Endpoint Merge shows normalized discovery before mode choice and bounded ID details before commit", async () => withAgentDir(async (_agentDir, actions) => {
  writeModelsConfig({
    providers: {
      local: { baseUrl: "http://service.test", apiKey: "configured-reference", api: "openai-completions", models: [{ id: "same", future: { keep: true } }] },
    },
  });
  writePayload({ version: 1, extraPayloads: {} });
  const panels = [panelResult("run-action", "models", "fetchModels"), panelResult("back")];
  const events: string[] = [];
  const confirmations: string[] = [];
  const selects = ["合并并保留现有 Models"];
  const ctx = {
    ui: {
      select: async (title: string) => {
        events.push(`select:${title}`);
        return selects.shift();
      },
      confirm: async (_title: string, message: string) => {
        confirmations.push(message);
        return true;
      },
      notify: (message: string) => events.push(`notify:${message}`),
    },
  } as any;
  await runProviderEditor(ctx, "local", {
    actions,
    openPanel: async () => panels.shift()!,
    fetchModels: (provider) => fakeEndpointDiscovery(provider, [
      { id: "same" },
      { id: "new" },
      { id: "new" },
      { id: "" },
    ]),
  });
  const infoIndex = events.findIndex((event) => event.includes("有效 2") && event.includes("跳过 1") && event.includes("重复 1") && event.includes("same") && event.includes("new"));
  const modeIndex = events.findIndex((event) => event === "select:端点 Model 列表");
  assert.ok(infoIndex >= 0 && infoIndex < modeIndex, "discovery summary must precede mode selection");
  assert.match(confirmations[0]!, /发现: same, new/);
  assert.match(confirmations[0]!, /新增: new/);
  assert.match(confirmations[0]!, /移除: \(无\)/);
  assert.deepEqual(
    readModelsConfig().providers.local!.models!.map((entry) => entry.id),
    ["same", "new"],
    JSON.stringify({ events, confirmations }),
  );
  assert.deepEqual(readModelsConfig().providers.local!.models![0]!.future, { keep: true });
}));

test("Endpoint Replace confirmation lists exact collision and malformed identities and requires double confirmation", async () => withAgentDir(async (_agentDir, actions) => {
  writeModelsConfig({
    providers: {
      local: {
        baseUrl: "http://service.test",
        apiKey: "configured-reference",
        api: "openai-completions",
        models: [{ id: "old", extraPayload: { malformed: true } }],
      },
    },
  });
  writePayload(setPayloadDocumentValue({ version: 1, extraPayloads: {} }, "local", "new", { external: true }));
  const panels = [panelResult("run-action", "models", "fetchModels"), panelResult("back")];
  const selects = ["替换为端点 Models", "复用目标 Payload"];
  const confirmations: Array<{ title: string; message: string }> = [];
  const confirms = [true, true, true];
  const ctx = {
    ui: {
      select: async () => selects.shift(),
      confirm: async (title: string, message: string) => {
        confirmations.push({ title, message });
        return confirms.shift();
      },
      notify() {},
    },
  } as any;
  await runProviderEditor(ctx, "local", {
    actions,
    openPanel: async () => panels.shift()!,
    fetchModels: (provider) => fakeEndpointDiscovery(provider, [{ id: "new" }]),
  });
  assert.match(confirmations[0]!.message, /发现: new/);
  assert.match(confirmations[0]!.message, /新增: new/);
  assert.match(confirmations[0]!.message, /移除: old/);
  assert.match(confirmations[0]!.message, /\["local","new"\]/);
  assert.match(confirmations[0]!.message, /\["local","old"\]/);
  assert.equal(confirmations[1]!.title, "再次确认替换 Models");
  assert.equal(confirmations.length, 3);
  assert.deepEqual(selects, []);
  assert.deepEqual(confirms, []);
  assert.deepEqual(readModelsConfig().providers.local!.models!.map((entry) => entry.id), ["new"]);
  assert.deepEqual(readPayloadConfig().extraPayloads[modelPayloadKey("local", "new")], { external: true });
}));

test("Endpoint mode Cancel shows discovery but writes neither document", async () => withAgentDir(async (agentDir, actions) => {
  writeModelsConfig({
    providers: {
      local: { baseUrl: "http://service.test", apiKey: "configured-reference", api: "openai-completions", models: [{ id: "old" }] },
    },
  });
  writePayload(setPayloadDocumentValue({ version: 1, extraPayloads: {} }, "local", "old", { keep: true }));
  const nativeBefore = fs.readFileSync(getModelsPath(agentDir));
  const payloadBefore = fs.readFileSync(getPayloadConfigPath(agentDir));
  const panels = [panelResult("run-action", "models", "fetchModels"), panelResult("back")];
  const notifications: string[] = [];
  const ctx = {
    ui: {
      select: async () => "取消",
      notify: (message: string) => notifications.push(message),
    },
  } as any;
  await runProviderEditor(ctx, "local", {
    actions,
    openPanel: async () => panels.shift()!,
    fetchModels: (provider) => fakeEndpointDiscovery(provider, [{ id: "new" }]),
  });
  assert.ok(notifications.some((message) => message.includes("有效 1") && message.includes("new")));
  assert.equal(fs.readFileSync(getModelsPath(agentDir)).equals(nativeBefore), true);
  assert.equal(fs.readFileSync(getPayloadConfigPath(agentDir)).equals(payloadBefore), true);
  assert.equal(actions.boundPreviewCount(), 0);
}));

test("Endpoint drift refresh repeats preview and collision prompts on the same actions instance", async () => withAgentDir(async (_agentDir, actions) => {
  writeModelsConfig({
    providers: {
      local: { baseUrl: "http://service.test", apiKey: "configured-reference", api: "openai-completions", models: [] },
    },
  });
  writePayload({ version: 1, extraPayloads: {} });
  const panels = [panelResult("run-action", "models", "fetchModels"), panelResult("back")];
  const selects = ["合并并保留现有 Models", "复用目标 Payload"];
  const messages: string[] = [];
  const notifications: string[] = [];
  let confirms = 0;
  const ctx = {
    ui: {
      select: async () => selects.shift(),
      confirm: async (_title: string, message: string) => {
        confirms += 1;
        messages.push(message);
        if (confirms === 1) {
          writePayload(setPayloadDocumentValue(readPayloadConfig(), "local", "new", { external: true }));
        }
        return true;
      },
      notify: (message: string) => notifications.push(message),
    },
  } as any;
  await runProviderEditor(ctx, "local", {
    actions,
    openPanel: async () => panels.shift()!,
    fetchModels: (provider) => fakeEndpointDiscovery(provider, [{ id: "new" }]),
  });
  assert.equal(messages.length, 2, JSON.stringify({ notifications, selects }));
  assert.ok(notifications.some((message) => message.includes("重新检查并确认端点预览")));
  assert.doesNotMatch(messages[0]!, /\["local","new"\]/);
  assert.match(messages[1]!, /\["local","new"\]/);
  assert.deepEqual(readModelsConfig().providers.local!.models!.map((entry) => entry.id), ["new"]);
  assert.deepEqual(readPayloadConfig().extraPayloads[modelPayloadKey("local", "new")], { external: true });
  assert.equal(actions.boundPreviewCount(), 0);
}));

test("Override map cleanup cancel preserves the original parsed map and performs no save", async () => {
  const original = {
    untouched: { api: "forbidden", cost: { futureNested: { keep: true } } },
    old: { payload: { never: "persist" }, name: "Old" },
  } as any;
  const provider = { models: [], modelOverrides: original };
  let saveCalls = 0;
  const actions = {
    readEditorSnapshot: () => providerSnapshot(provider),
    saveProviderSubtree: async () => {
      saveCalls += 1;
      return { type: "success" };
    },
  } as any;
  const panels = [panelResult("open-section", "models", "modelOverrides"), panelResult("back")];
  const selects = ["编辑 old", "重命名", "保存并返回", "取消并保留原值"];
  const ctx = {
    ui: {
      select: async () => selects.shift(),
      editor: async () => "renamed",
      notify() {},
    },
  } as any;
  await runProviderEditor(ctx, "local", { actions, openPanel: async () => panels.shift()! });
  assert.equal(saveCalls, 0);
  assert.deepEqual(provider.modelOverrides, original);
  assert.equal(Object.hasOwn(provider.modelOverrides, "old"), true);
  assert.equal(Object.hasOwn(provider.modelOverrides, "renamed"), false);
  assert.deepEqual(selects, []);
});
