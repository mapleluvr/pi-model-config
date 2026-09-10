import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { updateSubagentAgentOverride } from "../subagent-settings.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-write-"));
}

function writeSettings(filePath: string, value: unknown, bom = false): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${bom ? "\uFEFF" : ""}${JSON.stringify(value, null, 2)}`, "utf-8");
}

function readSettings(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

test("reads a BOM-prefixed settings.json and writes it back without the BOM", () => {
  const dir = makeTempDir();
  try {
    const settingsPath = path.join(dir, "settings.json");
    writeSettings(settingsPath, { theme: "dark", subagents: { agentOverrides: {} } }, true);
    assert.equal(fs.readFileSync(settingsPath, "utf-8").charCodeAt(0), 0xfeff);

    updateSubagentAgentOverride(settingsPath, "reviewer", { model: "provider/reviewer" });

    const raw = fs.readFileSync(settingsPath, "utf-8");
    assert.notEqual(raw.charCodeAt(0), 0xfeff, "the canonical write must drop the BOM");
    assert.deepEqual(readSettings(settingsPath), {
      theme: "dark",
      subagents: { agentOverrides: { reviewer: { model: "provider/reviewer" } } },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detects a concurrent settings.json writer and replays the update on the new content", () => {
  const dir = makeTempDir();
  try {
    const settingsPath = path.join(dir, "settings.json");
    writeSettings(settingsPath, { theme: "dark", subagents: { agentOverrides: {} } });
    let attempts = 0;

    updateSubagentAgentOverride(settingsPath, "reviewer", { model: "provider/reviewer" }, {
      beforeHashCheck: () => {
        attempts += 1;
        if (attempts === 1) {
          // A second writer (Pi's settings manager, or another extension) lands after our snapshot.
          writeSettings(settingsPath, { theme: "dark", editorFontSize: 14, subagents: { agentOverrides: {} } });
        }
      },
    });

    assert.equal(attempts, 2, "one detected conflict must cost exactly one retry");
    const written = readSettings(settingsPath);
    assert.equal(written.editorFontSize, 14, "the other writer's field must survive");
    assert.equal(written.theme, "dark");
    assert.deepEqual(written.subagents, { agentOverrides: { reviewer: { model: "provider/reviewer" } } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gives up after bounded retries and leaves the concurrent writer's bytes intact", () => {
  const dir = makeTempDir();
  try {
    const settingsPath = path.join(dir, "settings.json");
    writeSettings(settingsPath, { theme: "dark", subagents: { agentOverrides: {} } });
    let attempts = 0;

    assert.throws(() => updateSubagentAgentOverride(settingsPath, "reviewer", { model: "provider/reviewer" }, {
      beforeHashCheck: () => {
        attempts += 1;
        writeSettings(settingsPath, {
          theme: "dark",
          marker: `attempt-${attempts}`,
          subagents: { agentOverrides: {} },
        });
      },
    }), /concurrent modifications/);

    assert.ok(attempts >= 2, `a conflict must be retried at least once, saw ${attempts}`);
    assert.ok(attempts <= 16, `retries must stay bounded, saw ${attempts}`);
    const written = readSettings(settingsPath);
    assert.equal(written.marker, `attempt-${attempts}`, "the last concurrent write must be left untouched");
    assert.deepEqual(written.subagents, { agentOverrides: {} }, "the abandoned update must not be written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
