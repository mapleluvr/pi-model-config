import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function withTempAgentDir(run: (agentDir: string) => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-"));
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}
