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

    if (options.expectedHash !== undefined) {
      const currentHash = readArtifact(filePath).hash;
      if (currentHash !== options.expectedHash) {
        throw new Error(`Artifact at ${filePath} changed before replacement`);
      }
    }

    options.beforeRename?.();
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

export function atomicRemove(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  syncDirectory(path.dirname(filePath));
}

export function quarantineArtifact(filePath: string, timestamp: number | string): string {
  const quarantinePath = `${filePath}.corrupt-${timestamp}`;
  fs.renameSync(filePath, quarantinePath);
  syncDirectory(path.dirname(filePath));
  return quarantinePath;
}
