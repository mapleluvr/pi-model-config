import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  getActiveSubagentSettingsTarget,
  getActiveSubagentSettingsTargetForCwd,
  getProjectSettingsPath,
  ensureSubagentAgentOverrides,
  BUILTIN_SUBAGENT_OVERRIDE_FIELDS,
  migrateRemovedSubagentOverrideFields,
  clearAllManagedSubagentAgentFields,
  clearManagedSubagentModelFields,
  clearManagedSubagentToolFields,
  deleteSubagentAgentOverride,
  pullUserSubagentOverridesToProject,
  readSubagentAgentOverrides,
  updateSubagentAgentOverride,
  pushProjectSubagentOverridesToUser,
} from "../subagent-settings.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-test-"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}
test("tracks the pi-subagents 0.68.0 builtin override field surface", () => {
  assert.deepEqual([...BUILTIN_SUBAGENT_OVERRIDE_FIELDS], [
    "description",
    "machine",
    "output",
    "outputMode",
    "defaultReads",
    "model",
    "defaultProvider",
    "fast",
    "thinking",
    "systemPromptMode",
    "inheritProjectContext",
    "inheritGlobalContext",
    "inheritSkills",
    "defaultContext",
    "acceptanceRole",
    "disabled",
    "systemPrompt",
    "skills",
    "tools",
    "excludeTools",
    "allowNestedSubagents",
    "extensions",
    "subagentOnlyExtensions",
    "mutationTools",
    "completionGuard",
    "toolBudget",
  ]);
});


