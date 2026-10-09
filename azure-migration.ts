import * as fs from "node:fs";
import * as path from "node:path";
import { atomicReplace, readArtifact } from "./atomic-file.ts";
import { parseModelsDocument } from "./config.ts";
import { deepCloneJson } from "./model-fields.ts";
import { getOwnValue, hasOwnKey, setOwnValue, deleteOwnKey } from "./own-keys.ts";
import { modelPayloadKey, parseModelPayloadKey, type PayloadConfig } from "./payload-config.ts";
import { getTransactionJournalPath } from "./payload-coordinator.ts";
import { tryAcquireMutationLock } from "./process-lock.ts";
import type { ModelsConfig } from "./types.ts";

export const OLD_AZURE_PROVIDER_ID = "azure-openai-responses";
export const NEW_AZURE_PROVIDER_ID = "azure";
export const AZURE_MIGRATION_JOURNAL_FILE = "azure-migration-journal.json";

export function getAzureMigrationJournalPath(agentDir: string): string {
  return path.join(agentDir, AZURE_MIGRATION_JOURNAL_FILE);
}

export interface AzureMigrationOptions {
  agentDir: string;
  projectDir?: string;
  dryRun?: boolean;
}

export interface AzureMigrationFileChange {
  path: string;
  description: string;
}

export interface AzureMigrationPlan {
  status: "ready" | "no-op" | "conflict";
  conflictReason?: string;
  changes: AzureMigrationFileChange[];
  plannedArtifacts: Record<string, string>;
  knownArtifactPresence: Record<string, boolean>;
  migratedModelsCount: number;
  migratedPayloadsCount: number;
  migratedSettingsCount: number;
  migratedSubagentsCount: number;
}

