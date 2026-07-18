import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  atomicRemove,
  atomicReplace,
  hashArtifact,
  quarantineArtifact,
  readArtifact,
} from "../atomic-file.ts";
import { withTempAgentDir } from "./helpers/temp-agent-dir.ts";

function temporaryEntries(directory: string): string[] {
  return fs.readdirSync(directory).filter((entry) => entry.endsWith(".tmp"));
}

test("reads and hashes present and absent artifacts", () => withTempAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "artifact.json");
  const absent = readArtifact(filePath);
  assert.equal(absent.exists, false);
  assert.equal(absent.bytes, undefined);
  assert.equal(absent.mode, undefined);
  assert.equal(absent.hash, hashArtifact(undefined));
  assert.notEqual(hashArtifact(undefined), hashArtifact(Buffer.alloc(0)));

  fs.writeFileSync(filePath, "old");
  const present = readArtifact(filePath);
  assert.equal(present.exists, true);
  assert.equal(present.bytes?.toString("utf8"), "old");
  assert.equal(present.hash, hashArtifact(Buffer.from("old")));
  assert.equal(typeof present.mode, "number");
}));

test("atomically replaces bytes and retains an existing native file mode", () => withTempAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, "old", { mode: 0o640 });
  const mode = fs.statSync(filePath).mode & 0o777;

  atomicReplace(filePath, Buffer.from("new"));

  assert.equal(fs.readFileSync(filePath, "utf8"), "new");
  assert.equal(fs.statSync(filePath).mode & 0o777, mode);
  assert.deepEqual(temporaryEntries(agentDir), []);
}));

test("supports an explicit mode for new private artifacts", () => withTempAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "private.json");
  atomicReplace(filePath, Buffer.from("secret"), { mode: 0o600 });
  const writtenMode = fs.statSync(filePath).mode & 0o777;
  if (process.platform === "win32") assert.equal(typeof writtenMode, "number");
  else assert.equal(writtenMode, 0o600);
}));

test("preserves old bytes and cleans its temp when failure is injected before rename", () => withTempAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, "old");

  assert.throws(() => atomicReplace(filePath, Buffer.from("new"), {
    beforeRename() {
      throw new Error("injected before rename");
    },
  }), /injected before rename/);

  assert.equal(fs.readFileSync(filePath, "utf8"), "old");
  assert.deepEqual(temporaryEntries(agentDir), []);
}));

test("rejects a changed destination precondition without replacing it", () => withTempAgentDir((agentDir) => {
  const filePath = path.join(agentDir, "models.json");
  fs.writeFileSync(filePath, "changed");

  assert.throws(() => atomicReplace(filePath, Buffer.from("new"), {
    expectedHash: hashArtifact(Buffer.from("old")),
  }), /changed before replacement/);

  assert.equal(fs.readFileSync(filePath, "utf8"), "changed");
  assert.deepEqual(temporaryEntries(agentDir), []);
}));

test("atomically removes and quarantines artifacts", () => withTempAgentDir((agentDir) => {
  const removedPath = path.join(agentDir, "remove.json");
  fs.writeFileSync(removedPath, "remove");
  atomicRemove(removedPath);
  assert.equal(fs.existsSync(removedPath), false);
  atomicRemove(removedPath);

  const corruptPath = path.join(agentDir, "corrupt.json");
  fs.writeFileSync(corruptPath, "corrupt");
  const quarantinedPath = quarantineArtifact(corruptPath, 1_725_000_000_000);
  assert.equal(quarantinedPath, `${corruptPath}.corrupt-1725000000000`);
  assert.equal(fs.existsSync(corruptPath), false);
  assert.equal(fs.readFileSync(quarantinedPath, "utf8"), "corrupt");
}));