test("finds project settings by walking up from a nested working directory", () => {
  const dir = makeTempDir();
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(dir, "home", ".pi", "agent");
  const repoRoot = path.join(dir, "repo");
  const nestedCwd = path.join(repoRoot, "src", "feature");
  const projectSettingsPath = path.join(repoRoot, ".pi", "settings.json");
  fs.mkdirSync(nestedCwd, { recursive: true });

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(path.join(agentDir, "settings.json"), {
      subagents: { agentOverrides: { reviewer: { model: "user/reviewer" } } },
    });
    writeJson(projectSettingsPath, {
      subagents: { agentOverrides: { worker: { model: "project/worker" } } },
    });

    assert.equal(getProjectSettingsPath(nestedCwd), projectSettingsPath);
    const active = getActiveSubagentSettingsTargetForCwd(nestedCwd);
    assert.equal(active.scope, "project");
    assert.equal(active.path, projectSettingsPath);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("uses project settings only when project has subagents.agentOverrides", () => {
  const dir = makeTempDir();
  const userSettingsPath = path.join(dir, "home", ".pi", "agent", "settings.json");
  const projectSettingsPath = path.join(dir, "repo", ".pi", "settings.json");

  writeJson(userSettingsPath, {
    theme: "dark",
    subagents: { agentOverrides: { reviewer: { model: "user/reviewer" } } },
  });
  writeJson(projectSettingsPath, {
    theme: "light",
    subagents: { otherField: true },
  });

  assert.equal(
    getActiveSubagentSettingsTarget({ userSettingsPath, projectSettingsPath }).scope,
    "user",
  );
  assert.deepEqual(
    readSubagentAgentOverrides(userSettingsPath),
    { reviewer: { model: "user/reviewer" } },
  );

  writeJson(projectSettingsPath, {
    theme: "light",
    subagents: { agentOverrides: { planner: { model: "project/planner" } } },
  });

  const active = getActiveSubagentSettingsTarget({ userSettingsPath, projectSettingsPath });
  assert.equal(active.scope, "project");
  assert.equal(active.path, projectSettingsPath);
});

test("ensures project subagent overrides are created while preserving unrelated project settings", () => {
  const dir = makeTempDir();
  const projectSettingsPath = path.join(dir, "repo", ".pi", "settings.json");
  writeJson(projectSettingsPath, { theme: "light", subagents: { otherField: true } });

  ensureSubagentAgentOverrides(projectSettingsPath);

  assert.deepEqual(readJson(projectSettingsPath), {
    theme: "light",
    subagents: {
      otherField: true,
      agentOverrides: {},
    },
  });
});

test("updates one agent override in the active settings file and preserves unrelated settings", () => {
  const dir = makeTempDir();
  const settingsPath = path.join(dir, "settings.json");
  writeJson(settingsPath, {
    defaultModel: "Mapleluv/gpt-5.5",
    subagents: {
      otherField: true,
      agentOverrides: {
        reviewer: { model: "old/reviewer", tools: ["read"], fallbackModels: ["obsolete/reviewer"] },
      },
    },
  });

  updateSubagentAgentOverride(settingsPath, "reviewer", {
    model: "new/reviewer",
    thinking: "high",
  });

  assert.deepEqual(readJson(settingsPath), {
    defaultModel: "Mapleluv/gpt-5.5",
    subagents: {
      otherField: true,
      agentOverrides: {
        reviewer: {
          model: "new/reviewer",
          tools: ["read"],
          thinking: "high",
        },
      },
    },
  });
});

test("updates legal false and inherit override values without coercing them", () => {
  const dir = makeTempDir();
  const settingsPath = path.join(dir, "settings.json");
  writeJson(settingsPath, { subagents: { agentOverrides: {} } });

  updateSubagentAgentOverride(settingsPath, "worker", {
    model: false,
    thinking: false,
    tools: "inherit",
  });

  assert.deepEqual(readJson(settingsPath), {
    subagents: {
      agentOverrides: {
        worker: { model: false, thinking: false, tools: "inherit" },
      },
    },
  });
});

test("updates tools allowlist and explicit disabled-tools override", () => {
  const dir = makeTempDir();
  const settingsPath = path.join(dir, "settings.json");
  writeJson(settingsPath, {
    subagents: {
      agentOverrides: {
        worker: { model: "old/worker" },
        reviewer: { tools: ["read"] },
      },
    },
  });

  updateSubagentAgentOverride(settingsPath, "worker", {
    tools: ["read", "bash", "edit"],
  });
  updateSubagentAgentOverride(settingsPath, "reviewer", {
    tools: false,
  });

  assert.deepEqual(readJson(settingsPath), {
    subagents: {
      agentOverrides: {
        worker: { model: "old/worker", tools: ["read", "bash", "edit"] },
        reviewer: { tools: false },
      },
    },
  });
});

test("clears model fields without clearing tools override", () => {
  const dir = makeTempDir();
  const settingsPath = path.join(dir, "settings.json");
  writeJson(settingsPath, {
    subagents: {
      agentOverrides: {
        worker: {
          model: "old/worker",
          thinking: "high",
          fallbackModels: ["fallback/one"],
          tools: ["read", "bash"],
        },
      },
    },
  });

  clearManagedSubagentModelFields(settingsPath, "worker");

  assert.deepEqual(readJson(settingsPath), {
    subagents: {
      agentOverrides: {
        worker: { tools: ["read", "bash"] },
      },
    },
  });
});

test("clears tools override without clearing model fields", () => {
  const dir = makeTempDir();
  const settingsPath = path.join(dir, "settings.json");
  writeJson(settingsPath, {
    subagents: {
      agentOverrides: {
        worker: {
          model: "old/worker",
          thinking: "medium",
          tools: ["read", "bash"],
        },
      },
    },
  });

  clearManagedSubagentToolFields(settingsPath, "worker");

  assert.deepEqual(readJson(settingsPath), {
    subagents: {
      agentOverrides: {
        worker: { model: "old/worker", thinking: "medium" },
      },
    },
  });
});

test("clears all managed subagent fields including tools", () => {
  const dir = makeTempDir();
  const settingsPath = path.join(dir, "settings.json");
  writeJson(settingsPath, {
    subagents: {
      agentOverrides: {
        worker: {
          model: "old/worker",
          thinking: "medium",
          fallbackModels: ["fallback/one"],
          tools: ["read", "bash"],
        },
        reviewer: { model: "keep/reviewer" },
      },
    },
  });

  clearAllManagedSubagentAgentFields(settingsPath, "worker");

  assert.deepEqual(readJson(settingsPath), {
    subagents: {
      agentOverrides: {
        reviewer: { model: "keep/reviewer" },
      },
    },
  });
});

test("removes an agent override when all managed model fields are cleared and no unmanaged fields remain", () => {
  const dir = makeTempDir();
  const settingsPath = path.join(dir, "settings.json");
  writeJson(settingsPath, {
    subagents: {
      agentOverrides: {
        scout: { model: "old/scout", thinking: "low" },
        reviewer: { model: "keep/reviewer" },
      },
    },
  });

  updateSubagentAgentOverride(settingsPath, "scout", {
    model: undefined,
    thinking: undefined,
  });

  assert.deepEqual(readJson(settingsPath), {
    subagents: {
      agentOverrides: {
        reviewer: { model: "keep/reviewer" },
      },
    },
  });
});

test("pushes project subagent overrides to user settings while preserving unrelated user settings", () => {
  const dir = makeTempDir();
  const userSettingsPath = path.join(dir, "home", ".pi", "agent", "settings.json");
  const projectSettingsPath = path.join(dir, "repo", ".pi", "settings.json");

  writeJson(userSettingsPath, {
    theme: "dark",
    subagents: {
      keepThis: "yes",
      agentOverrides: { reviewer: { model: "old/global" } },
    },
  });
  writeJson(projectSettingsPath, {
    subagents: {
      agentOverrides: {
        planner: { model: "project/planner", thinking: "high" },
      },
    },
  });

  const copied = pushProjectSubagentOverridesToUser(projectSettingsPath, userSettingsPath);

  assert.equal(copied, 1);
  assert.deepEqual(readJson(userSettingsPath), {
    theme: "dark",
    subagents: {
      keepThis: "yes",
      agentOverrides: {
        planner: { model: "project/planner", thinking: "high" },
      },
    },
  });
});

test("pulls user subagent overrides to project settings while preserving unrelated project settings", () => {
  const dir = makeTempDir();
  const userSettingsPath = path.join(dir, "home", ".pi", "agent", "settings.json");
  const projectSettingsPath = path.join(dir, "repo", ".pi", "settings.json");

  writeJson(userSettingsPath, {
    subagents: {
      agentOverrides: {
        reviewer: { model: "user/reviewer", thinking: "xhigh" },
      },
    },
  });
  writeJson(projectSettingsPath, {
    theme: "light",
    subagents: {
      keepThis: "yes",
      agentOverrides: { planner: { model: "old/project" } },
    },
  });

  const copied = pullUserSubagentOverridesToProject(userSettingsPath, projectSettingsPath);

  assert.equal(copied, 1);
  assert.deepEqual(readJson(projectSettingsPath), {
    theme: "light",
    subagents: {
      keepThis: "yes",
      agentOverrides: {
        reviewer: { model: "user/reviewer", thinking: "xhigh" },
      },
    },
  });
});

test("does not create directories while migrating an absent settings file", () => {
  const dir = makeTempDir();
  const settingsPath = path.join(dir, "missing", "settings.json");

  assert.equal(migrateRemovedSubagentOverrideFields(settingsPath), 0);
  assert.equal(fs.existsSync(path.dirname(settingsPath)), false);
});

test("migrates removed fallbackModels from all override scopes", () => {
  const dir = makeTempDir();
  const settingsPath = path.join(dir, "settings.json");
  writeJson(settingsPath, {
    subagents: {
      agentOverrides: {
        worker: { model: "provider/worker", fallbackModels: ["obsolete/worker"] },
        scout: { fallbackModels: ["obsolete/scout"] },
      },
      agentOverridesByProvider: {
        openai: {
          reviewer: { thinking: "high", fallbackModels: ["obsolete/reviewer"] },
        },
      },
    },
  });

  assert.equal(migrateRemovedSubagentOverrideFields(settingsPath), 3);
  assert.deepEqual(readJson(settingsPath), {
    subagents: {
      agentOverrides: {
        worker: { model: "provider/worker" },
      },
      agentOverridesByProvider: {
        openai: {
          reviewer: { thinking: "high" },
        },
      },
    },
  });
});
test("reads and migrates removed fields before returning overrides", () => {
  const dir = makeTempDir();
  const settingsPath = path.join(dir, "settings.json");
  writeJson(settingsPath, {
    subagents: {
      agentOverrides: {
        worker: { model: "provider/worker", fallbackModels: ["obsolete/worker"] },
        scout: { fallbackModels: ["obsolete/scout"] },
      },
    },
  });

  assert.deepEqual(readSubagentAgentOverrides(settingsPath), {
    worker: { model: "provider/worker" },
  });
  assert.deepEqual(readJson(settingsPath), {
    subagents: {
      agentOverrides: {
        worker: { model: "provider/worker" },
      },
    },
  });
});
test("pushes overrides while migrating removed fields from both source and target", () => {
  const dir = makeTempDir();
  const source = path.join(dir, "project", ".pi", "settings.json");
  const target = path.join(dir, "user", "settings.json");
  writeJson(source, {
    subagents: { agentOverrides: {
      worker: { model: "provider/worker", fallbackModels: ["old/model"] },
      scout: { fallbackModels: ["old/scout"] },
    } },
  });
  writeJson(target, {
    subagents: {
      agentOverrides: { reviewer: { model: "provider/reviewer", fallbackModels: ["old/reviewer"] } },
      agentOverridesByProvider: { openai: { worker: { model: "openai/worker", fallbackModels: ["old/provider"] } } },
    },
  });

  assert.equal(pushProjectSubagentOverridesToUser(source, target), 1);
  assert.deepEqual(readJson(source), {
    subagents: { agentOverrides: { worker: { model: "provider/worker" } } },
  });
  assert.deepEqual(readJson(target), {
    subagents: {
      agentOverrides: { worker: { model: "provider/worker" } },
      agentOverridesByProvider: { openai: { worker: { model: "openai/worker" } } },
    },
  });
});

test("deleting an override also removes legacy fields from other agent and provider entries", () => {
  const dir = makeTempDir();
  const settingsPath = path.join(dir, "settings.json");
  writeJson(settingsPath, { subagents: {
    agentOverrides: { scout: { model: "provider/scout" }, worker: { fallbackModels: ["old/worker"] } },
    agentOverridesByProvider: { openai: { reviewer: { model: "openai/reviewer", fallbackModels: ["old/reviewer"] } } },
  } });

  deleteSubagentAgentOverride(settingsPath, "scout");

  assert.deepEqual(readJson(settingsPath), { subagents: {
    agentOverrides: {},
    agentOverridesByProvider: { openai: { reviewer: { model: "openai/reviewer" } } },
  } });
});
test("throws when pushing project overrides but project has no subagents.agentOverrides", () => {
  const dir = makeTempDir();
  const userSettingsPath = path.join(dir, "home", ".pi", "agent", "settings.json");
  const projectSettingsPath = path.join(dir, "repo", ".pi", "settings.json");

  writeJson(userSettingsPath, { theme: "dark" });
  writeJson(projectSettingsPath, { subagents: { otherField: true } });

  assert.throws(
    () => pushProjectSubagentOverridesToUser(projectSettingsPath, userSettingsPath),
    /Project settings does not contain subagents\.agentOverrides/,
  );
});


test("throws when pulling user overrides but user has no subagents.agentOverrides", () => {
  const dir = makeTempDir();
  const userSettingsPath = path.join(dir, "home", ".pi", "agent", "settings.json");
  const projectSettingsPath = path.join(dir, "repo", ".pi", "settings.json");

  writeJson(userSettingsPath, { theme: "dark" });
  writeJson(projectSettingsPath, { subagents: { otherField: true } });

  assert.throws(
    () => pullUserSubagentOverridesToProject(userSettingsPath, projectSettingsPath),
    /User settings does not contain subagents\.agentOverrides/,
  );
});

