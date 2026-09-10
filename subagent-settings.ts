import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicReplace, readArtifact } from "./atomic-file.ts";
import { deepCloneJson } from "./model-fields.ts";

/** Builtin agent names shipped by pi-subagents 0.63.0. */
export const BUILTIN_SUBAGENT_NAMES = [
  "advisor",
  "claude-code",
  "claude-code-writer",
  "codex-exec",
  "codex-exec-writer",
  "cursor-agent",
  "cursor-agent-writer",
  "delegate",
  "oracle",
  "researcher",
  "reviewer",
  "scout",
  "worker",
] as const;

/**
 * Builtin agents whose runner is an external CLI. pi-subagents drops Pi-native child
 * options for them (see `externalRunner` in subagent-executor.ts:2916), so the editor
 * must not offer thinking/fallbackModels/tools overrides.
 */
export const EXTERNAL_CLI_SUBAGENT_NAMES = [
  "claude-code",
  "claude-code-writer",
  "codex-exec",
  "codex-exec-writer",
  "cursor-agent",
  "cursor-agent-writer",
] as const;

export function isExternalCliSubagent(agentName: string): boolean {
  return (EXTERNAL_CLI_SUBAGENT_NAMES as readonly string[]).includes(agentName);
}

/** Builtin names plus every agent name already stored in the override map. */
export function listSubagentAgentNames(overrides: SubagentAgentOverrides): string[] {
  const names: string[] = [...BUILTIN_SUBAGENT_NAMES];
  for (const name of Object.keys(overrides)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type SubagentSettingsScope = "project" | "user";

export interface SubagentAgentOverride {
  model?: string;
  thinking?: string;
  fallbackModels?: string[];
  tools?: string[] | false;
  [key: string]: unknown;
}

export type SubagentAgentOverrides = Record<string, SubagentAgentOverride>;

export interface SubagentSettingsTarget {
  scope: SubagentSettingsScope;
  path: string;
  hasProjectOverrides: boolean;
}

export interface SubagentSettingsPaths {
  userSettingsPath: string;
  projectSettingsPath: string;
}

export interface SubagentOverrideChanges {
  model?: string;
  thinking?: string;
  fallbackModels?: string[];
  tools?: string[] | false;
}

const MANAGED_MODEL_OVERRIDE_FIELDS = ["model", "thinking", "fallbackModels"] as const;
const MANAGED_TOOL_OVERRIDE_FIELDS = ["tools"] as const;
const MANAGED_AGENT_OVERRIDE_FIELDS = [
  ...MANAGED_MODEL_OVERRIDE_FIELDS,
  ...MANAGED_TOOL_OVERRIDE_FIELDS,
] as const;

export function getUserSettingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "settings.json");
}

