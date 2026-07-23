import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  deriveEndpointIdentity,
  serializeIpcHandshake,
  tryAcquireMutationLock,
  type EndpointIdentity,
  type LockDependencies,
} from "../process-lock.ts";

type Platform = "win32" | "linux" | "darwin";

type TimerHandle = ReturnType<typeof setTimeout>;

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: string[] = [];
  writeError: NodeJS.ErrnoException | undefined;
  deferWrite = false;
  private writeCallbacks: Array<(error?: Error) => void> = [];

  write(data: string | Uint8Array, callback?: (error?: Error) => void): boolean {
    this.writes.push(String(data));
    if (callback) {
      if (this.deferWrite) this.writeCallbacks.push(callback);
      else queueMicrotask(() => callback(this.writeError));
    }
    return true;
  }

  finishWrite(error: Error | undefined = this.writeError): void {
    for (const callback of this.writeCallbacks.splice(0)) callback(error);
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

class FakeServer extends EventEmitter {
  listening = false;
  listenCalls: unknown[] = [];
  bindError: NodeJS.ErrnoException | undefined;
  closeCalls = 0;
  connectionListener: (socket: FakeSocket) => void = () => undefined;

  listen(address: unknown): this {
    this.listenCalls.push(address);
    queueMicrotask(() => {
      if (this.bindError) this.emit("error", this.bindError);
      else {
        this.listening = true;
        this.emit("listening");
      }
    });
    return this;
  }

  close(callback?: (error?: Error) => void): this {
    this.closeCalls += 1;
    this.listening = false;
    queueMicrotask(() => {
      this.emit("close");
      callback?.();
    });
    return this;
  }

  accept(socket: FakeSocket): void {
    this.connectionListener(socket);
  }

  unexpectedError(code = "EIO"): void {
    const error = Object.assign(new Error(code), { code });
    this.emit("error", error);
  }

  unexpectedClose(): void {
    this.listening = false;
    this.emit("close");
  }
}

interface FakeEnvironment {
  deps: LockDependencies;
  server: FakeServer;
  connections: FakeSocket[];
  connectionIdentity: EndpointIdentity[];
  timers: Array<{ callback: () => void; milliseconds: number; cleared: boolean }>;
  setConnectBehavior(run: (socket: FakeSocket, onConnect: () => void) => void): void;
}

const HASH = "0123456789abcdef".repeat(4);

function errorWithCode(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function fakeEnvironment(platform: Platform, runtime: "node" | "bun" = "node"): FakeEnvironment {
  const server = new FakeServer();
  const connections: FakeSocket[] = [];
  const connectionIdentity: EndpointIdentity[] = [];
  const timers: Array<{ callback: () => void; milliseconds: number; cleared: boolean }> = [];
  let connectBehavior = (socket: FakeSocket, onConnect: () => void): void => {
    queueMicrotask(() => {
      onConnect();
      socket.emit("connect");
    });
  };

  const deps: LockDependencies = {
    canonicalRealpath: async () => platform === "win32" ? "c:/Users/Mixed/Agent" : "/tmp/Agent",
    sha256: () => HASH,
    generateToken: () => "owner-token",
    platform,
    runtime,
    pid: 42,
    createServer(listener) {
      server.connectionListener = listener as (socket: FakeSocket) => void;
      return server as never;
    },
    createConnection(identity, onConnect) {
      const socket = new FakeSocket();
      connections.push(socket);
      connectionIdentity.push(identity);
      connectBehavior(socket, onConnect);
      return socket as never;
    },
    setTimer(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer as never;
    },
    clearTimer(handle) {
      (handle as unknown as { cleared: boolean }).cleared = true;
    },
    probeTimeoutMs: 250,
    socketLifetimeMs: 100,
  };

  return {
    deps,
    server,
    connections,
    connectionIdentity,
    timers,
    setConnectBehavior(run) {
      connectBehavior = run;
    },
  };
}

async function acquired(environment: FakeEnvironment) {
  const result = await tryAcquireMutationLock("ignored", environment.deps);
  assert.equal(result.type, "acquired");
  if (result.type !== "acquired") throw new Error("expected acquired result");
  return result.handle;
}

function bindError(environment: FakeEnvironment, code: string, message = code): void {
  environment.server.bindError = errorWithCode(code, message);
}

test("derives full-hash Windows, Linux, and macOS endpoint identities", () => {
  const seen: string[] = [];
  const sha256 = (value: string): string => {
    seen.push(value);
    return HASH;
  };

  const windows = deriveEndpointIdentity("c:/Users/Mixed/Agent", "win32", sha256);
  assert.equal(seen.pop(), "C:\\Users\\Mixed\\Agent");
  assert.deepEqual(windows, {
    platform: "win32",
    hash: HASH,
    address: `\\\\.\\pipe\\pi-model-config-${HASH}`,
  });

  deriveEndpointIdentity("C:/Users/mixed/Agent", "win32", sha256);
  assert.equal(seen.pop(), "C:\\Users\\mixed\\Agent");

  const linux = deriveEndpointIdentity("/tmp/Agent", "linux", sha256);
  assert.equal(linux.address, `\0pi-model-config-${HASH}`);
  assert.equal((linux.address as string).length, 17 + HASH.length);

  const macHash = `ffff${"0".repeat(60)}`;
  const mac = deriveEndpointIdentity("/tmp/Agent", "darwin", () => macHash);
  assert.deepEqual(mac, {
    platform: "darwin",
    hash: macHash,
    address: { host: "127.0.0.1", port: 65_535 },
  });
});

test("serializes a capped, secret-free v1 handshake", () => {
  const serialized = serializeIpcHandshake({
    version: 1,
    identityHash: HASH,
    ownerToken: "opaque-token",
    pid: 123,
  });
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), ["identityHash", "ownerToken", "pid", "version"]);
  assert.equal(serialized.includes("Agent"), false);
  assert.equal(serialized.endsWith("\n"), true);
  assert.ok(Buffer.byteLength(serialized) <= 512);
});

