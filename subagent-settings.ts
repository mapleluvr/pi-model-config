import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const BUILTIN_SUBAGENT_NAMES = [
  "context-builder",
  "delegate",
  "oracle",
  "planner",
  "researcher",
  "reviewer",
  "scout",
  "worker",
] as const;

export const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

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

function readJsonObject(filePath: string): Record<string, any> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(`Failed to read JSON from ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeJsonObject(filePath: string, value: Record<string, any>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function getOverridesFromSettings(settings: Record<string, any>): SubagentAgentOverrides | undefined {
  const subagents = settings.subagents;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return undefined;
  const overrides = subagents.agentOverrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return undefined;
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
  const settings = readJsonObject(settingsPath);
  const overrides = ensureSettingsOverrides(settings);
  writeJsonObject(settingsPath, settings);
  return overrides;
}

function cloneOverrides(overrides: SubagentAgentOverrides): SubagentAgentOverrides {
  return JSON.parse(JSON.stringify(overrides));
}

function writeSubagentAgentOverrides(settingsPath: string, overrides: SubagentAgentOverrides): void {
  const settings = readJsonObject(settingsPath);
  if (!settings.subagents || typeof settings.subagents !== "object" || Array.isArray(settings.subagents)) {
    settings.subagents = {};
  }
  settings.subagents.agentOverrides = cloneOverrides(overrides);
  writeJsonObject(settingsPath, settings);
}

function requireSubagentAgentOverrides(settingsPath: string, label: string): SubagentAgentOverrides {
  const overrides = getOverridesFromSettings(readJsonObject(settingsPath));
  if (!overrides) {
    throw new Error(`${label} settings does not contain subagents.agentOverrides: ${settingsPath}`);
  }
  return overrides;
}

function ensureSettingsOverrides(settings: Record<string, any>): SubagentAgentOverrides {
  if (!settings.subagents || typeof settings.subagents !== "object" || Array.isArray(settings.subagents)) {
    settings.subagents = {};
  }
  if (!settings.subagents.agentOverrides || typeof settings.subagents.agentOverrides !== "object" || Array.isArray(settings.subagents.agentOverrides)) {
    settings.subagents.agentOverrides = {};
  }
  return settings.subagents.agentOverrides as SubagentAgentOverrides;
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
): void {
  const settings = readJsonObject(settingsPath);
  const overrides = ensureSettingsOverrides(settings);
  const existing: SubagentAgentOverride = { ...(overrides[agentName] ?? {}) };

  for (const field of MANAGED_AGENT_OVERRIDE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
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
  writeJsonObject(settingsPath, settings);
}

export function deleteSubagentAgentOverride(settingsPath: string, agentName: string): void {
  const settings = readJsonObject(settingsPath);
  const overrides = ensureSettingsOverrides(settings);
  delete overrides[agentName];
  writeJsonObject(settingsPath, settings);
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
  const settings = readJsonObject(settingsPath);
  const overrides = ensureSettingsOverrides(settings);
  const existing: SubagentAgentOverride = { ...(overrides[agentName] ?? {}) };
  const fallbackModels = Array.isArray(existing.fallbackModels) ? [...existing.fallbackModels] : [];
  if (!fallbackModels.includes(model)) fallbackModels.push(model);
  existing.fallbackModels = fallbackModels;
  overrides[agentName] = existing;
  writeJsonObject(settingsPath, settings);
  return fallbackModels;
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
