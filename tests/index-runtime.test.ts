import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../index.ts";
import { readModelsConfig, writeModelsConfig } from "../config.ts";
import {
  getPayloadConfigPath,
  lookupModelPayload,
  readPayloadConfig,
  serializePayloadDocument,
  setPayloadDocumentValue,
} from "../payload-config.ts";

function seedModelPayload(provider: string, modelId: string, payload: Record<string, unknown>): void {
  const next = setPayloadDocumentValue(readPayloadConfig(), provider, modelId, payload);
  fs.writeFileSync(getPayloadConfigPath(), serializePayloadDocument(next), { mode: 0o600 });
}

function readModelPayload(provider: string, modelId: string): Record<string, unknown> | undefined {
  return lookupModelPayload(readPayloadConfig(), provider, modelId);
}

interface ScriptedUi {
  selects: string[];
  editors: string[];
  confirms: boolean[];
  customs: string[];
}

interface CommandHooks {
  notifications?: Array<{ message: string; level: string }>;
  onSelect?: (value: string) => void;
  onEditor?: (value: string) => void;
}

function take<T>(values: T[], label: string): T {
  const value = values.shift();
  assert.notEqual(value, undefined, `missing scripted ${label} response`);
  return value as T;
}

function scriptedContext(script: ScriptedUi, hooks: CommandHooks = {}): any {
  return {
    ui: {
      select: async () => {
        const value = take(script.selects, "select");
        hooks.onSelect?.(value);
        return value;
      },
      editor: async () => {
        const value = take(script.editors, "editor");
        hooks.onEditor?.(value);
        return value;
      },
      confirm: async () => take(script.confirms, "confirm"),
      custom: async () => take(script.customs, "custom select"),
      notify: (message: string, level: string) => hooks.notifications?.push({ message, level }),
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

async function runModelConfigCommand(script: ScriptedUi, hooks: CommandHooks = {}): Promise<void> {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  await extension({
    registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
      if (name === "model-config") handler = command.handler;
    },
    registerProvider: () => {},
    on: () => {},
  } as any);
  assert.ok(handler, "model-config command should be registered");
  await handler!("", scriptedContext(script, hooks));
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
    seedModelPayload("local", "one", { temperature: 0.4 });
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
        local: { baseUrl: "http://localhost:11434", api: "openai-completions", models: [{ id: "old", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
      },
    });
    seedModelPayload("local", "old", { inherited: true });

    await runModelConfigCommand(modelEditScript("new", "edit"));

    const saved = readModelsConfig().providers.local!.models![0]!;
    assert.equal(saved.id, "new");
    assert.equal(Object.hasOwn(saved, "extraPayload"), false);
    assert.deepEqual(readModelPayload("local", "new"), { inherited: false });
    assert.equal(readModelPayload("local", "old"), undefined);
  });
});

test("successful model rename keeps an explicitly cleared destination payload cleared", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({
      providers: {
        local: { baseUrl: "http://localhost:11434", api: "openai-completions", models: [{ id: "old", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
      },
    });
    seedModelPayload("local", "old", { inherited: true });

    await runModelConfigCommand(modelEditScript("new", "clear"));

    const saved = readModelsConfig().providers.local!.models![0]!;
    assert.equal(saved.id, "new");
    assert.equal(readModelPayload("local", "new"), undefined);
    assert.equal(readModelPayload("local", "old"), undefined);
  });
});

test("successful model edit removes an invalid legacy extraPayload instead of persisting it", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({
      providers: {
        local: {
          baseUrl: "http://localhost:11434",
          api: "openai-completions",
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
    assert.equal(readModelPayload("local", "old"), undefined);
  });
});

test("successful model copy removes legacy extraPayload and copies the private payload", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({
      providers: {
        local: {
          baseUrl: "http://localhost:11434",
          api: "openai-completions",
          models: [{
            id: "old", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            extraPayload: [{ key: "broken", type: "json", value: "{" }],
          }],
        },
      },
    });
    seedModelPayload("local", "old", { seed: 7 });

    await runModelConfigCommand({
      selects: ["管理 Providers", "编辑 [local]", "管理 Models", "复制", "返回主菜单", "退出"],
      editors: [],
      confirms: [],
      customs: ["model:0", "__pi_model_config_action:back"],
    });

    const copied = readModelsConfig().providers.local!.models![1]!;
    assert.equal(copied.id, "old-copy");
    assert.equal(Object.hasOwn(copied, "extraPayload"), false);
    assert.deepEqual(readModelPayload("local", "old"), { seed: 7 });
    assert.deepEqual(readModelPayload("local", "old-copy"), { seed: 7 });
  });
});

test("provider rename collision preserves both native providers and private payloads", async () => {
  await withRuntimeAgentDir(async () => {
    const initial = {
      providers: {
        source: {
          name: "Source",
          baseUrl: "http://localhost:11434",
          api: "openai-completions",
          models: [{ id: "source/model" }],
        },
        target: {
          name: "Target",
          baseUrl: "http://localhost:11434",
          api: "anthropic-messages",
          models: [{ id: "target/model" }],
        },
      },
    };
    writeModelsConfig(initial);
    seedModelPayload("source", "source/model", { owner: "source" });
    seedModelPayload("target", "target/model", { owner: "target" });
    const notifications: Array<{ message: string; level: string }> = [];

    await runModelConfigCommand({
      selects: [
        "管理 Providers", "编辑 [source]", "编辑设置",
        "openai-completions - OpenAI Chat Completions", "否 - 不自动添加 Bearer",
        "返回主菜单", "退出",
      ],
      editors: ["target", "Source", "", ""],
      confirms: [false],
      customs: [],
    }, { notifications });

    assert.deepEqual(readModelsConfig(), initial);
    assert.deepEqual(readModelPayload("source", "source/model"), { owner: "source" });
    assert.deepEqual(readModelPayload("target", "target/model"), { owner: "target" });
    assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("target") && message.includes("已存在")));
  });
});