test("listen success is ownership and release is idempotent fencing", async () => {
  const environment = fakeEnvironment("linux");
  const handle = await acquired(environment);
  assert.equal(handle.token, "owner-token");
  assert.doesNotThrow(() => handle.assertOwned());
  assert.equal(environment.server.listenCalls.length, 1);

  await handle.release();
  await handle.release();
  assert.equal(environment.server.closeCalls, 1);
  assert.throws(() => handle.assertOwned(), /no longer owned/i);
});

test("canonicalization and unsupported bind failures fail closed", async () => {
  const canonicalFailure = fakeEnvironment("linux");
  canonicalFailure.deps.canonicalRealpath = async () => { throw errorWithCode("ENOENT"); };
  assert.deepEqual(await tryAcquireMutationLock("missing", canonicalFailure.deps), { type: "unsupported" });
  assert.equal(canonicalFailure.server.listenCalls.length, 0);

  const bindFailure = fakeEnvironment("linux");
  bindError(bindFailure, "EACCES");
  assert.deepEqual(await tryAcquireMutationLock("ignored", bindFailure.deps), { type: "unsupported" });
  assert.equal(bindFailure.server.listenCalls.length, 1);
});

test("Node occupied pipe and abstract UDS are immediately busy", async () => {
  for (const platform of ["win32", "linux"] as const) {
    const environment = fakeEnvironment(platform, "node");
    bindError(environment, "EADDRINUSE");
    assert.deepEqual(await tryAcquireMutationLock("ignored", environment.deps), { type: "busy" });
    assert.equal(environment.connections.length, 0);
    assert.equal(environment.server.listenCalls.length, 1);
  }
});

