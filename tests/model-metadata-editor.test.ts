import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ModelConfigActions } from "../config-actions.ts";
import { runModelEditor } from "../model-editor.ts";
import { emptyPayloadDocument, serializePayloadDocument } from "../payload-config.ts";
import type { ModelsConfig } from "../types.ts";

const targetId = "gpt6-astra";
const sourceModel = {
  type: "chat", provider: "azure", id: "gpt-6-astra", name: "GPT-6 Astra",
  api: "openai-responses", baseUrl: "https://source.invalid", headers: { "X-Source": "must-not-copy" },
  reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000,
  cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  thinkingLevelMap: { low: "low", max: "max" }, compat: { supportsStore: false },
  futureCatalogField: "must-not-copy",
};

async function withEditor(run: (fixture: {
  dir: string; actions: ModelConfigActions; read: () => ModelsConfig;
  original: string; payloadBytes: Buffer;
}) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-metadata-editor-"));
  const config: ModelsConfig = { providers: { local: {
    api: "openai-completions", baseUrl: "https://target.invalid", apiKey: "$LOCAL_KEY",
    models: [
      { id: targetId, name: "Old", reasoning: false, input: ["text"], contextWindow: 128000,
        maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { high: "old" }, compat: { supportsStore: true, supportsTemperature: false },
        promptCache: { short: 300 }, headers: { "X-Local": "keep" },
        baseUrl: "https://model-target.invalid", futureLocal: { keep: true } },
      { id: "other", name: "Untouched" },
    ],
  } } };
  const original = `${JSON.stringify(config, null, 2)}\n`;
  const payload = emptyPayloadDocument();
  payload.extraPayloads[JSON.stringify(["local", targetId])] = { top_p: 0.73, marker: "synthetic-private-value" };
  const payloadBytes = Buffer.from(serializePayloadDocument(payload));
  fs.writeFileSync(path.join(dir, "models.json"), original);
  fs.writeFileSync(path.join(dir, "model-config-payloads.json"), payloadBytes);
  try {
    await run({ dir, actions: new ModelConfigActions({ agentDir: dir }), original, payloadBytes,
      read: () => JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function panelResult(type: "back" | "run-action") {
  return { type, categoryId: "actions", fieldId: "metadata",
    state: { categoryId: "actions", fieldId: "metadata", focusedPane: "fields" as const, narrowScreen: "fields" as const,
      categoryScrollOffset: 0, fieldScrollOffset: 0 } };
}

for (const accept of [true, false]) {
  test(`metadata search ${accept ? "applies only to the selected model atomically" : "cancellation preserves both files byte-for-byte"}`, async () => {
    await withEditor(async ({ dir, actions, read, original, payloadBytes }) => {
      const previousFetch = globalThis.fetch;
      const requests: string[] = [];
      globalThis.fetch = async (url, init) => {
        requests.push(String(url));
        assert.equal(new Headers(init?.headers).has("Authorization"), false);
        return new Response(JSON.stringify({
          azure: { "gpt-6-astra": sourceModel },
          openai: { "gpt-6-astra": { ...sourceModel, provider: "openai" } },
        }), { status: 200, headers: { "content-type": "application/json", etag: '"catalog-1"' } });
      };
      let panels = 0;
      let confirmations = 0;
      const messages: string[] = [];
      try {
        await runModelEditor({ ui: {
          notify: (message: string) => messages.push(message),
          confirm: async () => assert.fail("metadata preview must stay bounded and scrollable"),
          custom: async (factory: any) => {
            confirmations += 1;
            let applied = false;
            const component = factory({ terminal: { rows: 24 }, requestRender() {} }, {
              fg: (_color: string, text: string) => text,
            }, {
              matches: (data: string, action: string) => data === ({
                "tui.select.down": "DOWN", "tui.select.up": "UP",
                "tui.select.confirm": "OK", "tui.select.cancel": "CANCEL",
              } as Record<string, string>)[action],
            }, (value: boolean) => { applied = value; });
            const pages: string[] = [];
            for (const width of [40, 100]) {
              for (let step = 0; step < 100; step++) {
                const lines = component.render(width);
                assert.ok(lines.length <= 18, "preview must fit in the terminal");
                assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
                pages.push(lines.join("\n"));
                component.handleInput("DOWN");
              }
            }
            const description = pages.join("\n");
            assert.match(description, /azure/);
            assert.match(description, /contextWindow/);
            assert.match(description, /1000000/);
            assert.match(description, /openai-responses/);
            component.handleInput(accept ? "OK" : "CANCEL");
            return applied;
          },
        } } as any, "local", targetId, {
          actions,
          openPanel: async (_ctx, panel) => {
            if (panels++ === 0) {
              assert.ok(panel.categories.flatMap(category => category.fields).some(field => field.id === "metadata"),
                "single-model editor must expose the metadata search action");
              return panelResult("run-action");
            }
            return panelResult("back");
          },
          search: async (_ctx, _title, options, config) => {
            assert.equal(config?.initialQuery, targetId);
            assert.equal(config?.searchTextOnly, true);
            assert.equal(options.length, 2, "same model ID from different providers must stay separate");
            assert.ok(options.every(option => option.searchText === "gpt-6-astra"));
            return options.find(option => option.label?.includes("azure"))!.value;
          },
        });
      } finally { globalThis.fetch = previousFetch; }
      assert.equal(confirmations, 1);
      assert.equal(requests.length, 1);
      assert.match(requests[0]!, /^https:\/\/pi\.dev\/api\/models\?pi-version=\d+\.\d+\.\d+/);
      assert.deepEqual(fs.readFileSync(path.join(dir, "model-config-payloads.json")), payloadBytes);
      if (!accept) {
        assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), original);
        return;
      }
      const provider = read().providers.local!;
      const target = provider.models![0]!;
      assert.equal(target.id, targetId);
      assert.equal(target.name, "GPT-6 Astra");
      assert.equal(target.reasoning, true);
      assert.deepEqual(target.input, ["text", "image"]);
      assert.equal(target.contextWindow, 1000000);
      assert.equal(target.maxTokens, 128000);
      assert.deepEqual(target.cost, { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 });
      assert.deepEqual(target.thinkingLevelMap, { low: "low", max: "max" });
      assert.deepEqual(target.compat, { supportsStore: false });
      assert.equal(Object.hasOwn(target, "promptCache"), false, "absent source metadata must not leave stale target metadata");
      assert.equal(target.baseUrl, "https://model-target.invalid");
      assert.deepEqual(target.headers, { "X-Local": "keep" });
      assert.deepEqual(target.futureLocal, { keep: true });
      for (const key of ["provider", "type", "api", "futureCatalogField"]) assert.equal(Object.hasOwn(target, key), false);
      assert.equal(provider.api, "openai-completions");
      assert.equal(provider.baseUrl, "https://target.invalid");
      assert.equal(provider.apiKey, "$LOCAL_KEY");
      assert.deepEqual(provider.models![1], { id: "other", name: "Untouched" });
      assert.ok(messages.some(message => /保存/.test(message)));
    });
  });
}

for (const scenario of ["cancel-picker", "network-failure", "source-unchanged", "metadata-drift", "unrelated-drift"] as const) {
  test(`metadata application handles ${scenario} without losing stored data`, async (t) => {
    await withEditor(async ({ dir, actions, read, original, payloadBytes }) => {
      const modelPath = path.join(dir, "models.json");
      const source = scenario === "source-unchanged"
        ? { ...read().providers.local!.models![0], id: sourceModel.id, provider: "azure", api: "openai-completions" }
        : sourceModel;
      t.mock.method(globalThis, "fetch", async () => {
        if (scenario === "network-failure") throw new Error("network unavailable");
        return new Response(JSON.stringify({ azure: { [sourceModel.id]: source } }));
      });
      let panels = 0;
      let externalBytes = original;
      let previews = 0;
      const messages: string[] = [];
      await runModelEditor({ ui: {
        notify: (message: string) => messages.push(message),
        custom: async (factory: any) => {
          previews += 1;
          assert.ok(scenario.endsWith("drift"));
          const external = read();
          if (scenario === "metadata-drift") external.providers.local!.models![0]!.contextWindow = 777777;
          else external.providers.local!.models![0]!.headers = { "X-External": "keep" };
          externalBytes = `${JSON.stringify(external, null, 2)}\n`;
          fs.writeFileSync(modelPath, externalBytes);
          let result = false;
          const component = factory({ terminal: { rows: 24 }, requestRender() {} }, {
            fg: (_color: string, text: string) => text,
          }, { matches: (data: string, action: string) => data === "OK" && action === "tui.select.confirm" },
          (value: boolean) => { result = value; });
          component.render(80);
          component.handleInput("OK");
          return result;
        },
      } } as any, "local", targetId, {
        actions,
        openPanel: async () => panels++ === 0 ? panelResult("run-action") : panelResult("back"),
        search: async (_ctx, _title, options) => {
          assert.notEqual(scenario, "network-failure");
          return scenario === "cancel-picker" ? undefined : options[0]!.value;
        },
      });
      assert.deepEqual(fs.readFileSync(path.join(dir, "model-config-payloads.json")), payloadBytes);
      if (scenario === "unrelated-drift") {
        assert.equal(previews, 1);
        assert.deepEqual(read().providers.local!.models![0]!.headers, { "X-External": "keep" });
        assert.equal(read().providers.local!.models![0]!.contextWindow, 1000000);
        assert.ok(messages.some(message => /保存/.test(message)));
      } else {
        assert.equal(fs.readFileSync(modelPath, "utf8"), externalBytes);
        assert.equal(previews, scenario === "metadata-drift" ? 1 : 0);
        if (scenario === "metadata-drift") assert.ok(messages.some(message => /外部修改/.test(message)));
        if (scenario === "source-unchanged") assert.ok(messages.some(message => /一致/.test(message)));
        if (scenario === "network-failure") assert.ok(messages.includes("network unavailable"));
      }
    });
  });
}
