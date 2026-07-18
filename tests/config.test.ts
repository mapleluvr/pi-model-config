import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getModelsPath, ModelsConfigError, parseModelsDocument, readModelsConfig, writeModelsConfig } from "../config.ts";
import { ModelsCandidateValidationError } from "../config-validation.ts";
import type { ModelsConfig } from "../types.ts";
import { withTempAgentDir as withAgentDir } from "./helpers/temp-agent-dir.ts";

test("reads Pi models.json JSONC and preserves unknown root fields", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, `// Pi accepts comments\n{\n  "feature": true,\n  "providers": {\n    "local": { "headers": { "X-Test": "yes" }, "models": [], },\n  },\n}\n`);

  assert.deepEqual(readModelsConfig(), {
    feature: true,
    providers: { local: { headers: { "X-Test": "yes" }, models: [] } },
  });
}));

test("uses an explicit agent directory for models paths and rejects schema-invalid documents", () => withAgentDir((ambientDir) => {
  const explicitDir = fs.mkdtempSync(path.join(path.dirname(ambientDir), "pi-model-config-explicit-"));
  try {
    assert.equal(getModelsPath(explicitDir), path.join(explicitDir, "models.json"));
    assert.throws(() => parseModelsDocument(path.join(explicitDir, "models.json"), JSON.stringify({ providers: { invalid: null } })), ModelsConfigError);
  } finally {
    fs.rmSync(explicitDir, { recursive: true, force: true });
  }
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

test("retains existing root fields when replacing providers", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, `{ "nativeRoot": true, "providers": { "p": { "headers": { "X-Test": "yes" }, "models": [] } } }`);

  writeModelsConfig({ providers: {} });

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), {
    nativeRoot: true,
    providers: {},
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

test("treats a blank or whitespace-only models.json as malformed and preserves it", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  const blank = " \r\n\t";
  fs.writeFileSync(filePath, blank);

  assert.throws(() => readModelsConfig(), ModelsConfigError);
  assert.throws(() => writeModelsConfig({ providers: {} }), ModelsConfigError);
  assert.equal(fs.readFileSync(filePath, "utf8"), blank);
}));

test("returns an empty provider map only when models.json is absent", () => withAgentDir(() => {
  assert.deepEqual(readModelsConfig(), { providers: {} });
}));

test("rejects a Pi-invalid complete candidate before replacing existing bytes", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  const original = `{ "rootSetting": "keep", "providers": {} }\n`;
  fs.writeFileSync(filePath, original);

  assert.throws(() => writeModelsConfig({
    providers: { custom: { models: [{ id: "model" }] } },
  }), ModelsCandidateValidationError);
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
}));

test("atomically writes a valid candidate while preserving unknown nested fields and native mode", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, JSON.stringify({
    rootPreview: true,
    providers: {
      openai: {
        headers: { "X-Keep": "yes" },
        providerPreview: true,
        models: [{ id: "model", modelPreview: true, compat: { futureCompat: "keep" } }],
      },
    },
  }), { mode: 0o640 });
  const originalMode = fs.statSync(filePath).mode & 0o777;
  const candidate = readModelsConfig();
  candidate.providers.openai!.models![0]!.name = "Updated";

  writeModelsConfig(candidate);

  const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(written.rootPreview, true);
  assert.equal(written.providers.openai.providerPreview, true);
  assert.equal(written.providers.openai.models[0].modelPreview, true);
  assert.equal(written.providers.openai.models[0].compat.futureCompat, "keep");
  assert.equal(written.providers.openai.models[0].name, "Updated");
  assert.equal(fs.statSync(filePath).mode & 0o777, originalMode);
  assert.deepEqual(fs.readdirSync(agentDir).filter((entry) => entry.endsWith(".tmp")), []);
}));


test("parseModelsDocument keeps literal __proto__ and sentinel-named provider keys as distinct own keys", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  const document = `{
  // comment
  "providers": {
    "__proto__": {
      "baseUrl": "http://proto",
      "api": "openai-completions",
      "models": []
    },
    "__mc_own_proto__": {
      "baseUrl": "http://sentinel",
      "api": "openai-completions",
      "models": [{ "id": "nested", "headers": { "__proto__": "hdr", "x": "1" } }]
    },
  },
}`;
  fs.writeFileSync(filePath, document, "utf8");
  const parsed = parseModelsDocument(filePath, document);
  assert.equal(Object.hasOwn(parsed.providers, "__proto__"), true);
  assert.equal(Object.hasOwn(parsed.providers, "__mc_own_proto__"), true);
  assert.equal(parsed.providers["__proto__"]!.baseUrl, "http://proto");
  assert.equal(parsed.providers["__mc_own_proto__"]!.baseUrl, "http://sentinel");
  const nestedHeaders = parsed.providers["__mc_own_proto__"]!.models![0]!.headers as Record<string, unknown>;
  assert.equal(Object.hasOwn(nestedHeaders, "__proto__"), true);
  assert.equal(nestedHeaders["__proto__"], "hdr");

  writeModelsConfig(parsed);
  const roundtrip = readModelsConfig();
  assert.equal(Object.hasOwn(roundtrip.providers, "__proto__"), true);
  assert.equal(Object.hasOwn(roundtrip.providers, "__mc_own_proto__"), true);
  assert.equal(roundtrip.providers["__proto__"]!.baseUrl, "http://proto");
  assert.equal(roundtrip.providers["__mc_own_proto__"]!.baseUrl, "http://sentinel");
  assert.notEqual(roundtrip.providers["__proto__"], roundtrip.providers["__mc_own_proto__"]);
}));

