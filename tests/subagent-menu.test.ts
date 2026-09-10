import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { editSubagentAgentOverride } from "../index.ts";
import { createScriptedUi, type ScriptedUiCall } from "./helpers/scripted-ui.ts";

const FAKE_PI = { getActiveTools: () => ["read"], getAllTools: () => [] } as any;

function seedSettings(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-menu-"));
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ subagents: { agentOverrides: {} } }),
    "utf-8",
  );
  return path.join(dir, "settings.json");
}

function menuLabels(calls: ScriptedUiCall[]): string[] {
  const menu = calls.find((call) => call.kind === "select");
  assert.ok(menu && menu.kind === "select", "the agent override menu must open");
  return menu.options;
}

test("external CLI agents offer cleanup only, with every Pi-native row marked ignored", async () => {
  const settingsPath = seedSettings();
  try {
    // pi-subagents never reads model/thinking/fallbackModels/tools for these runners, so the
    // editor must not pretend the values take effect.
    const { ctx, calls, assertExhausted } = createScriptedUi({ selects: ["返回"] });
    await editSubagentAgentOverride(FAKE_PI, ctx, settingsPath, "codex-exec");
    assertExhausted();

    const labels = menuLabels(calls);
    assert.deepEqual(
      labels.filter((label) => label.startsWith("设置 ")),
      [],
      `no Pi-native override editor may be offered: ${labels.join(" | ")}`,
    );
    for (const row of ["当前 model:", "当前 thinking:", "当前 fallbackModels:", "当前 tools:"]) {
      assert.ok(
        labels.some((label) => label.startsWith(row) && label.includes("（外部 CLI runner 忽略）")),
        `${row} must be shown as ignored`,
      );
    }
    assert.ok(labels.includes("清除 model/thinking/fallbackModels"), "stale keys must stay clearable");
    assert.ok(labels.includes("删除整个 agent override"));
  } finally {
    fs.rmSync(path.dirname(settingsPath), { recursive: true, force: true });
  }
});

test("native Pi child agents keep the full override menu without ignore markers", async () => {
  const settingsPath = seedSettings();
  try {
    const { ctx, calls, assertExhausted } = createScriptedUi({ selects: ["返回"] });
    await editSubagentAgentOverride(FAKE_PI, ctx, settingsPath, "worker");
    assertExhausted();

    const labels = menuLabels(calls);
    assert.deepEqual(labels.filter((label) => label.startsWith("设置 ")), [
      "设置 model",
      "设置 thinking",
      "设置 fallbackModels",
      "设置 tools allowlist",
    ]);
    assert.equal(labels.some((label) => label.includes("外部 CLI runner")), false);
  } finally {
    fs.rmSync(path.dirname(settingsPath), { recursive: true, force: true });
  }
});