test("Bun exact occupied-pipe error performs one bounded exact-pipe probe", async () => {
  const environment = fakeEnvironment("win32", "bun");
  const exactPipe = `\\\\.\\pipe\\pi-model-config-${HASH}`;
  bindError(environment, "ERR_INVALID_ARG_TYPE", `Failed to listen at ${exactPipe}`);

  assert.deepEqual(await tryAcquireMutationLock("ignored", environment.deps), { type: "busy" });
  assert.equal(environment.connections.length, 1);
  assert.equal(environment.connectionIdentity[0]?.address, exactPipe);
  assert.equal(environment.server.listenCalls.length, 1);
  assert.equal(environment.timers[0]?.milliseconds, 250);
  assert.equal(environment.timers[0]?.cleared, true);
  assert.equal(environment.connections[0]?.destroyed, true);
});

test("Bun exact-pipe probe failures and timeout collide without rebinding", async () => {
  for (const failure of ["error", "timeout"] as const) {
    const environment = fakeEnvironment("win32", "bun");
    const exactPipe = `\\\\.\\pipe\\pi-model-config-${HASH}`;
    bindError(environment, "ERR_INVALID_ARG_TYPE", `Failed to listen at ${exactPipe}`);
    environment.setConnectBehavior((socket, onConnect) => {
      if (failure === "error") queueMicrotask(() => socket.emit("error", errorWithCode("ECONNREFUSED")));
      else queueMicrotask(() => environment.timers[0]?.callback());
      void onConnect;
    });

    assert.deepEqual(await tryAcquireMutationLock("ignored", environment.deps), { type: "collision" });
    assert.equal(environment.connections.length, 1);
    assert.equal(environment.server.listenCalls.length, 1);
    assert.equal(environment.connections[0]?.destroyed, true);
  }
});

test("Bun errors for any non-exact pipe do not probe", async () => {
  for (const message of ["Failed to listen at \\\\.\\pipe\\different", `prefix Failed to listen at \\\\.\\pipe\\pi-model-config-${HASH}`]) {
    const environment = fakeEnvironment("win32", "bun");
    bindError(environment, "ERR_INVALID_ARG_TYPE", message);
    assert.deepEqual(await tryAcquireMutationLock("ignored", environment.deps), { type: "unsupported" });
    assert.equal(environment.connections.length, 0);
  }
});

test("macOS matching owner handshake is busy", async () => {
  const environment = fakeEnvironment("darwin");
  bindError(environment, "EADDRINUSE");
  environment.setConnectBehavior((socket, onConnect) => queueMicrotask(() => {
    onConnect();
    socket.emit("data", serializeIpcHandshake({ version: 1, identityHash: HASH, ownerToken: "other", pid: 9 }));
  }));

  assert.deepEqual(await tryAcquireMutationLock("ignored", environment.deps), { type: "busy" });
  assert.deepEqual(environment.connectionIdentity[0]?.address, { host: "127.0.0.1", port: 49_152 + 0x0123 });
  assert.equal(environment.server.listenCalls.length, 1);
});

test("macOS different, malformed, oversized, and timed-out probes collide", async () => {
  const cases = ["different", "malformed", "oversized", "timeout"] as const;
  for (const probeCase of cases) {
    const environment = fakeEnvironment("darwin");
    bindError(environment, "EADDRINUSE");
    environment.setConnectBehavior((socket, onConnect) => queueMicrotask(() => {
      onConnect();
      if (probeCase === "different") {
        socket.emit("data", serializeIpcHandshake({ version: 1, identityHash: "f".repeat(64), ownerToken: "x", pid: 1 }));
      } else if (probeCase === "malformed") socket.emit("data", "not-json\n");
      else if (probeCase === "oversized") socket.emit("data", "x".repeat(513));
      else environment.timers[0]?.callback();
    }));

    assert.deepEqual(await tryAcquireMutationLock("ignored", environment.deps), { type: "collision" });
    assert.equal(environment.server.listenCalls.length, 1);
    assert.equal(environment.connections[0]?.destroyed, true);
  }
});

