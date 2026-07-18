import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";

const HANDSHAKE_LIMIT = 512;
const DEFAULT_PROBE_TIMEOUT_MS = 750;
const DEFAULT_SOCKET_LIFETIME_MS = 250;

type SupportedPlatform = "win32" | "linux" | "darwin";
type RuntimeIdentity = "node" | "bun";

interface IpcSocket {
  destroyed: boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  write(data: string | Uint8Array, callback?: (error?: Error) => void): boolean;
  destroy(): this;
}

interface IpcServer {
  listening: boolean;
  listen(address: string | { host: "127.0.0.1"; port: number }): this;
  close(callback?: (error?: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
}

export interface EndpointIdentity {
  platform: SupportedPlatform;
  hash: string;
  address: string | { host: "127.0.0.1"; port: number };
}

export interface IpcHandshakeV1 {
  version: 1;
  identityHash: string;
  ownerToken: string;
  pid: number;
}

export interface MutationLockHandle {
  token: string;
  assertOwned(): void;
  release(): Promise<void>;
}

export type AcquireLockResult =
  | { type: "acquired"; handle: MutationLockHandle }
  | { type: "busy" }
  | { type: "collision" }
  | { type: "unsupported" };

export interface LockDependencies {
  canonicalRealpath(agentDir: string): Promise<string>;
  sha256(value: string): string;
  generateToken(): string;
  platform: NodeJS.Platform | string;
  runtime: RuntimeIdentity;
  pid: number;
  createServer(listener: (socket: IpcSocket) => void): IpcServer;
  createConnection(identity: EndpointIdentity, onConnect: () => void): IpcSocket;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(handle: unknown): void;
  probeTimeoutMs: number;
  socketLifetimeMs: number;
}

function normalizeWindowsCanonicalPath(canonicalPath: string): string {
  const separators = canonicalPath.replaceAll("/", "\\");
  return separators.replace(/^([a-z]):\\/i, (_, drive: string) => `${drive.toUpperCase()}:\\`);
}

export function deriveEndpointIdentity(
  canonicalPath: string,
  platform: SupportedPlatform,
  sha256: (value: string) => string,
): EndpointIdentity {
  const identityInput = platform === "win32" ? normalizeWindowsCanonicalPath(canonicalPath) : canonicalPath;
  const hash = sha256(identityInput);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("SHA-256 dependency returned an invalid digest");

  if (platform === "win32") {
    return { platform, hash, address: `\\\\.\\pipe\\pi-model-config-${hash}` };
  }
  if (platform === "linux") {
    return { platform, hash, address: `\0pi-model-config-${hash}` };
  }
  const firstWord = Number.parseInt(hash.slice(0, 4), 16);
  return {
    platform,
    hash,
    address: { host: "127.0.0.1", port: 49_152 + (firstWord % 16_384) },
  };
}

export function serializeIpcHandshake(handshake: IpcHandshakeV1): string {
  const serialized = `${JSON.stringify(handshake)}\n`;
  if (Buffer.byteLength(serialized) > HANDSHAKE_LIMIT) {
    throw new Error("IPC handshake exceeds the protocol limit");
  }
  return serialized;
}

function defaultSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

function realDependencies(): LockDependencies {
  return {
    canonicalRealpath: async (agentDir) => fs.realpathSync.native(agentDir),
    sha256: defaultSha256,
    generateToken: () => randomBytes(32).toString("hex"),
    platform: process.platform,
    runtime: isBunRuntime() ? "bun" : "node",
    pid: process.pid,
    createServer: (listener) => net.createServer(listener as (socket: net.Socket) => void) as unknown as IpcServer,
    createConnection(identity, onConnect) {
      if (typeof identity.address === "string") {
        return net.createConnection(identity.address, onConnect) as unknown as IpcSocket;
      }
      return net.createConnection(identity.address.port, identity.address.host, onConnect) as unknown as IpcSocket;
    },
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    socketLifetimeMs: DEFAULT_SOCKET_LIFETIME_MS,
  };
}

function mergeDependencies(overrides: Partial<LockDependencies>): LockDependencies {
  return { ...realDependencies(), ...overrides };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validHandshake(value: unknown): value is IpcHandshakeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "identityHash,ownerToken,pid,version") return false;
  return record.version === 1
    && typeof record.identityHash === "string"
    && /^[0-9a-f]{64}$/.test(record.identityHash)
    && typeof record.ownerToken === "string"
    && record.ownerToken.length > 0
    && Number.isSafeInteger(record.pid)
    && (record.pid as number) >= 0;
}

function probeWindowsPipe(identity: EndpointIdentity, deps: LockDependencies): Promise<AcquireLockResult> {
  return new Promise((resolve) => {
    let socket: IpcSocket | undefined;
    let timer: unknown;
    let settled = false;

    const finish = (result: AcquireLockResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) deps.clearTimer(timer);
      socket?.destroy();
      resolve(result);
    };

    try {
      socket = deps.createConnection(identity, () => finish({ type: "busy" }));
      socket.on("error", () => finish({ type: "collision" }));
      socket.on("end", () => finish({ type: "collision" }));
      socket.on("close", () => finish({ type: "collision" }));
      timer = deps.setTimer(() => finish({ type: "collision" }), deps.probeTimeoutMs);
      if (settled) socket.destroy();
    } catch {
      finish({ type: "collision" });
    }
  });
}

