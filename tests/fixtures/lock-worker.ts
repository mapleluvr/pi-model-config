import * as readline from "node:readline";
import { tryAcquireMutationLock } from "../../process-lock.ts";

const [, , mode, agentDir, blockText, platformText] = process.argv;
if (!mode || !agentDir) process.exit(64);

const lockOverrides = platformText === "darwin" ? { platform: "darwin" as const } : {};
const result = await tryAcquireMutationLock(agentDir, lockOverrides);
if (result.type !== "acquired") {
  process.stdout.write(`${result.type}\n`);
  process.exit(0);
}

if (mode === "acquire") {
  process.stdout.write("acquired\n");
  await result.handle.release();
  process.exit(0);
}

if (mode !== "block" && mode !== "hold") {
  await result.handle.release();
  process.exit(64);
}

process.stdout.write("READY\n");
if (mode === "block") {
  const blockMs = Number(blockText ?? 2_500);
  const until = Date.now() + blockMs;
  while (Date.now() < until) {
    // Deliberately pause the JavaScript event loop while the OS keeps the endpoint bound.
  }
  process.stdout.write("RESUMED\n");
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
for await (const line of input) {
  if (line === "RELEASE") {
    await result.handle.release();
    process.stdout.write("RELEASED\n");
    input.close();
    break;
  }
  if (line === "CRASH") process.exit(17);
}