test("macOS owner bounds its one-message response and handles peer failures", async () => {
  const environment = fakeEnvironment("darwin");
  const handle = await acquired(environment);

  const disconnected = new FakeSocket();
  disconnected.deferWrite = true;
  environment.server.accept(disconnected);
  disconnected.emit("end");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disconnected.destroyed, true);
  assert.doesNotThrow(() => disconnected.emit("error", errorWithCode("ECONNRESET")));
  assert.doesNotThrow(() => handle.assertOwned());

  const epipe = new FakeSocket();
  epipe.writeError = errorWithCode("EPIPE");
  environment.server.accept(epipe);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(epipe.writes.length, 1);
  assert.ok(Buffer.byteLength(epipe.writes[0]!) <= 512);
  assert.equal(epipe.destroyed, true);
  assert.doesNotThrow(() => handle.assertOwned());

  const lifetime = new FakeSocket();
  lifetime.deferWrite = true;
  environment.server.accept(lifetime);
  const lifetimeTimer = environment.timers.at(-1)!;
  assert.equal(lifetimeTimer.milliseconds, 100);
  lifetimeTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifetime.destroyed, true);
  assert.doesNotThrow(() => handle.assertOwned());

  await handle.release();
});

test("pipe owner destroys accepted sockets immediately without response", async () => {
  for (const platform of ["win32", "linux"] as const) {
    const environment = fakeEnvironment(platform);
    const handle = await acquired(environment);
    const peer = new FakeSocket();
    environment.server.accept(peer);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(peer.writes.length, 0);
    assert.equal(peer.destroyed, true);
    peer.emit("error", errorWithCode("ECONNRESET"));
    assert.doesNotThrow(() => handle.assertOwned());
    await handle.release();
  }
});

test("release destroys and awaits tracked accepted sockets", async () => {
  const environment = fakeEnvironment("darwin");
  const handle = await acquired(environment);
  const peer = new FakeSocket();
  peer.deferWrite = true;
  environment.server.accept(peer);

  const released = handle.release();
  assert.equal(peer.destroyed, true);
  await released;
  assert.equal(environment.server.closeCalls, 1);
  assert.throws(() => handle.assertOwned(), /no longer owned/i);
});

test("unexpected server error or close fences every synchronous write boundary", async () => {
  for (const loss of ["error", "close"] as const) {
    const environment = fakeEnvironment("linux");
    const handle = await acquired(environment);
    if (loss === "error") environment.server.unexpectedError();
    else environment.server.unexpectedClose();

    const writes: string[] = [];
    for (const step of ["journal", "native", "payload"]) {
      assert.throws(() => {
        handle.assertOwned();
        writes.push(step);
      }, /no longer owned/i);
    }
    assert.deepEqual(writes, []);
    await handle.release();
  }
});

interface WorkerOptions {
  blockMs?: number;
  platform?: "darwin";
}

