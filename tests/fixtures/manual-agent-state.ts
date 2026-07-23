import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const ARTIFACT_NAMES = [
  "models.json",
  "model-config-payloads.json",
  "model-config-transaction.json",
] as const;

type ArtifactName = typeof ARTIFACT_NAMES[number];
type ArtifactManifest = {
  version: 1;
  artifacts: Record<ArtifactName, { exists: boolean; byteLength?: number; sha256?: string }>;
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writePrivate(filePath: string, bytes: string): void {
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function seedEditor(agentDir: string, baseUrl: string): void {
  const models = {
    providers: {
      manual: {
        name: "Manual Fixture",
        baseUrl,
        api: "openai-completions",
        apiKey: "$MANUAL_MODEL_CONFIG_API_KEY",
        authHeader: true,
        headers: { "X-Manual-Fixture": "enabled" },
        models: [{
          id: "manual-existing",
          name: "Manual Existing",
          reasoning: true,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 16384,
          thinkingLevelMap: { off: "off", high: "high", xhigh: "max" },
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            tiers: [{ inputTokensAbove: 200000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
          },
          compat: { supportsUsageInStreaming: true },
        }],
      },
    },
  };
  const payloadKey = JSON.stringify(["manual", "manual-existing"]);
  const payloads = {
    version: 1,
    extraPayloads: {
      [payloadKey]: { fixtureFlag: true, samplingMode: "manual" },
    },
  };
  fs.writeFileSync(path.join(agentDir, "models.json"), serialize(models));
  writePrivate(path.join(agentDir, "model-config-payloads.json"), serialize(payloads));
  fs.rmSync(path.join(agentDir, "model-config-transaction.json"), { force: true });
}

function captureManifest(agentDir: string): ArtifactManifest {
  const artifacts = {} as ArtifactManifest["artifacts"];
  for (const name of ARTIFACT_NAMES) {
    const filePath = path.join(agentDir, name);
    if (!fs.existsSync(filePath)) {
      artifacts[name] = { exists: false };
      continue;
    }
    const bytes = fs.readFileSync(filePath);
    artifacts[name] = {
      exists: true,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return { version: 1, artifacts };
}

function parseManifest(filePath: string): ArtifactManifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid fixture manifest");
  return parsed as ArtifactManifest;
}

function main(): void {
  const agentDir = argument("--agent-dir");
  const scenario = argument("--scenario");
  const capturePath = argument("--capture-manifest");
  const assertPath = argument("--assert-manifest");
  if (!agentDir) throw new Error("usage: --agent-dir <path> [--scenario editor|malformed-journal-valid-files]");

  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(agentDir, 0o700);
  if (scenario) {
    if (scenario !== "editor" && scenario !== "malformed-journal-valid-files") {
      throw new Error("unknown manual fixture scenario");
    }
    seedEditor(agentDir, argument("--base-url") ?? "http://127.0.0.1:43123");
    if (scenario === "malformed-journal-valid-files") {
      writePrivate(path.join(agentDir, "model-config-transaction.json"), "{ malformed journal\n");
    }
  }

  if (capturePath) fs.writeFileSync(capturePath, serialize(captureManifest(agentDir)));
  if (assertPath && JSON.stringify(captureManifest(agentDir)) !== JSON.stringify(parseManifest(assertPath))) {
    throw new Error("agent artifacts differ from captured manifest");
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "manual fixture failed"}\n`);
  process.exitCode = 1;
}
