import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import extension from "../index.ts";
import { ModelConfigActions } from "../config-actions.ts";
import { getModelsPath, readModelsConfig, writeModelsConfig } from "../config.ts";
import { getPayloadConfigPath, lookupModelPayload, readPayloadConfig, serializePayloadDocument, setPayloadDocumentValue } from "../payload-config.ts";
import { getTransactionJournalPath } from "../payload-coordinator.ts";
import { runModelEditor } from "../model-editor.ts";
import type { SettingsPanelResult } from "../settings-panel.ts";

function seedModelPayload(provider: string, modelId: string, payload: Record<string, unknown>): void {
  const next = setPayloadDocumentValue(readPayloadConfig(), provider, modelId, payload);
  fs.writeFileSync(getPayloadConfigPath(), serializePayloadDocument(next), { mode: 0o600 });
}

function readModelPayload(provider: string, modelId: string): Record<string, unknown> | undefined {
  return lookupModelPayload(readPayloadConfig(), provider, modelId);
}

interface Script {
  selects: string[];
  inputs: Array<string | undefined>;
  editors: Array<string | undefined>;
  confirms: boolean[];
  customs: unknown[];
}

function take<T>(values: T[], label: string): T {
  const value = values.shift();
  assert.notEqual(value, undefined, `missing scripted ${label} response`);
  return value as T;
}

function scriptedContext(script: Script, notifications: Array<{ message: string; level: string }> = []): any {
  return {
    ui: {
      select: async () => take(script.selects, "select"),
      input: async () => take(script.inputs, "input"),
      editor: async () => take(script.editors, "editor"),
      confirm: async () => take(script.confirms, "confirm"),
      custom: async () => take(script.customs, "custom"),
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  };
}

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

async function withRuntimeAgentDir(run: () => Promise<void>): Promise<void> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-runtime-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

async function runModelConfigCommand(script: Script, notifications: Array<{ message: string; level: string }> = []): Promise<void> {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  await extension({
    registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
      if (name === "model-config") handler = command.handler;
    },
    registerProvider: () => { throw new Error("native providers must not be re-registered"); },
    on: () => {},
  } as any);
  assert.ok(handler);
  await handler!("", scriptedContext(script, notifications));
  assert.deepEqual(script, { selects: [], inputs: [], editors: [], confirms: [], customs: [] });
}

test("activation does not dynamically register native providers and injects only the selected model payload", async () => {
  await withRuntimeAgentDir(async () => {
    seedModelPayload("local", "one", { temperature: 0.4 });
    const handlers = new Map<string, Function>();
    await extension({
      registerCommand: () => {},
      registerProvider: () => { throw new Error("native providers must not be re-registered"); },
      on: (event: string, handler: Function) => handlers.set(event, handler),
    } as any);
    const hook = handlers.get("before_provider_request");
    assert.ok(hook);
    assert.deepEqual(hook!({ payload: { model: "one" } }, { model: { provider: "local", id: "one" } }), { model: "one", temperature: 0.4 });
    assert.equal(hook!({ payload: { model: "two" } }, { model: { provider: "local", id: "two" } }), undefined);
  });
});

test("top-level Provider route opens the two-pane Model pipeline and renames through actions", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({ providers: { local: {
      baseUrl: "http://localhost:11434",
      api: "openai-completions",
      models: [{ id: "old", name: "Old", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } });
    seedModelPayload("local", "old", { inherited: true });

    const script: Script = {
      selects: ["管理 Providers", "管理 Models", "退出"],
      inputs: ["new"],
      editors: [],
      confirms: [true],
      customs: [
        "provider:local",
        panelResult("run-action", "models", "manageModels"),
        "model:old",
        panelResult("edit-field", "general", "id"),
        panelResult("back"),
        "__pi_model_config_action:back",
        panelResult("back"),
        "__pi_model_config_action:back",
      ],
    };
    await runModelConfigCommand(script);
    const model = readModelsConfig().providers.local!.models![0]!;
    assert.equal(model.id, "new");
    assert.deepEqual(readModelPayload("local", "new"), { inherited: true });
    assert.equal(readModelPayload("local", "old"), undefined);
  });
});

