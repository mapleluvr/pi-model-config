// Run with a Pi coding-agent package directory, e.g.:
// node docs/research/pi-dev-model-cards/editor-probe.mjs node_modules/@earendil-works/pi-coding-agent
// Drives the real loaded command and TUI components with synthetic files. Only the public catalog uses network.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = resolve(process.argv[2] ?? join(project, "node_modules/@earendil-works/pi-coding-agent"));
const load = (file) => import(pathToFileURL(file).href);
const workRoot = join(project, ".worktrees/model-metadata-probe");
await mkdir(workRoot, { recursive: true });
const scratch = await mkdtemp(join(workRoot, "run-"));
const originalFetch = globalThis.fetch;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
process.env.PI_OFFLINE = "1";
const requests = [];
const screens = [];
let catalogBody;
try {
  const { loadExtensions } = await load(join(packageRoot, "dist/core/extensions/loader.js"));
  const { VERSION } = await load(join(packageRoot, "dist/config.js"));
  const { KeybindingsManager } = await load(join(packageRoot, "dist/core/keybindings.js"));
  const hostRequire = createRequire(join(packageRoot, "dist/index.js"));
  const { visibleWidth } = await load(hostRequire.resolve("@earendil-works/pi-tui"));
  const bindings = new KeybindingsManager();
  const modelsPath = join(scratch, "models.json");
  const payloadPath = join(scratch, "model-config-payloads.json");
  const targetId = "gpt6-astra";
  const providerId = "metadata-probe";
  const native = { providers: { [providerId]: {
    api: "openai-completions", baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic-never-sent",
    models: [{ id: targetId, name: "Before", reasoning: false, input: ["text"], contextWindow: 100,
      maxTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      headers: { "X-Synthetic": "keep" }, localOnly: true }, { id: "untouched", name: "Other" }],
  } } };
  const payload = `${JSON.stringify({ version: 1, extraPayloads: {
    [JSON.stringify([providerId, targetId])]: { marker: "synthetic-private-value" },
  } })}\n`;
  const originalNative = `${JSON.stringify(native, null, 2)}\n`;
  await writeFile(payloadPath, payload);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `https://pi.dev/api/models?pi-version=${VERSION}`);
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    requests.push(String(url));
    const response = await originalFetch(url, init);
    assert.equal(response.status, 200);
    catalogBody = await response.clone().json();
    return response;
  };
  const loaded = await loadExtensions([join(project, "index.ts")], scratch);
  assert.deepEqual(loaded.errors, []);
  const command = loaded.extensions[0]?.commands.get("model-config");
  assert.ok(command, "the extension must register the production command");

  for (const accept of [false, true]) {
    await writeFile(modelsPath, originalNative);
    let step = 0;
    let menuCount = 0;
    let applied = false;
    const messages = [];
    const ctx = {
      mode: "tui", cwd: scratch,
      ui: {
        notify: (message, level) => messages.push({ message, level }),
        select: async (_title, options) => menuCount++ === 0 ? options.find(option => option.startsWith("管理 Providers")) : "退出",
        custom: async (factory) => {
          const current = step++;
          let finished = false;
          let result;
          const component = await factory({ terminal: { rows: 28, columns: 100 }, requestRender() {} }, {
            fg: (_color, value) => value,
          }, bindings, (value) => { result = value; finished = true; });
          component.focused = true;
          const render = (width = 100) => {
            const lines = component.render(width);
            assert.ok(lines.every(line => visibleWidth(line) <= width), `screen ${current} exceeds ${width} columns`);
            return lines.join("\n");
          };
          const send = (key) => { component.handleInput(key); if (!finished) render(); };
          const down = "\u001b[B";
          const up = "\u001b[A";
          const left = "\u001b[D";
          const right = "\u001b[C";
          const enter = "\r";
          const cancel = "\u001b";
          const opening = render();
          if (current === 0 || current === 2) send(enter);
          else if (current === 1) {
            send(left); send(down); send(down); send(right); send(enter);
          } else if (current === 3) {
            send(left); send(up); send(right);
            assert.match(render(), /搜索模型元数据/);
            send(enter);
          } else if (current === 4) {
            assert.match(opening, /搜索模型元数据 · pi.dev/, JSON.stringify({ opening, messages }));
            assert.match(opening, /gpt6-astra/);
            let observed = "";
            for (let index = 0; index < 60; index++) { observed += render(); send(down); }
            for (const provider of ["azure", "openai", "amazon-bedrock"]) assert.ok(observed.includes(`${provider} · `));
            let found = false;
            for (let index = 0; index < 60; index++) {
              if (/→ openai · gpt-6-astra\s/.test(render())) { found = true; break; }
              send(down);
            }
            assert.ok(found, "choose the exact OpenAI variant rather than a similarly named Provider");
            send(enter);
          } else if (current === 5) {
            let observed = "";
            for (const width of [40, 100]) {
              for (let index = 0; index < 80; index++) { observed += render(width); send(index < 40 ? down : up); }
            }
            assert.match(observed, /来源: openai\/gpt-6-astra/);
            assert.match(observed, /contextWindow/);
            assert.match(observed, /Cost/);
            send(accept ? enter : cancel);
            applied = accept;
          } else if (current <= 9) send(cancel);
          else assert.fail(`unexpected custom screen ${current}`);
          assert.ok(finished, `screen ${current} did not finish`);
          screens.push({ accept, step: current, title: opening.split("\n").slice(0, 2).join(" / ") });
          return result;
        },
      },
    };
    await command.handler("", ctx);
    assert.equal(step, 10, "the command must navigate back through the same editor path");
    assert.equal(applied, accept);
    const storedPayload = await readFile(payloadPath, "utf8");
    assert.deepEqual(JSON.parse(storedPayload), JSON.parse(payload));
    const storedBytes = await readFile(modelsPath, "utf8");
    if (!accept) {
      assert.equal(storedBytes, originalNative);
      assert.equal(storedPayload, payload);
    }
    else {
      const stored = JSON.parse(storedBytes);
      const target = stored.providers[providerId].models[0];
      const reference = catalogBody.openai["gpt-6-astra"];
      assert.equal(target.id, targetId);
      for (const key of ["name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "compat", "thinkingLevelMap"]) {
        assert.deepEqual(target[key], reference[key]);
      }
      assert.equal(stored.providers[providerId].api, "openai-completions");
      assert.equal(stored.providers[providerId].baseUrl, "https://synthetic.invalid/v1");
      assert.equal(stored.providers[providerId].apiKey, "synthetic-never-sent");
      assert.deepEqual(target.headers, { "X-Synthetic": "keep" });
      assert.equal(target.localOnly, true);
      assert.deepEqual(stored.providers[providerId].models[1], native.providers[providerId].models[1]);
      assert.ok(messages.some(item => item.message.includes("保存")));
    }
  }
  console.log(JSON.stringify({ host: VERSION, extensionLoaded: true, requestUrls: requests,
    cancelledWithoutWrites: true, metadataAppliedToAlias: true, privatePayloadValuesUnchanged: true,
    driver: "real command, real custom TUI components, synthetic key input; no desktop rendering", screens }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(scratch, { recursive: true, force: true });
}
