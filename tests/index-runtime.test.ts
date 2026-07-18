import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import extension from "../index.ts";
import { ModelConfigActions } from "../config-actions.ts";
import { getModelsPath, readModelsConfig, writeModelsConfig } from "../config.ts";
import { getPayloadConfigPath, lookupModelPayload, readPayloadConfig, serializePayloadDocument, setPayloadDocumentValue } from "../payload-config.ts";
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
