import type { SubagentAgentOverride } from "./subagent-settings.ts";

export function formatToolsOverride(tools: SubagentAgentOverride["tools"]): string {
  if (tools === false) return "tools=(disabled all)";
  if (!Array.isArray(tools) || tools.length === 0) return "tools=(agent default)";
  return `tools=${tools.length} [${tools.join(", ")}]`;
}

export function formatSubagentOverrideSummary(agentName: string, override?: SubagentAgentOverride): string {
  const model = override?.model || "(默认 Pi 当前模型)";
  const thinking = override?.thinking ? ` thinking=${override.thinking}` : "";
  const fallback = override?.fallbackModels?.length ? ` fallback=${override.fallbackModels.length}` : "";
  const tools = override && Object.prototype.hasOwnProperty.call(override, "tools")
    ? ` ${formatToolsOverride(override.tools)}`
    : "";
  return `编辑 [${agentName}] model=${model}${thinking}${fallback}${tools}`;
}

export function getInitialToolsSelection(
  parentToolNames: string[],
  tools: SubagentAgentOverride["tools"],
): string[] {
  if (tools === false) return [];
  if (Array.isArray(tools)) return [...tools];
  return [...parentToolNames];
}