test("parseModelsDocument materializes unicode-escaped __proto__ provider key as own key", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  // Raw JSON unicode escapes must reach the parser undecoded by JS string evaluation.
  const document = String.raw`{
  "providers": {
    "\u005f\u005fproto\u005f\u005f": {
      "baseUrl": "http://escaped",
      "api": "openai-completions",
      "models": []
    },
    "__mc_own_proto__": {
      "baseUrl": "http://sentinel",
      "api": "openai-completions",
      "models": []
    }
  }
}`;
  fs.writeFileSync(filePath, document, "utf8");
  const parsed = parseModelsDocument(filePath, fs.readFileSync(filePath));
  assert.equal(Object.hasOwn(parsed.providers, "__proto__"), true);
  assert.equal(Object.hasOwn(parsed.providers, "__mc_own_proto__"), true);
  assert.equal(parsed.providers["__proto__"]!.baseUrl, "http://escaped");
  assert.equal(parsed.providers["__mc_own_proto__"]!.baseUrl, "http://sentinel");
  writeModelsConfig(parsed);
  const roundtrip = readModelsConfig();
  assert.equal(Object.hasOwn(roundtrip.providers, "__proto__"), true);
  assert.equal(Object.hasOwn(roundtrip.providers, "__mc_own_proto__"), true);
  assert.equal(roundtrip.providers["__proto__"]!.baseUrl, "http://escaped");
}));

test("writeModelsConfig rejects input lacking own providers even with prototype pollution", () => withAgentDir((agentDir) => {
  const filePath = getModelsPath(agentDir);
  fs.writeFileSync(filePath, `{\n  "providers": {}\n}`, "utf8");
  const proto = Object.prototype as Record<string, unknown>;
  const previous = proto.providers;
  try {
    Object.defineProperty(Object.prototype, "providers", {
      value: { phantom: { baseUrl: "http://evil", api: "openai-completions", models: [] } },
      configurable: true,
      enumerable: true,
      writable: true,
    });
    const bare = Object.create(Object.prototype) as ModelsConfig;
    assert.throws(() => writeModelsConfig(bare), ModelsConfigError);
    const after = readModelsConfig();
    assert.equal(Object.hasOwn(after.providers, "phantom"), false);
    assert.equal(Object.keys(after.providers).length, 0);
  } finally {
    if (previous === undefined) delete proto.providers;
    else Object.defineProperty(Object.prototype, "providers", {
      value: previous,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
}));

test("parseModelsDocument ignores Object.prototype pollution for providers root", () => withAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  const proto = Object.prototype as Record<string, unknown>;
  const previous = proto.providers;
  try {
    Object.defineProperty(Object.prototype, "providers", {
      value: {
        phantom: { baseUrl: "http://evil", api: "openai-completions", models: [] },
      },
      configurable: true,
      enumerable: true,
      writable: true,
    });
    // Document without own providers must not materialize the prototype map.
    fs.writeFileSync(filePath, `{ "feature": true }`, "utf8");
    const emptyish = parseModelsDocument(filePath, fs.readFileSync(filePath));
    assert.equal(Object.hasOwn(emptyish, "providers"), true);
    assert.equal(Object.keys(emptyish.providers).length, 0);
    assert.equal(Object.hasOwn(emptyish.providers, "phantom"), false);

    fs.writeFileSync(filePath, `{
  "providers": {
    "real": { "baseUrl": "http://real", "api": "openai-completions", "models": [] }
  }
}`, "utf8");
    const real = parseModelsDocument(filePath, fs.readFileSync(filePath));
    assert.equal(Object.hasOwn(real.providers, "real"), true);
    assert.equal(Object.hasOwn(real.providers, "phantom"), false);
    assert.equal(real.providers.real!.baseUrl, "http://real");
  } finally {
    if (previous === undefined) delete proto.providers;
    else Object.defineProperty(Object.prototype, "providers", {
      value: previous,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
}));