test("provider copy collision preserves both native providers and private payloads", async () => {
  await withRuntimeAgentDir(async () => {
    const initial = {
      providers: {
        source: { baseUrl: "http://localhost:11434", api: "openai-completions", models: [{ id: "source/model" }] },
        target: { baseUrl: "http://localhost:11434", api: "openai-completions", models: [{ id: "target/model" }] },
      },
    };
    writeModelsConfig(initial);
    seedModelPayload("source", "source/model", { owner: "source" });
    seedModelPayload("target", "target/model", { owner: "target" });
    const notifications: Array<{ message: string; level: string }> = [];

    await runModelConfigCommand({
      selects: ["管理 Providers", "编辑 [source]", "复制 Provider", "返回主菜单", "退出"],
      editors: ["target"],
      confirms: [],
      customs: [],
    }, { notifications });

    assert.deepEqual(readModelsConfig(), initial);
    assert.deepEqual(readModelPayload("source", "source/model"), { owner: "source" });
    assert.deepEqual(readModelPayload("target", "target/model"), { owner: "target" });
    assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("target") && message.includes("已存在")));
  });
});

test("successful provider copy copies payloads for every copied model", async () => {
  await withRuntimeAgentDir(async () => {
    writeModelsConfig({
      providers: {
        "source/provider": {
          baseUrl: "http://localhost:11434",
          api: "openai-completions",
          models: [{ id: "model/one" }, { id: "model/two" }],
        },
      },
    });
    seedModelPayload("source/provider", "model/one", { seed: 7 });
    seedModelPayload("source/provider", "model/two", { temperature: 0.2 });

    await runModelConfigCommand({
      selects: ["管理 Providers", "编辑 [source/provider]", "复制 Provider", "返回主菜单", "退出"],
      editors: ["target/provider"],
      confirms: [],
      customs: [],
    });

    assert.deepEqual(readModelsConfig().providers["target/provider"], readModelsConfig().providers["source/provider"]);
    assert.deepEqual(readModelPayload("target/provider", "model/one"), { seed: 7 });
    assert.deepEqual(readModelPayload("target/provider", "model/two"), { temperature: 0.2 });
  });
});

test("provider copy does not write payloads when blank native persistence fails", async () => {
  await withRuntimeAgentDir(async (agentDir) => {
    writeModelsConfig({ providers: { source: { baseUrl: "http://localhost:11434", api: "openai-completions", models: [{ id: "model" }] } } });
    seedModelPayload("source", "model", { seed: 7 });
    const modelsPath = path.join(agentDir, "models.json");
    const blank = " \r\n\t";
    let corrupted = false;

    await runModelConfigCommand({
      selects: ["管理 Providers", "编辑 [source]", "复制 Provider", "返回主菜单", "退出"],
      editors: ["target"],
      confirms: [],
      customs: [],
    }, {
      onEditor: () => {
        if (corrupted) return;
        corrupted = true;
        fs.writeFileSync(modelsPath, blank);
      },
    });

    assert.equal(fs.readFileSync(modelsPath, "utf8"), blank);
    assert.deepEqual(readModelPayload("source", "model"), { seed: 7 });
    assert.equal(readModelPayload("target", "model"), undefined);
  });
});

test("model copy does not write payloads when blank native persistence fails", async () => {
  await withRuntimeAgentDir(async (agentDir) => {
    writeModelsConfig({ providers: { local: { baseUrl: "http://localhost:11434", api: "openai-completions", models: [{ id: "model" }] } } });
    seedModelPayload("local", "model", { seed: 7 });
    const modelsPath = path.join(agentDir, "models.json");
    const blank = " \r\n\t";
    let corrupted = false;

    await runModelConfigCommand({
      selects: ["管理 Providers", "编辑 [local]", "管理 Models", "复制", "返回主菜单", "退出"],
      editors: [],
      confirms: [],
      customs: ["model:0", "__pi_model_config_action:back"],
    }, {
      onSelect: (value) => {
        if (corrupted || value !== "复制") return;
        corrupted = true;
        fs.writeFileSync(modelsPath, blank);
      },
    });

    assert.equal(fs.readFileSync(modelsPath, "utf8"), blank);
    assert.deepEqual(readModelPayload("local", "model"), { seed: 7 });
    assert.equal(readModelPayload("local", "model-copy"), undefined);
  });
});

test("diagnostics reports a whitespace-only models file as unreadable", async () => {
  await withRuntimeAgentDir(async (agentDir) => {
    writeModelsConfig({ providers: { local: { baseUrl: "http://localhost:11434", models: [] } } });
    const modelsPath = path.join(agentDir, "models.json");
    const blank = " \r\n\t";
    const notifications: Array<{ message: string; level: string }> = [];

    await runModelConfigCommand({
      selects: ["诊断：检查 models.json 状态", "退出"],
      editors: [],
      confirms: [],
      customs: [],
    }, {
      notifications,
      onSelect: (value) => {
        if (value.startsWith("诊断")) fs.writeFileSync(modelsPath, blank);
      },
    });

    assert.equal(fs.readFileSync(modelsPath, "utf8"), blank);
    assert.ok(notifications.some(({ message, level }) => level === "error" && message.includes("file is blank")));
  });
});