export function getProjectSettingsPath(cwd: string): string {
  const start = path.resolve(cwd);
  let dir = start;
  let nearestPiDirSettings: string | undefined;

  while (true) {
    const piDir = path.join(dir, ".pi");
    const candidate = path.join(piDir, "settings.json");
    if (fs.existsSync(candidate)) return candidate;
    if (!nearestPiDirSettings && fs.existsSync(piDir) && fs.statSync(piDir).isDirectory()) {
      nearestPiDirSettings = candidate;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return nearestPiDirSettings ?? path.join(start, ".pi", "settings.json");
}

const SETTINGS_WRITE_ATTEMPTS = 8;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSettingsBytes(filePath: string, bytes: Buffer | undefined): Record<string, unknown> {
  if (bytes === undefined) return {};
  const raw = stripBom(bytes.toString("utf-8")).trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(`Failed to read JSON from ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readJsonObject(filePath: string): Record<string, unknown> {
  return parseSettingsBytes(filePath, readArtifact(filePath).bytes);
}

class SettingsFileChangedError extends Error {}

export interface SettingsWriteHooks {
  /**
   * Test seam: runs after the baseline hash is captured and before the content check, so a test
   * can land a concurrent write deterministically. `atomic-file.ts` uses the same pattern.
   */
  beforeHashCheck?: () => void;
}

/**
 * Read-modify-write with settings.json hygiene: atomic replacement, a parse of the current bytes
 * on every attempt, and a content-hash check that turns a concurrent writer into a retry instead
 * of an overwrite. The check runs immediately before the rename, so a writer landing inside that
 * window can still be replaced; closing it needs Pi's own proper-lockfile lock, which this
 * extension does not hold.
 */
function updateSettingsFile(
  filePath: string,
  mutate: (settings: Record<string, unknown>) => void,
  hooks: SettingsWriteHooks = {},
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < SETTINGS_WRITE_ATTEMPTS; attempt += 1) {
    const snapshot = readArtifact(filePath);
    const settings = parseSettingsBytes(filePath, snapshot.bytes);
    const before = JSON.stringify(settings);
    mutate(settings);
    if (JSON.stringify(settings) === before) return;
    hooks.beforeHashCheck?.();
    try {
      atomicReplace(filePath, Buffer.from(JSON.stringify(settings, null, 2), "utf-8"), {
        beforeRename: () => {
          if (readArtifact(filePath).hash !== snapshot.hash) throw new SettingsFileChangedError();
        },
      });
      return;
    } catch (error) {
      if (!(error instanceof SettingsFileChangedError)) throw error;
    }
  }
  throw new Error(`Failed to update ${filePath}: concurrent modifications detected`);
}

function getOverridesFromSettings(settings: Record<string, unknown>): SubagentAgentOverrides | undefined {
  const subagents = settings.subagents;
  if (!isRecord(subagents)) return undefined;
  const overrides = subagents.agentOverrides;
  if (!isRecord(overrides)) return undefined;
  return overrides as SubagentAgentOverrides;
}

export function settingsHasSubagentAgentOverrides(settingsPath: string): boolean {
  return getOverridesFromSettings(readJsonObject(settingsPath)) !== undefined;
}

export function getActiveSubagentSettingsTarget(paths: SubagentSettingsPaths): SubagentSettingsTarget {
  const hasProjectOverrides = settingsHasSubagentAgentOverrides(paths.projectSettingsPath);
  return {
    scope: hasProjectOverrides ? "project" : "user",
    path: hasProjectOverrides ? paths.projectSettingsPath : paths.userSettingsPath,
    hasProjectOverrides,
  };
}

export function getActiveSubagentSettingsTargetForCwd(cwd: string): SubagentSettingsTarget & SubagentSettingsPaths {
  const userSettingsPath = getUserSettingsPath();
  const projectSettingsPath = getProjectSettingsPath(cwd);
  const target = getActiveSubagentSettingsTarget({ userSettingsPath, projectSettingsPath });
  return { ...target, userSettingsPath, projectSettingsPath };
}

export function readSubagentAgentOverrides(settingsPath: string): SubagentAgentOverrides {
  return getOverridesFromSettings(readJsonObject(settingsPath)) ?? {};
}

export function ensureSubagentAgentOverrides(settingsPath: string): SubagentAgentOverrides {
  let overrides: SubagentAgentOverrides = {};
  updateSettingsFile(settingsPath, (settings) => {
    overrides = ensureSettingsOverrides(settings);
  });
  return overrides;
}

function cloneOverrides(overrides: SubagentAgentOverrides): SubagentAgentOverrides {
  return deepCloneJson(overrides);
}

function writeSubagentAgentOverrides(settingsPath: string, overrides: SubagentAgentOverrides): void {
  updateSettingsFile(settingsPath, (settings) => {
    const subagents = isRecord(settings.subagents) ? settings.subagents : {};
    settings.subagents = subagents;
    subagents.agentOverrides = cloneOverrides(overrides);
  });
}

function requireSubagentAgentOverrides(settingsPath: string, label: string): SubagentAgentOverrides {
  const overrides = getOverridesFromSettings(readJsonObject(settingsPath));
  if (!overrides) {
    throw new Error(`${label} settings does not contain subagents.agentOverrides: ${settingsPath}`);
  }
  return overrides;
}

function ensureSettingsOverrides(settings: Record<string, unknown>): SubagentAgentOverrides {
  const subagents = isRecord(settings.subagents) ? settings.subagents : {};
  settings.subagents = subagents;
  const overrides = isRecord(subagents.agentOverrides) ? subagents.agentOverrides : {};
  subagents.agentOverrides = overrides;
  return overrides as SubagentAgentOverrides;
}

function removeEmptyAgentOverride(overrides: SubagentAgentOverrides, agentName: string): void {
  const existing = overrides[agentName];
  if (!existing) return;
  if (Object.keys(existing).length === 0) {
    delete overrides[agentName];
  }
}

export function updateSubagentAgentOverride(
  settingsPath: string,
  agentName: string,
  changes: SubagentOverrideChanges,
  hooks: SettingsWriteHooks = {},
): void {
  updateSettingsFile(settingsPath, (settings) => {
    const overrides = ensureSettingsOverrides(settings);
    const existing: SubagentAgentOverride = { ...(overrides[agentName] ?? {}) };

    for (const field of MANAGED_AGENT_OVERRIDE_FIELDS) {
      if (!Object.hasOwn(changes, field)) continue;
      const value = changes[field];
      if (value === undefined || (Array.isArray(value) && value.length === 0) || value === "") {
        delete existing[field];
      } else {
        existing[field] = value;
      }
    }

    if (Object.keys(existing).length === 0) {
      delete overrides[agentName];
    } else {
      overrides[agentName] = existing;
    }
    removeEmptyAgentOverride(overrides, agentName);
  }, hooks);
}

export function deleteSubagentAgentOverride(settingsPath: string, agentName: string): void {
  updateSettingsFile(settingsPath, (settings) => {
    const overrides = ensureSettingsOverrides(settings);
    delete overrides[agentName];
  });
}

export function clearManagedSubagentModelFields(settingsPath: string, agentName: string): void {
  updateSubagentAgentOverride(settingsPath, agentName, {
    model: undefined,
    thinking: undefined,
    fallbackModels: undefined,
  });
}

export function clearManagedSubagentToolFields(settingsPath: string, agentName: string): void {
  updateSubagentAgentOverride(settingsPath, agentName, {
    tools: undefined,
  });
}

export function clearAllManagedSubagentAgentFields(settingsPath: string, agentName: string): void {
  updateSubagentAgentOverride(settingsPath, agentName, {
    model: undefined,
    thinking: undefined,
    fallbackModels: undefined,
    tools: undefined,
  });
}

export const clearManagedSubagentAgentFields = clearManagedSubagentModelFields;

export function appendSubagentFallbackModel(settingsPath: string, agentName: string, model: string): string[] {
  let result: string[] = [];
  updateSettingsFile(settingsPath, (settings) => {
    const overrides = ensureSettingsOverrides(settings);
    const existing: SubagentAgentOverride = { ...(overrides[agentName] ?? {}) };
    const fallbackModels = Array.isArray(existing.fallbackModels) ? [...existing.fallbackModels] : [];
    if (!fallbackModels.includes(model)) fallbackModels.push(model);
    existing.fallbackModels = fallbackModels;
    overrides[agentName] = existing;
    result = fallbackModels;
  });
  return result;
}

export function pushProjectSubagentOverridesToUser(projectSettingsPath: string, userSettingsPath: string): number {
  const projectOverrides = requireSubagentAgentOverrides(projectSettingsPath, "Project");
  writeSubagentAgentOverrides(userSettingsPath, projectOverrides);
  return Object.keys(projectOverrides).length;
}

export function pullUserSubagentOverridesToProject(userSettingsPath: string, projectSettingsPath: string): number {
  const userOverrides = requireSubagentAgentOverrides(userSettingsPath, "User");
  writeSubagentAgentOverrides(projectSettingsPath, userOverrides);
  return Object.keys(userOverrides).length;
}