test("Provider creation asks only for ID, required Base URL, and API type, then opens General", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({ providers: {} });
    const script: Script = {
      selects: ["管理 Providers", "openai-completions", "退出"],
      inputs: ["created", "http://localhost:11434"],
      editors: [],
      confirms: [],
      customs: [
        "__pi_model_config_action:add_provider",
        panelResult("back"),
        "__pi_model_config_action:back",
      ],
    };
    await runModelConfigCommand(script);
    const provider = readModelsConfig().providers.created!;
    assert.equal(provider.baseUrl, "http://localhost:11434");
    assert.equal(provider.api, "openai-completions");
    assert.deepEqual(provider.models, []);
    assert.equal(Object.hasOwn(provider, "apiKey"), false);
    assert.equal(Object.hasOwn(provider, "authHeader"), false);
  });
});

test("Model creation uses Pi-compatible defaults and opens General without discovery prompts", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({ providers: { local: { baseUrl: "http://localhost:11434", api: "openai-completions", models: [] } } });
    const script: Script = {
      selects: ["管理 Providers", "管理 Models", "退出"],
      inputs: ["created-model"],
      editors: [],
      confirms: [],
      customs: [
        "provider:local",
        panelResult("run-action", "models", "manageModels"),
        "__pi_model_config_action:add_model",
        panelResult("back"),
        "__pi_model_config_action:back",
        panelResult("back"),
        "__pi_model_config_action:back",
      ],
    };
    await runModelConfigCommand(script);
    const model = readModelsConfig().providers.local!.models![0]!;
    assert.deepEqual(model, {
      id: "created-model",
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });
});

test("lock busy remains a distinct non-secret diagnostic and performs no write", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({ providers: { local: { baseUrl: "http://localhost:11434", api: "openai-completions", models: [{ id: "one" }] } } });
    const actions = new ModelConfigActions({ commitMutation: async () => ({ type: "busy" }) as any });
    const notifications: Array<{ message: string; level: string }> = [];
    const original = fs.readFileSync(getModelsPath());
    const panels = [panelResult("edit-field", "general", "name"), panelResult("back")];
    const ctx = scriptedContext({ selects: ["输入值"], inputs: ["New"], editors: [], confirms: [], customs: [] }, notifications);
    await runModelEditor(ctx, "local", "one", {
      actions,
      openPanel: async () => panels.shift()!,
    });
    assert.deepEqual(fs.readFileSync(getModelsPath()), original);
    assert.deepEqual(notifications, [{ message: "配置操作进行中，请稍后重试", level: "error" }]);
    assert.doesNotMatch(notifications[0]!.message, /New|one/);
  });
});

test("Model copy and delete route private payloads through identity actions", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({ providers: { local: {
      baseUrl: "http://localhost:11434",
      api: "openai-completions",
      models: [{ id: "source", future: { keep: true } }],
    } } });
    seedModelPayload("local", "source", { requestFlag: true });
    const actions = new ModelConfigActions();

    const copyPanels = [panelResult("run-action", "actions", "copy"), panelResult("back")];
    await runModelEditor(
      scriptedContext({ selects: [], inputs: [], editors: ["copy"], confirms: [true], customs: [] }),
      "local",
      "source",
      { actions, openPanel: async () => copyPanels.shift()! },
    );
    assert.deepEqual(readModelsConfig().providers.local!.models!.map((model) => model.id), ["source", "copy"]);
    assert.deepEqual(readModelPayload("local", "source"), { requestFlag: true });
    assert.deepEqual(readModelPayload("local", "copy"), { requestFlag: true });
    assert.deepEqual(readModelsConfig().providers.local!.models![1]!.future, { keep: true });

    const deletePanels = [panelResult("run-action", "actions", "delete")];
    await runModelEditor(
      scriptedContext({ selects: [], inputs: [], editors: [], confirms: [true, true], customs: [] }),
      "local",
      "copy",
      { actions, openPanel: async () => deletePanels.shift()! },
    );
    assert.deepEqual(readModelsConfig().providers.local!.models!.map((model) => model.id), ["source"]);
    assert.equal(readModelPayload("local", "copy"), undefined);
    assert.deepEqual(readModelPayload("local", "source"), { requestFlag: true });
    assert.equal(actions.boundPreviewCount(), 0);
  });
});