function probeMacOwner(identity: EndpointIdentity, deps: LockDependencies): Promise<AcquireLockResult> {
  return new Promise((resolve) => {
    let socket: IpcSocket | undefined;
    let timer: unknown;
    let settled = false;
    let input = Buffer.alloc(0);

    const finish = (result: AcquireLockResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) deps.clearTimer(timer);
      socket?.destroy();
      resolve(result);
    };

    try {
      socket = deps.createConnection(identity, () => undefined);
      socket.on("data", (chunk: Uint8Array | string) => {
        if (settled) return;
        input = Buffer.concat([input, Buffer.from(chunk)]);
        if (input.length > HANDSHAKE_LIMIT) {
          finish({ type: "collision" });
          return;
        }
        const newline = input.indexOf(0x0a);
        if (newline < 0) return;
        if (newline !== input.length - 1) {
          finish({ type: "collision" });
          return;
        }
        try {
          const parsed: unknown = JSON.parse(input.subarray(0, newline).toString("utf8"));
          finish(validHandshake(parsed) && parsed.identityHash === identity.hash
            ? { type: "busy" }
            : { type: "collision" });
        } catch {
          finish({ type: "collision" });
        }
      });
      socket.on("error", () => finish({ type: "collision" }));
      socket.on("end", () => finish({ type: "collision" }));
      socket.on("close", () => finish({ type: "collision" }));
      timer = deps.setTimer(() => finish({ type: "collision" }), deps.probeTimeoutMs);
      if (settled) socket.destroy();
    } catch {
      finish({ type: "collision" });
    }
  });
}

async function classifyBindFailure(
  error: unknown,
  identity: EndpointIdentity,
  deps: LockDependencies,
): Promise<AcquireLockResult> {
  const code = errorCode(error);
  if (code === "EADDRINUSE") {
    if (identity.platform === "darwin") return probeMacOwner(identity, deps);
    return { type: "busy" };
  }

  if (
    identity.platform === "win32"
    && deps.runtime === "bun"
    && code === "ERR_INVALID_ARG_TYPE"
    && errorMessage(error) === `Failed to listen at ${identity.address}`
  ) {
    return probeWindowsPipe(identity, deps);
  }

  return { type: "unsupported" };
}

interface OwnerState {
  expectedClose: boolean;
  released: boolean;
  lost: boolean;
}

