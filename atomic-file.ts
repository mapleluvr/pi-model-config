import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ArtifactSnapshot {
  exists: boolean;
  bytes?: Buffer;
  hash: string;
  mode?: number;
}

export interface AtomicReplaceOptions {
  expectedHash?: string;
  mode?: number;
  beforeRename?: () => void;
}

export interface AtomicRemoveOptions {
  expectedHash?: string;
  beforeUnlink?: () => void;
}

export interface QuarantineArtifactOptions {
  expectedHash?: string;
  mode?: number;
  beforeRename?: () => void;
  /** Test seam: replaces fs.chmodSync when tightening the source before rename. */
  applySecureMode?: (filePath: string, mode: number) => void;
  /** Test seam: runs after the source mode is tightened and before rename. */
  afterSecureMode?: () => void;
}

export function hashArtifact(bytesOrAbsent: Uint8Array | undefined): string {
  const hash = createHash("sha256");
  if (bytesOrAbsent === undefined) hash.update(Buffer.from([0]));
  else {
    hash.update(Buffer.from([1]));
    hash.update(bytesOrAbsent);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function readArtifact(filePath: string): ArtifactSnapshot {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    return {
      exists: true,
      bytes,
      hash: hashArtifact(bytes),
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, hash: hashArtifact(undefined) };
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EISDIR" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function createTemporaryFile(filePath: string, mode: number): { descriptor: number; tempPath: string } {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tempPath = path.join(directory, `.${baseName}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      return { descriptor: fs.openSync(tempPath, "wx", mode), tempPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to create a unique temporary file for ${filePath}`);
}

export function atomicReplace(filePath: string, bytes: Uint8Array, options: AtomicReplaceOptions = {}): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const initial = readArtifact(filePath);
  const mode = options.mode ?? initial.mode ?? 0o600;
  const temporary = createTemporaryFile(filePath, mode);
  let descriptor: number | undefined = temporary.descriptor;

  try {
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    options.beforeRename?.();

    if (options.expectedHash !== undefined) {
      const currentHash = readArtifact(filePath).hash;
      if (currentHash !== options.expectedHash) {
        throw new Error(`Artifact at ${filePath} changed before replacement`);
      }
    }

    fs.renameSync(temporary.tempPath, filePath);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      fs.unlinkSync(temporary.tempPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        // The destination is already safe; preserve the original failure.
      }
    }
    throw error;
  }
}

export function atomicRemove(filePath: string, options: AtomicRemoveOptions = {}): void {
  options.beforeUnlink?.();
  if (options.expectedHash !== undefined) {
    const currentHash = readArtifact(filePath).hash;
    if (currentHash !== options.expectedHash) throw new Error(`Artifact at ${filePath} changed before removal`);
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.expectedHash === undefined) return;
    throw error;
  }
  syncDirectory(path.dirname(filePath));
}

export function quarantineArtifact(
  filePath: string,
  timestamp: number | string,
  options: QuarantineArtifactOptions = {},
): string {
  const quarantinePath = `${filePath}.corrupt-${timestamp}`;
  options.beforeRename?.();
  if (options.expectedHash !== undefined) {
    const currentHash = readArtifact(filePath).hash;
    if (currentHash !== options.expectedHash) throw new Error(`Artifact at ${filePath} changed before quarantine`);
  }
  // Tighten the source mode before the artifact is reachable under the quarantine name.
  // A crash after this leaves the original path at owner-only mode, which is safe.
  if (options.mode !== undefined) {
    const applySecureMode = options.applySecureMode ?? ((target, mode) => fs.chmodSync(target, mode));
    applySecureMode(filePath, options.mode);
    options.afterSecureMode?.();
  }
  try {
    fs.renameSync(filePath, quarantinePath);
    syncDirectory(path.dirname(filePath));
    return quarantinePath;
  } catch (error) {
    try {
      fs.renameSync(quarantinePath, filePath);
    } catch {
      // Preserve the rename or directory-sync failure.
    }
    throw error;
  }
}