test("Native optional Model defaults delete own fields while preserving unknown persisted data", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({ providers: { local: {
      baseUrl: "http://localhost:11434",
      api: "openai-completions",
      models: [{
        id: "one",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 4096,
        maxTokens: 1024,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        future: { keep: true },
      }],
    } } });
    const actions = new ModelConfigActions();
    const panels = [
      panelResult("edit-field", "capability", "reasoning"),
      panelResult("edit-field", "capability", "input"),
      panelResult("edit-field", "capability", "contextWindow"),
      panelResult("edit-field", "capability", "maxTokens"),
      panelResult("edit-field", "cost", "input"),
      panelResult("back"),
    ];
    const selects = [
      "使用默认值",
      "使用默认值",
      "使用默认值",
      "使用默认值",
      "清除整个 Cost（使用默认值）",
    ];
    const ctx = { ui: { select: async () => selects.shift(), notify() {} } } as any;
    await runModelEditor(ctx, "local", "one", {
      actions,
      openPanel: async () => panels.shift()!,
      multiSelect: async () => { throw new Error("default input must not open explicit selection"); },
    });
    const saved = readModelsConfig().providers.local!.models![0]!;
    for (const key of ["reasoning", "input", "contextWindow", "maxTokens", "cost"]) {
      assert.equal(Object.hasOwn(saved, key), false, `${key} should be absent`);
    }
    assert.deepEqual(saved.future, { keep: true });
    assert.deepEqual(selects, []);
  });
});

test("Model rename drift restarts collision review and consumes refreshed tokens", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({ providers: { local: {
      baseUrl: "http://localhost:11434",
      api: "openai-completions",
      models: [{ id: "source" }],
    } } });
    const actions = new ModelConfigActions();
    const panels = [panelResult("edit-field", "general", "id"), panelResult("back")];
    const selects = ["复用目标 Payload"];
    let confirms = 0;
    const ctx = {
      ui: {
        input: async () => "target",
        select: async () => selects.shift(),
        confirm: async () => {
          confirms += 1;
          if (confirms === 1) seedModelPayload("local", "target", { external: true });
          return true;
        },
        notify() {},
      },
    } as any;
    await runModelEditor(ctx, "local", "source", { actions, openPanel: async () => panels.shift()! });
    assert.deepEqual(readModelsConfig().providers.local!.models!.map((model) => model.id), ["target"]);
    assert.deepEqual(readModelPayload("local", "target"), { external: true });
    assert.equal(readModelPayload("local", "source"), undefined);
    assert.equal(confirms, 2);
    assert.deepEqual(selects, []);
    assert.equal(actions.boundPreviewCount(), 0);
  });
});

test("Model controller blocks on a transaction journal without reading a panel or mutating files", async () => {
  await withRuntimeAgentDir(async (agentDir) => {
    writeModelsConfig({ providers: { local: { baseUrl: "http://localhost", api: "openai-completions", models: [{ id: "one" }] } } });
    seedModelPayload("local", "one", { keep: true });
    fs.writeFileSync(getTransactionJournalPath(agentDir), "{");
    const artifactPaths = [getModelsPath(agentDir), getPayloadConfigPath(agentDir), getTransactionJournalPath(agentDir)];
    const before = artifactPaths.map((filePath) => fs.readFileSync(filePath));
    const notifications: Array<{ message: string; level: string }> = [];
    await runModelEditor({ ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } } as any, "local", "one", {
      actions: new ModelConfigActions({ agentDir }),
      openPanel: async () => { throw new Error("panel must not open during recovery"); },
    });
    artifactPaths.forEach((filePath, index) => assert.deepEqual(fs.readFileSync(filePath), before[index]));
    assert.deepEqual(notifications, [{ message: "配置事务需要恢复后才能继续修改", level: "error" }]);
  });
});

for (const diagnostic of [
  { result: "collision", message: "配置锁发生冲突" },
  { result: "unsupported", message: "当前环境不支持配置锁" },
] as const) {
  test(`Model controller reports lock ${diagnostic.result} without data values`, async () => {
    await withRuntimeAgentDir(async () => {
      writeModelsConfig({ providers: { local: { baseUrl: "http://localhost", api: "openai-completions", models: [{ id: "one" }] } } });
      const actions = new ModelConfigActions({ commitMutation: async () => ({ type: diagnostic.result }) as any });
      const notifications: Array<{ message: string; level: string }> = [];
      const before = fs.readFileSync(getModelsPath());
      const panels = [panelResult("edit-field", "general", "name"), panelResult("back")];
      await runModelEditor(
        scriptedContext({ selects: ["输入值"], inputs: ["Changed"], editors: [], confirms: [], customs: [] }, notifications),
        "local",
        "one",
        { actions, openPanel: async () => panels.shift()! },
      );
      assert.equal(fs.readFileSync(getModelsPath()).equals(before), true);
      assert.deepEqual(notifications, [{ message: diagnostic.message, level: "error" }]);
      assert.doesNotMatch(notifications[0]!.message, /Changed|one/);
    });
  });
}
