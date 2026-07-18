import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import extension, { runRecoveryDiagnostics } from "../index.ts";
import { ModelConfigActions } from "../config-actions.ts";
import { getModelsPath, readModelsConfig, writeModelsConfig } from "../config.ts";
import { getPayloadConfigPath, lookupModelPayload, readPayloadConfig, serializePayloadDocument, setPayloadDocumentValue } from "../payload-config.ts";
import { getTransactionJournalPath } from "../payload-coordinator.ts";
import { tryAcquireMutationLock } from "../process-lock.ts";
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
    mode: "tui",
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

async function commandHandler(): Promise<(args: string, ctx: any) => Promise<void>> {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  await extension({
    registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
      if (name === "model-config") handler = command.handler;
    },
    registerProvider: () => { throw new Error("native providers must not be re-registered"); },
    on: () => {},
  } as any);
  assert.ok(handler);
  return handler;
}

async function runModelConfigCommand(script: Script, notifications: Array<{ message: string; level: string }> = []): Promise<void> {
  const handler = await commandHandler();
  await handler("", scriptedContext(script, notifications));
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

test("non-TUI command exits before prompts or storage mutation with a generic message", async () => {
  await withRuntimeAgentDir(async (agentDir) => {
    const nativePath = getModelsPath(agentDir);
    const payloadPath = getPayloadConfigPath(agentDir);
    fs.writeFileSync(nativePath, "{ malformed-native-marker");
    fs.writeFileSync(payloadPath, "{ malformed-payload-marker", { mode: 0o600 });
    const before = [fs.readFileSync(nativePath), fs.readFileSync(payloadPath)];
    const notifications: Array<{ message: string; level: string }> = [];
    const handler = await commandHandler();
    await handler("", {
      mode: "rpc",
      ui: {
        select: async () => { throw new Error("non-TUI command must not prompt"); },
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    });
    assert.deepEqual(fs.readFileSync(nativePath), before[0]);
    assert.deepEqual(fs.readFileSync(payloadPath), before[1]);
    assert.equal(fs.existsSync(getTransactionJournalPath(agentDir)), false);
    assert.deepEqual(notifications, [{ message: "模型配置编辑器仅支持交互式 TUI；未读取或修改配置", level: "error" }]);
    assert.doesNotMatch(notifications[0]!.message, /marker|models\.json|payload/i);
  });
});

test("top-level diagnostics previews malformed journal recovery after releasing the IPC lock and Cancel is byte-stable", async () => {
  await withRuntimeAgentDir(async (agentDir) => {
    writeModelsConfig({ providers: { local: { baseUrl: "http://localhost", api: "openai-completions", models: [{ id: "one" }] } } });
    seedModelPayload("local", "one", { fixtureFlag: true });
    fs.writeFileSync(getTransactionJournalPath(agentDir), "{ malformed journal\n", { mode: 0o600 });
    const artifactPaths = [getModelsPath(agentDir), getPayloadConfigPath(agentDir), getTransactionJournalPath(agentDir)];
    const before = artifactPaths.map((filePath) => fs.readFileSync(filePath));
    const handler = await commandHandler();
    const notifications: Array<{ message: string; level: string }> = [];
    let mainPrompts = 0;
    let previewPrompts = 0;

    await handler("", {
      mode: "tui",
      ui: {
        select: async (title: string, options: string[]) => {
          if (title === "模型配置编辑器") {
            mainPrompts += 1;
            return mainPrompts === 1 ? "诊断与事务恢复" : "退出";
          }
          assert.equal(title, "配置恢复预览");
          previewPrompts += 1;
          assert.match(options.join("|"), /接受当前文件/);
          assert.match(options.join("|"), /取消/);
          assert.match(options.join("|"), /重试/);
          const contender = await tryAcquireMutationLock(agentDir);
          assert.equal(contender.type, "acquired", "recovery preview opened while coordinator still owned the lock");
          if (contender.type === "acquired") await contender.handle.release();
          return "取消";
        },
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    });

    assert.equal(previewPrompts, 1);
    artifactPaths.forEach((filePath, index) => assert.deepEqual(fs.readFileSync(filePath), before[index]));
    assert.doesNotMatch(JSON.stringify(notifications), /fixtureFlag|malformed journal/i);
  });
});

test("recovery diagnostics handles automatic and refreshed manual recovery without prompting under lock", async () => {
  let lockOwned = false;
  const prompts: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const selects = ["恢复事务前状态", "恢复事务后状态"];
  const inspections = [
    { type: "automatic-recovered" as const },
    { type: "needs-choice" as const, snapshotToken: "token-one", choices: ["restore-before-payload" as const] },
    { type: "needs-choice" as const, snapshotToken: "token-two", choices: ["restore-after-payload" as const] },
  ];
  const applied: Array<[string, string]> = [];
  const context = {
    mode: "tui",
    ui: {
      select: async (_title: string, options: string[]) => {
        assert.equal(lockOwned, false, "prompt opened while recovery lock was owned");
        prompts.push(options.join("|"));
        return selects.shift();
      },
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as any;
  const recovery = {
    inspect: async () => {
      lockOwned = true;
      const result = inspections.shift();
      lockOwned = false;
      assert.ok(result);
      return result;
    },
    apply: async (token: string, choice: string) => {
      lockOwned = true;
      applied.push([token, choice]);
      const result = token === "token-one" ? { type: "refresh" as const } : { type: "recovered" as const };
      lockOwned = false;
      return result;
    },
  };

  assert.equal(await runRecoveryDiagnostics(context, recovery), "ready");
  assert.equal(await runRecoveryDiagnostics(context, recovery), "ready");
  assert.deepEqual(applied, [
    ["token-one", "restore-before-payload"],
    ["token-two", "restore-after-payload"],
  ]);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /取消/);
  assert.match(prompts[0]!, /重试/);
  assert.match(notifications.map((entry) => entry.message).join("\n"), /自动恢复完成/);
  assert.match(notifications.map((entry) => entry.message).join("\n"), /状态已变化/);
  assert.match(notifications.map((entry) => entry.message).join("\n"), /恢复完成/);
});

for (const diagnostic of ["busy", "collision", "unsupported"] as const) {
  test(`recovery diagnostics reports ${diagnostic} generically and offers retry or cancel`, async () => {
    const notifications: Array<{ message: string; level: string }> = [];
    let calls = 0;
    const result = await runRecoveryDiagnostics({
      mode: "tui",
      ui: {
        select: async (_title: string, options: string[]) => {
          assert.deepEqual(options, ["重试", "取消"]);
          return calls === 1 ? "重试" : "取消";
        },
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    } as any, {
      inspect: async () => {
        calls += 1;
        return { type: diagnostic };
      },
      apply: async () => { throw new Error("diagnostic outcome must not apply recovery"); },
    });
    assert.equal(result, "cancelled");
    assert.equal(calls, 2);
    const output = notifications.map((entry) => entry.message).join("\n");
    assert.doesNotMatch(output, /secret-value|token|path|payload|provider|model/i);
    assert.doesNotMatch(output, /force|unlock|强制|解锁/i);
  });
}

test("recovery apply handle loss is generic and Retry re-inspects through a fresh endpoint", async () => {
  const results = [
    { type: "needs-choice" as const, snapshotToken: "opaque", choices: ["accept-current" as const] },
    { type: "clean" as const },
  ];
  const notifications: Array<{ message: string; level: string }> = [];
  const selections = ["接受当前文件并隔离损坏日志", "重试"];
  const result = await runRecoveryDiagnostics({
    mode: "tui",
    ui: {
      select: async () => selections.shift(),
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as any, {
    inspect: async () => results.shift()!,
    apply: async () => { throw new Error("endpoint-lost private-marker"); },
  });
  assert.equal(result, "ready");
  assert.deepEqual(results, []);
  assert.deepEqual(selections, []);
  assert.doesNotMatch(JSON.stringify(notifications), /endpoint-lost|private-marker/);
});

test("recovery retry routes a released crashed endpoint to a fresh clean inspection", async () => {
  const results = [{ type: "busy" as const }, { type: "clean" as const }];
  const result = await runRecoveryDiagnostics({
    mode: "tui",
    ui: {
      select: async () => "重试",
      notify() {},
    },
  } as any, {
    inspect: async () => results.shift()!,
    apply: async () => { throw new Error("clean retry must not apply recovery"); },
  });
  assert.equal(result, "ready");
  assert.deepEqual(results, []);
});

test("index has no reachable linear Provider or Model editor pipeline", () => {
  const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  for (const obsolete of ["editProvider", "editModel", "manageProviders", "manageModels", "editExtraPayload", "editCompat"]) {
    assert.doesNotMatch(source, new RegExp(`(?:async\\s+)?function\\s+${obsolete}\\b`), obsolete);
  }
  assert.doesNotMatch(source, /from "\.\/config\.ts";[^\n]*writeModelsConfig/);
  assert.doesNotMatch(source, /from "\.\/payload-config\.ts";[^\n]*(?:writePayloadConfig|savePayloadConfig)/);
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
