import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../index.ts";
import { readModelsConfig, writeModelsConfig } from "../config.ts";
import { getModelPayload, setModelPayload } from "../payload-config.ts";

interface ScriptedUi {
  selects: string[];
  editors: string[];
  confirms: boolean[];
  customs: string[];
}

function take<T>(values: T[], label: string): T {
  const value = values.shift();
  assert.notEqual(value, undefined, `missing scripted ${label} response`);
  return value as T;
}

function scriptedContext(script: ScriptedUi): any {
  return {
    ui: {
      select: async () => take(script.selects, "select"),
      editor: async () => take(script.editors, "editor"),
      confirm: async () => take(script.confirms, "confirm"),
      custom: async () => take(script.customs, "custom select"),
      notify: () => {},
    },
  };
}

async function withRuntimeAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-runtime-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

async function runModelConfigCommand(script: ScriptedUi): Promise<void> {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  await extension({
    registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
      if (name === "model-config") handler = command.handler;
    },
    registerProvider: () => {},
    on: () => {},
  } as any);
  assert.ok(handler, "model-config command should be registered");
  await handler!("", scriptedContext(script));
  assert.deepEqual(script, { selects: [], editors: [], confirms: [], customs: [] });
}

function modelEditScript(modelId: string, payloadEdit?: "edit" | "clear"): ScriptedUi {
  const payloadChoices = payloadEdit === "edit"
    ? ["1. [bool] inherited = true", "修改", "false", "完成"]
    : payloadEdit === "clear"
      ? ["1. [bool] inherited = true", "删除", "完成"]
      : [];
  return {
    selects: [
      "管理 Providers", "编辑 [local]", "管理 Models", "编辑",
      "否", "仅文本", ...payloadChoices, "返回主菜单", "退出",
    ],
    editors: [modelId, "", "128000", "16384", "0", "0"],
    confirms: [false, false, payloadEdit !== undefined],
    customs: ["model:0", "__pi_model_config_action:back"],
  };
}

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

test("successful model rename keeps an explicitly edited destination payload and removes the old identity", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({
      providers: {
        local: { models: [{ id: "old", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
      },
    });
    setModelPayload("local", "old", { inherited: true });

    await runModelConfigCommand(modelEditScript("new", "edit"));

    const saved = readModelsConfig().providers.local!.models![0]!;
    assert.equal(saved.id, "new");
    assert.equal(Object.hasOwn(saved, "extraPayload"), false);
    assert.deepEqual(getModelPayload("local", "new"), { inherited: false });
    assert.equal(getModelPayload("local", "old"), undefined);
  });
});

test("successful model rename keeps an explicitly cleared destination payload cleared", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({
      providers: {
        local: { models: [{ id: "old", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
      },
    });
    setModelPayload("local", "old", { inherited: true });

    await runModelConfigCommand(modelEditScript("new", "clear"));

    const saved = readModelsConfig().providers.local!.models![0]!;
    assert.equal(saved.id, "new");
    assert.equal(getModelPayload("local", "new"), undefined);
    assert.equal(getModelPayload("local", "old"), undefined);
  });
});

test("successful model edit removes an invalid legacy extraPayload instead of persisting it", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({
      providers: {
        local: {
          models: [{
            id: "old", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            extraPayload: [{ key: "broken", type: "json", value: "{" }],
          }],
        },
      },
    });

    await runModelConfigCommand(modelEditScript("old"));

    const saved = readModelsConfig().providers.local!.models![0]!;
    assert.equal(Object.hasOwn(saved, "extraPayload"), false);
    assert.equal(getModelPayload("local", "old"), undefined);
  });
});

test("successful model copy removes legacy extraPayload from the copied native model", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({
      providers: {
        local: {
          models: [{
            id: "old", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            extraPayload: [{ key: "broken", type: "json", value: "{" }],
          }],
        },
      },
    });

    await runModelConfigCommand({
      selects: ["管理 Providers", "编辑 [local]", "管理 Models", "复制", "返回主菜单", "退出"],
      editors: [],
      confirms: [],
      customs: ["model:0", "__pi_model_config_action:back"],
    });

    const copied = readModelsConfig().providers.local!.models![1]!;
    assert.equal(copied.id, "old-copy");
    assert.equal(Object.hasOwn(copied, "extraPayload"), false);
  });
});
