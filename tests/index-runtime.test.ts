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