export interface AzureMigrationResult {
  status: "success" | "no-op" | "aborted" | "partial-error";
  error?: string;
  plan: AzureMigrationPlan;
  writtenFiles: string[];
  notice: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type FileReadResult<T> =
  | { status: "missing" }
  | { status: "valid"; document: T; hash: string }
  | { status: "malformed"; safeError: string };

function readJsonFileStrict<T>(filePath: string): FileReadResult<T> {
  const artifact = readArtifact(filePath);
  if (artifact.bytes === undefined) return { status: "missing" };
  try {
    const text = new TextDecoder().decode(artifact.bytes);
    const document: unknown = JSON.parse(text);
    if (!isObject(document)) {
      return { status: "malformed", safeError: "JSON 根节点必须为对象" };
    }
    return { status: "valid", document: document as T, hash: artifact.hash };
  } catch {
    return { status: "malformed", safeError: "JSON 语法错误或文件格式损坏" };
  }
}

function readModelsStrict(filePath: string): FileReadResult<ModelsConfig> {
  const artifact = readArtifact(filePath);
  if (artifact.bytes === undefined) return { status: "missing" };
  try {
    const document = parseModelsDocument(filePath, artifact.bytes);
    return { status: "valid", document, hash: artifact.hash };
  } catch {
    return { status: "malformed", safeError: "models.json 语法错误或不符合模型配置模式" };
  }
}

function parseAnyModelPayloadKey(key: string): [string, string] | undefined {
  const tuple = parseModelPayloadKey(key);
  if (tuple) return tuple;
  const slash = key.indexOf("/");
  if (slash > 0) {
    return [key.slice(0, slash), key.slice(slash + 1)];
  }
  return undefined;
}

function migrateModelRef(ref: unknown): string | unknown {
  if (typeof ref !== "string") return ref;
  const prefix = `${OLD_AZURE_PROVIDER_ID}/`;
  if (ref.startsWith(prefix)) {
    return `${NEW_AZURE_PROVIDER_ID}/${ref.slice(prefix.length)}`;
  }
  return ref;
}

/**
 * Plans the migration from legacy `azure-openai-responses` provider ID to `azure`.
 * Scans models.json, model-config-payloads.json, settings.json, and subagent settings.
 * Fails closed if any target `azure` identity already exists (no silent overwrite).
 */
export function planAzureProviderMigration(options: AzureMigrationOptions): AzureMigrationPlan {
  const modelsPath = path.join(options.agentDir, "models.json");
  const payloadsPath = path.join(options.agentDir, "model-config-payloads.json");
  const userSettingsPath = path.join(options.agentDir, "settings.json");
  const projectSettingsPath = options.projectDir ? path.join(options.projectDir, ".pi", "settings.json") : undefined;

  const changes: AzureMigrationFileChange[] = [];
  const plannedArtifacts: Record<string, string> = {};
  const knownArtifactPresence: Record<string, boolean> = {};
  let migratedModelsCount = 0;
  let migratedPayloadsCount = 0;
  let migratedSettingsCount = 0;
  let migratedSubagentsCount = 0;

  // 1. Check models.json
  const modelsRead = readModelsStrict(modelsPath);
  knownArtifactPresence[modelsPath] = modelsRead.status !== "missing";
  if (modelsRead.status === "valid") {
    plannedArtifacts[modelsPath] = modelsRead.hash;
  }
  if (modelsRead.status === "malformed") {
    return {
      status: "conflict", conflictReason: `models.json 格式损坏或无法解析: ${modelsRead.safeError}`,
      changes: [], plannedArtifacts: {}, knownArtifactPresence,
      migratedModelsCount: 0, migratedPayloadsCount: 0, migratedSettingsCount: 0, migratedSubagentsCount: 0,
    };
  }
  if (modelsRead.status === "valid" && isObject(modelsRead.document.providers)) {
    const hasOld = hasOwnKey(modelsRead.document.providers, OLD_AZURE_PROVIDER_ID);
    const hasNew = hasOwnKey(modelsRead.document.providers, NEW_AZURE_PROVIDER_ID);
    if (hasOld && hasNew) {
      return {
        status: "conflict",
        conflictReason: `models.json 中同时存在 "${OLD_AZURE_PROVIDER_ID}" 与 "${NEW_AZURE_PROVIDER_ID}"，无法安全自动合并`,
        changes: [], plannedArtifacts: {}, knownArtifactPresence,
        migratedModelsCount: 0, migratedPayloadsCount: 0, migratedSettingsCount: 0, migratedSubagentsCount: 0,
      };
    }
    if (hasOld) {
      const oldProvider = getOwnValue(modelsRead.document.providers, OLD_AZURE_PROVIDER_ID) as Record<string, unknown>;
      const models = Array.isArray(oldProvider?.models) ? oldProvider.models : [];
      migratedModelsCount += models.length;
      changes.push({
        path: modelsPath,
        description: `将 providers["${OLD_AZURE_PROVIDER_ID}"] 重命名为 providers["${NEW_AZURE_PROVIDER_ID}"] (${models.length} 个模型)`,
      });
    }
  }

  // 2. Check model-config-payloads.json
  const payloadsRead = readJsonFileStrict<PayloadConfig>(payloadsPath);
  knownArtifactPresence[payloadsPath] = payloadsRead.status !== "missing";
  if (payloadsRead.status === "valid") {
    plannedArtifacts[payloadsPath] = payloadsRead.hash;
  }
  if (payloadsRead.status === "malformed") {
    return {
      status: "conflict", conflictReason: `model-config-payloads.json 格式损坏或无法解析: ${payloadsRead.safeError}`,
      changes: [], plannedArtifacts: {}, knownArtifactPresence,
      migratedModelsCount: 0, migratedPayloadsCount: 0, migratedSettingsCount: 0, migratedSubagentsCount: 0,
    };
  }
  if (payloadsRead.status === "valid" && isObject(payloadsRead.document.extraPayloads)) {
    const plannedTargetKeys = new Set<string>();
    for (const key of Object.keys(payloadsRead.document.extraPayloads)) {
      const identity = parseAnyModelPayloadKey(key);
      if (identity && identity[0] === OLD_AZURE_PROVIDER_ID) {
        const targetTupleKey = modelPayloadKey(NEW_AZURE_PROVIDER_ID, identity[1]);
        const targetSlashKey = `${NEW_AZURE_PROVIDER_ID}/${identity[1]}`;
        if (hasOwnKey(payloadsRead.document.extraPayloads, targetTupleKey) || hasOwnKey(payloadsRead.document.extraPayloads, targetSlashKey)) {
          return {
            status: "conflict",
            conflictReason: `model-config-payloads.json 中模型 "${identity[1]}" 已存在目标 key ("${targetTupleKey}" 或 "${targetSlashKey}")`,
            changes: [], plannedArtifacts: {}, knownArtifactPresence,
            migratedModelsCount: 0, migratedPayloadsCount: 0, migratedSettingsCount: 0, migratedSubagentsCount: 0,
          };
        }
        if (plannedTargetKeys.has(targetTupleKey) || plannedTargetKeys.has(targetSlashKey)) {
          return {
            status: "conflict",
            conflictReason: `model-config-payloads.json 中多个待迁移键映射到同一模型 "${identity[1]}" (批内目标冲突)`,
            changes: [], plannedArtifacts: {}, knownArtifactPresence,
            migratedModelsCount: 0, migratedPayloadsCount: 0, migratedSettingsCount: 0, migratedSubagentsCount: 0,
          };
        }
        plannedTargetKeys.add(targetTupleKey);
        plannedTargetKeys.add(targetSlashKey);
        migratedPayloadsCount += 1;
      }
    }
    if (migratedPayloadsCount > 0) {
      changes.push({
        path: payloadsPath,
        description: `迁移 ${migratedPayloadsCount} 个模型的 extraPayload 键值`,
      });
    }
  }

  // 3. Helper to check a settings file
  const checkSettings = (settingsFilePath: string, label: string) => {
    const settingsRead = readJsonFileStrict<Record<string, unknown>>(settingsFilePath);
    knownArtifactPresence[settingsFilePath] = settingsRead.status !== "missing";
    if (settingsRead.status === "valid") {
      plannedArtifacts[settingsFilePath] = settingsRead.hash;
    }
    if (settingsRead.status === "malformed") {
      return `${label} (${settingsFilePath}) 格式损坏或无法解析: ${settingsRead.safeError}`;
    }
    if (settingsRead.status === "missing") return undefined;
    const settings = settingsRead.document;
    let fileChanged = false;

    if (settings.defaultProvider === OLD_AZURE_PROVIDER_ID) {
      migratedSettingsCount += 1;
      fileChanged = true;
    }
    if (Array.isArray(settings.enabledModels)) {
      const hasOld = settings.enabledModels.some((m) => typeof m === "string" && m.startsWith(`${OLD_AZURE_PROVIDER_ID}/`));
      if (hasOld) {
        migratedSettingsCount += 1;
        fileChanged = true;
      }
    }
    for (const mapField of ["modelThinkingLevels", "modelSamplingParams"] as const) {
      const map = settings[mapField];
      if (isObject(map)) {
        for (const key of Object.keys(map)) {
          if (key.startsWith(`${OLD_AZURE_PROVIDER_ID}/`)) {
            const targetKey = `${NEW_AZURE_PROVIDER_ID}/${key.slice(OLD_AZURE_PROVIDER_ID.length + 1)}`;
            if (hasOwnKey(map, targetKey)) {
              return `settings.json (${label}) 的 ${mapField} 中已存在冲突键 "${targetKey}"`;
            }
            migratedSettingsCount += 1;
            fileChanged = true;
          }
        }
      }
    }

    // compaction.modelOverrides
    const compaction = settings.compaction;
    if (isObject(compaction) && isObject(compaction.modelOverrides)) {
      const overrides = compaction.modelOverrides as Record<string, unknown>;
      for (const key of Object.keys(overrides)) {
        if (key.startsWith(`${OLD_AZURE_PROVIDER_ID}/`)) {
          const targetKey = `${NEW_AZURE_PROVIDER_ID}/${key.slice(OLD_AZURE_PROVIDER_ID.length + 1)}`;
          if (hasOwnKey(overrides, targetKey)) {
            return `settings.json (${label}) 的 compaction.modelOverrides 中已存在冲突键 "${targetKey}"`;
          }
          migratedSettingsCount += 1;
          fileChanged = true;
        }
      }
    }

    // subagents
    const subagents = settings.subagents;
    if (isObject(subagents)) {
      if (isObject(subagents.agentOverrides)) {
        for (const override of Object.values(subagents.agentOverrides)) {
          if (isObject(override)) {
            if (typeof override.model === "string" && override.model.startsWith(`${OLD_AZURE_PROVIDER_ID}/`)) {
              migratedSubagentsCount += 1;
              fileChanged = true;
            }
            if (override.defaultProvider === OLD_AZURE_PROVIDER_ID) {
              migratedSubagentsCount += 1;
              fileChanged = true;
            }
          }
        }
      }
      if (isObject(subagents.agentOverridesByProvider)) {
        if (hasOwnKey(subagents.agentOverridesByProvider, OLD_AZURE_PROVIDER_ID)) {
          if (hasOwnKey(subagents.agentOverridesByProvider, NEW_AZURE_PROVIDER_ID)) {
            return `settings.json (${label}) 的 agentOverridesByProvider 已存在目标提供商 "${NEW_AZURE_PROVIDER_ID}"`;
          }
          migratedSubagentsCount += 1;
          fileChanged = true;
        }
        for (const providerGroup of Object.values(subagents.agentOverridesByProvider)) {
          if (isObject(providerGroup)) {
            for (const override of Object.values(providerGroup)) {
              if (isObject(override)) {
                if (typeof override.model === "string" && override.model.startsWith(`${OLD_AZURE_PROVIDER_ID}/`)) {
                  migratedSubagentsCount += 1;
                  fileChanged = true;
                }
                if (override.defaultProvider === OLD_AZURE_PROVIDER_ID) {
                  migratedSubagentsCount += 1;
                  fileChanged = true;
                }
              }
            }
          }
        }
      }
    }

    if (fileChanged) {
      changes.push({
        path: settingsFilePath,
        description: `更新 ${label} 中的 Azure Provider 与模型引用`,
      });
    }
    return undefined;
  };

  const userConflict = checkSettings(userSettingsPath, "User Settings");
  if (userConflict) {
    return {
      status: "conflict", conflictReason: userConflict, changes: [], plannedArtifacts: {}, knownArtifactPresence,
      migratedModelsCount: 0, migratedPayloadsCount: 0, migratedSettingsCount: 0, migratedSubagentsCount: 0,
    };
  }
  if (projectSettingsPath) {
    const projectConflict = checkSettings(projectSettingsPath, "Project Settings");
    if (projectConflict) {
      return {
        status: "conflict", conflictReason: projectConflict, changes: [], plannedArtifacts: {}, knownArtifactPresence,
        migratedModelsCount: 0, migratedPayloadsCount: 0, migratedSettingsCount: 0, migratedSubagentsCount: 0,
      };
    }
  }

  if (changes.length === 0) {
    return {
      status: "no-op",
      changes: [],
      plannedArtifacts,
      knownArtifactPresence,
      migratedModelsCount: 0,
      migratedPayloadsCount: 0,
      migratedSettingsCount: 0,
      migratedSubagentsCount: 0,
    };
  }

  return {
    status: "ready",
    changes,
    plannedArtifacts,
    knownArtifactPresence,
    migratedModelsCount,
    migratedPayloadsCount,
    migratedSettingsCount,
    migratedSubagentsCount,
  };
}

/**
 * Applies the planned Azure Provider migration.
 * Acquires mutation lock, verifies lack of pending transaction journal, writes migration journal,
 * validates hashes of all preflighted artifacts, and executes atomic single-file replaces.
 * Cleans up migration journal on completion. Leaves credentials in auth.json untouched.
 */
export async function applyAzureProviderMigration(
  options: AzureMigrationOptions,
  existingPlan?: AzureMigrationPlan,
): Promise<AzureMigrationResult> {
  const plan = existingPlan ?? planAzureProviderMigration(options);
  const NOTICE = `Azure 提供商已迁移至 "${NEW_AZURE_PROVIDER_ID}"。由于插件遵循值盲原则，凭据文件 auth.json 未被修改，请运行 /login azure 或检查 auth.json 中的凭据。`;
  const migrationJournalPath = getAzureMigrationJournalPath(options.agentDir);
  const coordJournalPath = getTransactionJournalPath(options.agentDir);

  // 1. Fail closed on pending transaction journal or leftover migration journal first,
  // before any early-returns (no-op, conflict, dryRun) to prevent bypassing recovery.
  if (fs.existsSync(coordJournalPath)) {
    return {
      status: "aborted",
      error: "检测到未决事务日志 (model-config-transaction.json)；请先通过 /model-config 恢复事务状态",
      plan,
      writtenFiles: [],
      notice: NOTICE,
    };
  }
  if (fs.existsSync(migrationJournalPath)) {
    return {
      status: "aborted",
      error: `检测到未完成的迁移日志 (${AZURE_MIGRATION_JOURNAL_FILE})；请先检查已修改文件或清理日志后重试`,
      plan,
      writtenFiles: [],
      notice: NOTICE,
    };
  }

  if (plan.status === "no-op") {
    return { status: "no-op", plan, writtenFiles: [], notice: NOTICE };
  }
  if (plan.status === "conflict") {
    return { status: "aborted", error: plan.conflictReason, plan, writtenFiles: [], notice: NOTICE };
  }
  if (options.dryRun) {
    return { status: "success", plan, writtenFiles: [], notice: NOTICE };
  }

  // 2. Acquire OS mutation lock
  const lockResult = await tryAcquireMutationLock(options.agentDir);
  if (lockResult.type !== "acquired") {
    return {
      status: "aborted",
      error: `无法获取模型修改互斥锁 (${lockResult.type})；另一个进程正在修改配置`,
      plan,
      writtenFiles: [],
      notice: NOTICE,
    };
  }

  const writtenFiles: string[] = [];

  try {
    // Re-check journals under the lock before any write to prevent TOCTOU races during lock acquisition
    if (fs.existsSync(coordJournalPath)) {
      return {
        status: "aborted",
        error: "检测到未决事务日志 (model-config-transaction.json)；请先通过 /model-config 恢复事务状态",
        plan,
        writtenFiles: [],
        notice: NOTICE,
      };
    }
    if (fs.existsSync(migrationJournalPath)) {
      return {
        status: "aborted",
        error: `检测到未完成的迁移日志 (${AZURE_MIGRATION_JOURNAL_FILE})；请先检查已修改文件或清理日志后重试`,
        plan,
        writtenFiles: [],
        notice: NOTICE,
      };
    }

    // 3. Pre-apply hash validation across ALL scanned and existing files (drift detection)
    for (const [filePath, expected] of Object.entries(plan.plannedArtifacts)) {
      const current = readArtifact(filePath).hash;
      if (expected !== current) {
        return {
          status: "aborted",
          error: `目标文件 "${filePath}" 在预检后发生了外部修改（hash mismatch: 预期 ${expected}，实际 ${current}），迁移中止以防覆盖外部改动`,
          plan,
          writtenFiles,
          notice: NOTICE,
        };
      }
    }

    // Check that files absent during plan were not concurrently created
    for (const [filePath, existed] of Object.entries(plan.knownArtifactPresence)) {
      if (!existed && fs.existsSync(filePath)) {
        return {
          status: "aborted",
          error: `文件 "${filePath}" 在预检后被外部并发创建，迁移中止以防覆盖外部改动`,
          plan,
          writtenFiles,
          notice: NOTICE,
        };
      }
    }

    // 4. Write pre-migration journal
    const journalData = {
      version: 1,
      timestamp: new Date().toISOString(),
      files: plan.changes.map((c) => c.path),
    };
    atomicReplace(migrationJournalPath, Buffer.from(JSON.stringify(journalData, null, 2) + "\n", "utf8"));

    // 5. Mutate only planned files
    for (const change of plan.changes) {
      const targetPath = change.path;
      const expectedHash = plan.plannedArtifacts[targetPath];

      if (targetPath.endsWith("models.json")) {
        const modelsRead = readModelsStrict(targetPath);
        if (modelsRead.status === "valid" && isObject(modelsRead.document.providers) && hasOwnKey(modelsRead.document.providers, OLD_AZURE_PROVIDER_ID)) {
          const nextModels = deepCloneJson(modelsRead.document);
          const oldConfig = getOwnValue(nextModels.providers, OLD_AZURE_PROVIDER_ID);
          deleteOwnKey(nextModels.providers, OLD_AZURE_PROVIDER_ID);
          setOwnValue(nextModels.providers, NEW_AZURE_PROVIDER_ID, oldConfig);
          atomicReplace(targetPath, Buffer.from(JSON.stringify(nextModels, null, 2) + "\n", "utf8"), { expectedHash });
          writtenFiles.push(targetPath);
        }
      } else if (targetPath.endsWith("model-config-payloads.json")) {
        const payloadsRead = readJsonFileStrict<PayloadConfig>(targetPath);
        if (payloadsRead.status === "valid" && isObject(payloadsRead.document.extraPayloads)) {
          const nextPayloads = deepCloneJson(payloadsRead.document);
          let changed = false;
          for (const key of Object.keys(nextPayloads.extraPayloads)) {
            const identity = parseAnyModelPayloadKey(key);
            if (identity && identity[0] === OLD_AZURE_PROVIDER_ID) {
              const isTuple = parseModelPayloadKey(key) !== undefined;
              const targetKey = isTuple ? modelPayloadKey(NEW_AZURE_PROVIDER_ID, identity[1]) : `${NEW_AZURE_PROVIDER_ID}/${identity[1]}`;
              const val = getOwnValue(nextPayloads.extraPayloads, key);
              deleteOwnKey(nextPayloads.extraPayloads, key);
              setOwnValue(nextPayloads.extraPayloads, targetKey, val);
              changed = true;
            }
          }
          if (changed) {
            atomicReplace(targetPath, Buffer.from(JSON.stringify(nextPayloads, null, 2) + "\n", "utf8"), { expectedHash });
            writtenFiles.push(targetPath);
          }
        }
      } else if (targetPath.endsWith("settings.json")) {
        const settingsRead = readJsonFileStrict<Record<string, unknown>>(targetPath);
        if (settingsRead.status === "valid") {
          const next = deepCloneJson(settingsRead.document);
          let changed = false;

          if (next.defaultProvider === OLD_AZURE_PROVIDER_ID) {
            next.defaultProvider = NEW_AZURE_PROVIDER_ID;
            changed = true;
          }
          if (Array.isArray(next.enabledModels)) {
            next.enabledModels = next.enabledModels.map((m) => {
              const migrated = migrateModelRef(m);
              if (migrated !== m) changed = true;
              return migrated;
            });
          }
          for (const mapField of ["modelThinkingLevels", "modelSamplingParams"] as const) {
            const map = next[mapField];
            if (isObject(map)) {
              for (const key of Object.keys(map)) {
                if (key.startsWith(`${OLD_AZURE_PROVIDER_ID}/`)) {
                  const targetKey = `${NEW_AZURE_PROVIDER_ID}/${key.slice(OLD_AZURE_PROVIDER_ID.length + 1)}`;
                  const val = getOwnValue(map, key);
                  deleteOwnKey(map, key);
                  setOwnValue(map, targetKey, val);
                  changed = true;
                }
              }
            }
          }

          // compaction.modelOverrides
          const compaction = next.compaction;
          if (isObject(compaction) && isObject(compaction.modelOverrides)) {
            const overrides = compaction.modelOverrides as Record<string, unknown>;
            for (const key of Object.keys(overrides)) {
              if (key.startsWith(`${OLD_AZURE_PROVIDER_ID}/`)) {
                const targetKey = `${NEW_AZURE_PROVIDER_ID}/${key.slice(OLD_AZURE_PROVIDER_ID.length + 1)}`;
                const val = getOwnValue(overrides, key);
                deleteOwnKey(overrides, key);
                setOwnValue(overrides, targetKey, val);
                changed = true;
              }
            }
          }

          // subagents
          const subagents = next.subagents;
          if (isObject(subagents)) {
            if (isObject(subagents.agentOverrides)) {
              for (const override of Object.values(subagents.agentOverrides)) {
                if (isObject(override)) {
                  if (typeof override.model === "string" && override.model.startsWith(`${OLD_AZURE_PROVIDER_ID}/`)) {
                    override.model = `${NEW_AZURE_PROVIDER_ID}/${override.model.slice(OLD_AZURE_PROVIDER_ID.length + 1)}`;
                    changed = true;
                  }
                  if (override.defaultProvider === OLD_AZURE_PROVIDER_ID) {
                    override.defaultProvider = NEW_AZURE_PROVIDER_ID;
                    changed = true;
                  }
                }
              }
            }
            if (isObject(subagents.agentOverridesByProvider)) {
              if (hasOwnKey(subagents.agentOverridesByProvider, OLD_AZURE_PROVIDER_ID)) {
                const providerOverrides = getOwnValue(subagents.agentOverridesByProvider, OLD_AZURE_PROVIDER_ID);
                deleteOwnKey(subagents.agentOverridesByProvider, OLD_AZURE_PROVIDER_ID);
                setOwnValue(subagents.agentOverridesByProvider, NEW_AZURE_PROVIDER_ID, providerOverrides);
                changed = true;
              }
              for (const providerGroup of Object.values(subagents.agentOverridesByProvider)) {
                if (isObject(providerGroup)) {
                  for (const override of Object.values(providerGroup)) {
                    if (isObject(override)) {
                      if (typeof override.model === "string" && override.model.startsWith(`${OLD_AZURE_PROVIDER_ID}/`)) {
                        override.model = `${NEW_AZURE_PROVIDER_ID}/${override.model.slice(OLD_AZURE_PROVIDER_ID.length + 1)}`;
                        changed = true;
                      }
                      if (override.defaultProvider === OLD_AZURE_PROVIDER_ID) {
                        override.defaultProvider = NEW_AZURE_PROVIDER_ID;
                        changed = true;
                      }
                    }
                  }
                }
              }
            }
          }

          if (changed) {
            atomicReplace(targetPath, Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8"), { expectedHash });
            writtenFiles.push(targetPath);
          }
        }
      }
    }

    // 6. Clean up migration journal upon complete success
    if (fs.existsSync(migrationJournalPath)) {
      fs.unlinkSync(migrationJournalPath);
    }

    return { status: "success", plan, writtenFiles, notice: NOTICE };
  } catch (err) {
    return {
      status: "partial-error",
      error: `迁移中途出错: ${err instanceof Error ? err.message : String(err)}；迁移日志保留于 ${AZURE_MIGRATION_JOURNAL_FILE}`,
      plan,
      writtenFiles,
      notice: NOTICE,
    };
  } finally {
    await lockResult.handle.release();
  }
}
