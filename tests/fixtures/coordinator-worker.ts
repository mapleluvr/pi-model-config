import { commitCoordinatedMutation } from "../../payload-coordinator.ts";
import { modelPayloadKey, type PayloadConfig } from "../../payload-config.ts";

const [boundary, agentDir] = process.argv.slice(2);
if ((boundary !== "journal" && boundary !== "native" && boundary !== "payload") || !agentDir) process.exit(2);

const model = (id: string) => ({
  id, reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const native = { providers: { local: { baseUrl: "http://localhost", api: "openai-completions", models: [model("two")] } } };
const payload: PayloadConfig = { version: 1, extraPayloads: { [modelPayloadKey("local", "two")]: { setting: "after" } } };

await commitCoordinatedMutation({
  build: () => ({ native, payload, affectedIdentities: [["local", "two"]] }),
  onBoundary(current) {
    if (current === boundary) process.exit(0);
  },
}, { agentDir });
process.exit(3);
