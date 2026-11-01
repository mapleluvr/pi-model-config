import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { ModelsCandidateValidationError, validateModelsCandidate } from "../config-validation.ts";
import { ModelsConfigError, readModelsConfig, writeModelsConfig } from "../config.ts";
import { withTempAgentDir } from "./helpers/temp-agent-dir.ts";

type CompatScope = "provider" | "model" | "override";

function candidateWithCompat(scope: CompatScope, compat: Record<string, unknown>) {
  return {
    providers: {
      probe: {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        ...(scope === "provider" ? { compat } : {}),
        models: [{ id: "probe-model", ...(scope === "model" ? { compat } : {}) }],
        ...(scope === "override" ? { modelOverrides: { "probe-model": { compat } } } : {}),
      },
    },
  };
}

const scopes: Array<[CompatScope, string]> = [
  ["provider", "$.providers.probe.compat"],
  ["model", "$.providers.probe.models[0].compat"],
  ["override", "$.providers.probe.modelOverrides.probe-model.compat"],
];

test("rejects invalid classifier image compat values at every Pi schema location", () => {
  for (const [scope, prefix] of scopes) {
    for (const value of ["asset", "", null, 0, false, [], {}]) {
      const issues = validateModelsCandidate(candidateWithCompat(scope, { imageInput: value }));
      assert.ok(issues.some((issue) => issue.path === `${prefix}.imageInput`), `${scope}: invalid imageInput ${JSON.stringify(value)}`);
    }
    for (const value of ["false", null, 0, [], {}]) {
      const issues = validateModelsCandidate(candidateWithCompat(scope, { sendImageOptInHeader: value }));
      assert.ok(issues.some((issue) => issue.path === `${prefix}.sendImageOptInHeader`), `${scope}: invalid sendImageOptInHeader ${JSON.stringify(value)}`);
    }
  }
});

test("accepts Pi classifier image enum values and booleans without changing future compat data", () => {
  for (const [scope] of scopes) {
    for (const imageInput of ["assets", "images", "state-image-urls"]) {
      for (const sendImageOptInHeader of [false, true]) {
        const candidate = candidateWithCompat(scope, { imageInput, sendImageOptInHeader, future: { keep: true } });
        const original = structuredClone(candidate);
        assert.deepEqual(validateModelsCandidate(candidate), []);
        assert.deepEqual(candidate, original);
      }
    }
  }
});

test("models schema metadata must be a string when present, including an empty string", () => {
  for (const $schema of ["", "https://pi.dev/schemas/models.schema.json"]) {
    assert.deepEqual(validateModelsCandidate({ $schema, providers: {} }), []);
  }
  for (const $schema of [null, false, 0, [], {}]) {
    const issues = validateModelsCandidate({ $schema, providers: {} });
    assert.ok(issues.some((issue) => issue.path === "$.$schema"), `invalid $schema ${JSON.stringify($schema)}`);
  }
});

test("rejects invalid 1.4.0 fields before replacing a valid models file", () => withTempAgentDir((agentDir) => {
  const file = path.join(agentDir, "models.json");
  const original = '{"providers":{},"futureRoot":{"keep":true}}\n';
  const invalid = [
    { $schema: 42, providers: {} },
    candidateWithCompat("provider", { imageInput: "invalid" }),
    candidateWithCompat("provider", { sendImageOptInHeader: "false" }),
  ];
  for (const candidate of invalid) {
    fs.writeFileSync(file, original);
    // @ts-expect-error Deliberately pass invalid external data to exercise runtime validation.
    assert.throws(() => writeModelsConfig(candidate, file), ModelsCandidateValidationError);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
}));

test("rejects a pre-existing Pi-invalid file rather than editing other fields", () => withTempAgentDir((agentDir) => {
  const file = path.join(agentDir, "models.json");
  for (const candidate of [
    { $schema: 42, providers: {} },
    candidateWithCompat("provider", { imageInput: "invalid" }),
    candidateWithCompat("provider", { sendImageOptInHeader: "false" }),
  ]) {
    const original = JSON.stringify(candidate);
    fs.writeFileSync(file, original);
    assert.throws(() => readModelsConfig(file), ModelsConfigError);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
}));