function createOwnerHandle(
  server: IpcServer,
  clients: Map<IpcSocket, Promise<void>>,
  state: OwnerState,
  token: string,
): MutationLockHandle {
  let releasePromise: Promise<void> | undefined;

  return {
    token,
    assertOwned(): void {
      if (state.released || state.lost || !server.listening) {
        throw new Error("Mutation lock is no longer owned");
      }
    },
    release(): Promise<void> {
      if (releasePromise) return releasePromise;
      state.released = true;
      state.expectedClose = true;
      releasePromise = (async () => {
        const socketClosures = [...clients.values()];
        for (const socket of clients.keys()) socket.destroy();

        const serverClosure = new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          try {
            server.close((error) => error ? reject(error) : resolve());
          } catch (error) {
            reject(error);
          }
        });

        await Promise.all([...socketClosures, serverClosure]);
      })();
      return releasePromise;
    },
  };
}

export async function tryAcquireMutationLock(
  agentDir: string,
  overrides: Partial<LockDependencies> = {},
): Promise<AcquireLockResult> {
  const deps = mergeDependencies(overrides);
  if (deps.platform !== "win32" && deps.platform !== "linux" && deps.platform !== "darwin") {
    return { type: "unsupported" };
  }

  let canonicalPath: string;
  let identity: EndpointIdentity;
  try {
    canonicalPath = await deps.canonicalRealpath(agentDir);
    identity = deriveEndpointIdentity(canonicalPath, deps.platform, deps.sha256);
  } catch {
    return { type: "unsupported" };
  }

  const token = deps.generateToken();
  const handshake: IpcHandshakeV1 = { version: 1, identityHash: identity.hash, ownerToken: token, pid: deps.pid };
  let serializedHandshake: string;
  try {
    serializedHandshake = serializeIpcHandshake(handshake);
  } catch {
    return { type: "unsupported" };
  }

  const clients = new Map<IpcSocket, Promise<void>>();
  const state: OwnerState = { expectedClose: false, released: false, lost: false };
  const acceptClient = (socket: IpcSocket): void => {
    let lifetimeTimer: unknown;
    let closeClient!: () => void;
    const closed = new Promise<void>((resolve) => { closeClient = resolve; });
    clients.set(socket, closed);

    const remove = (): void => {
      if (lifetimeTimer !== undefined) deps.clearTimer(lifetimeTimer);
      if (clients.delete(socket)) closeClient();
    };
    const destroy = (): void => { socket.destroy(); };

    socket.on("error", destroy);
    socket.on("end", destroy);
    socket.on("close", remove);

    if (identity.platform !== "darwin") {
      socket.destroy();
      return;
    }

    lifetimeTimer = deps.setTimer(destroy, deps.socketLifetimeMs);
    try {
      socket.write(serializedHandshake, () => destroy());
    } catch {
      destroy();
    }
  };

  let server: IpcServer;
  try {
    server = deps.createServer(acceptClient);
  } catch {
    return { type: "unsupported" };
  }

  return new Promise<AcquireLockResult>((resolve) => {
    let decided = false;
    const removeInitialListeners = (): void => {
      server.removeListener("error", initialError);
      server.removeListener("listening", initialListening);
    };
    const initialError = (error: unknown): void => {
      if (decided) return;
      decided = true;
      removeInitialListeners();
      void classifyBindFailure(error, identity, deps).then(resolve);
    };
    const initialListening = (): void => {
      if (decided) return;
      decided = true;
      removeInitialListeners();
      server.on("error", () => {
        if (!state.expectedClose) state.lost = true;
      });
      server.on("close", () => {
        if (!state.expectedClose) state.lost = true;
      });
      resolve({ type: "acquired", handle: createOwnerHandle(server, clients, state, token) });
    };

    server.once("error", initialError);
    server.once("listening", initialListening);
    try {
      server.listen(identity.address);
    } catch (error) {
      initialError(error);
    }
  });
}
