import type { SubagentAgentOverride } from "./subagent-settings.ts";

export function formatToolsOverride(tools: SubagentAgentOverride["tools"]): string {
  if (tools === false) return "tools=(disabled all)";
  if (tools === "inherit") return "tools=(inherit Pi defaults)";
  if (!Array.isArray(tools) || tools.length === 0) return "tools=(agent default)";
  return `tools=${tools.length} [${tools.join(", ")}]`;
}

function formatModelOverride(model: SubagentAgentOverride["model"]): string {
  if (model === false) return "(清除模型固定，继承当前模型)";
  return typeof model === "string" && model.length > 0 ? model : "(默认 Pi 当前模型)";
}

export function formatSubagentOverrideSummary(agentName: string, override?: SubagentAgentOverride): string {
  const model = formatModelOverride(override?.model);
  const thinking = override?.thinking ? ` thinking=${override.thinking}` : "";
  const tools = override && Object.prototype.hasOwnProperty.call(override, "tools")
    ? ` ${formatToolsOverride(override.tools)}`
    : "";
  return `编辑 [${agentName}] model=${model}${thinking}${tools}`;
}

export function getInitialToolsSelection(
  parentToolNames: string[],
  tools: SubagentAgentOverride["tools"],
): string[] {
  if (tools === false) return [];
  if (Array.isArray(tools)) return [...tools];
  return [...parentToolNames];
}