class Worker {
  readonly child: ChildProcessWithoutNullStreams;
  private lines: string[] = [];
  private waiters: Array<{ expected: string; resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private partial = "";

  constructor(runtime: "node" | "bun", mode: string, agentDir: string, options: WorkerOptions = {}) {
    const fixture = path.resolve("tests/fixtures/lock-worker.ts");
    const command = runtime === "node" ? process.execPath : "bun";
    const workerArgs = [mode, agentDir, String(options.blockMs ?? 2_500), options.platform ?? "current"];
    const args = runtime === "node"
      ? ["--experimental-strip-types", fixture, ...workerArgs]
      : [fixture, ...workerArgs];
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.once("exit", (code, signal) => {
      const error = new Error(`worker exited before marker (code=${code}, signal=${signal}, stderr=${this.child.stderr.read() ?? ""})`);
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
  }

  private consume(chunk: string): void {
    this.partial += chunk;
    for (;;) {
      const newline = this.partial.indexOf("\n");
      if (newline < 0) return;
      const line = this.partial.slice(0, newline).trim();
      this.partial = this.partial.slice(newline + 1);
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.expected === line);
      if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1)[0]!.resolve(line);
      else this.lines.push(line);
    }
  }

  waitFor(expected: string): Promise<string> {
    const existing = this.lines.indexOf(expected);
    if (existing >= 0) {
      this.lines.splice(existing, 1);
      return Promise.resolve(expected);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expected}; saw ${this.lines.join(", ")}`)), 15_000);
      this.waiters.push({
        expected,
        resolve(line) { clearTimeout(timer); resolve(line); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
    });
  }

  send(command: string): void {
    this.child.stdin.write(`${command}\n`);
  }

  kill(): void {
    this.child.kill();
  }

  async exited(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
  }
}

function bunAvailable(): boolean {
  return spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
}

function makeRealAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-lock-"));
}

function loopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close((error) => resolve(error === undefined));
    });
  });
}

async function makeIsolatedDarwinAgentDir(): Promise<string> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const agentDir = makeRealAgentDir();
    const canonicalPath = fs.realpathSync.native(agentDir);
    const identity = deriveEndpointIdentity(canonicalPath, "darwin", (value) => (
      createHash("sha256").update(value).digest("hex")
    ));
    if (typeof identity.address !== "string" && await loopbackPortAvailable(identity.address.port)) return agentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
  throw new Error("unable to reserve an isolated Darwin lock port");
}

async function runContender(
  runtime: "node" | "bun",
  agentDir: string,
  expected: string,
  options: WorkerOptions = {},
): Promise<void> {
  const contender = new Worker(runtime, "acquire", agentDir, options);
  try {
    await contender.waitFor(expected);
    await contender.exited();
  } finally {
    contender.kill();
    await contender.exited();
  }
}

test("real current-platform owner/contender matrix survives pause and releases cleanly", async (t) => {
  const runtimes: Array<"node" | "bun"> = bunAvailable() ? ["node", "bun"] : ["node"];
  const blockedResult = process.platform === "darwin" ? "collision" : "busy";
  for (const ownerRuntime of runtimes) {
    for (const contenderRuntime of runtimes) {
      await t.test(`${ownerRuntime}/${contenderRuntime}`, async () => {
        const agentDir = makeRealAgentDir();
        const owner = new Worker(ownerRuntime, "block", agentDir);
        try {
          await owner.waitFor("READY");
          await runContender(contenderRuntime, agentDir, blockedResult);
          await owner.waitFor("RESUMED");
          await runContender(contenderRuntime, agentDir, "busy");
          owner.send("RELEASE");
          await owner.waitFor("RELEASED");
          await owner.exited();
          await runContender(contenderRuntime, agentDir, "acquired");
        } finally {
          owner.kill();
          await owner.exited();
          fs.rmSync(agentDir, { recursive: true, force: true });
        }
      });
    }
  }
});

test("forced Darwin loopback times out while blocked then matches after resume", {
  skip: process.platform === "darwin",
}, async () => {
  const agentDir = await makeIsolatedDarwinAgentDir();
  const options: WorkerOptions = { platform: "darwin" };
  const owner = new Worker("node", "block", agentDir, options);
  try {
    await owner.waitFor("READY");
    await runContender("node", agentDir, "collision", options);
    await owner.waitFor("RESUMED");
    await runContender("node", agentDir, "busy", options);
    owner.send("RELEASE");
    await owner.waitFor("RELEASED");
    await owner.exited();
    await runContender("node", agentDir, "acquired", options);
  } finally {
    owner.kill();
    await owner.exited();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("real owner kill and crash release authority without cleanup", async (t) => {
  const runtimes: Array<"node" | "bun"> = bunAvailable() ? ["node", "bun"] : ["node"];
  for (const runtime of runtimes) {
    for (const ending of ["kill", "crash"] as const) {
      await t.test(`${runtime}/${ending}`, async () => {
        const agentDir = makeRealAgentDir();
        const owner = new Worker(runtime, "hold", agentDir);
        try {
          await owner.waitFor("READY");
          if (ending === "kill") owner.kill();
          else owner.send("CRASH");
          await owner.exited();
          await runContender(runtime, agentDir, "acquired");
        } finally {
          owner.kill();
          await owner.exited();
          fs.rmSync(agentDir, { recursive: true, force: true });
        }
      });
    }
  }
});
