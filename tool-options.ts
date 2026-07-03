export interface ToolInfoLike {
  name: string;
  description?: string;
  sourceInfo?: unknown;
}

export interface ToolSelectionOption {
  value: string;
  label: string;
  description?: string;
  searchText?: string;
  warning?: string;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function sourceInfoText(sourceInfo: unknown): string {
  if (!sourceInfo || typeof sourceInfo !== "object") return "";
  const entries = Object.entries(sourceInfo as Record<string, unknown>)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => `${key}:${value}`);
  return entries.join(" ");
}

export function buildToolSelectionOptions(
  activeToolNames: string[],
  allTools: ToolInfoLike[],
): ToolSelectionOption[] {
  const toolInfoByName = new Map(allTools.map((tool) => [tool.name, tool]));

  return uniqueInOrder(activeToolNames).map((toolName) => {
    const info = toolInfoByName.get(toolName);
    const description = info?.description;
    const sourceText = sourceInfoText(info?.sourceInfo);
    return {
      value: toolName,
      label: toolName,
      description,
      searchText: [toolName, description, sourceText].filter(Boolean).join(" ") || toolName,
      warning: toolName === "subagent" ? "Allows nested subagent fanout" : undefined,
    };
  });
}

export function normalizeToolList(raw: string): string[] {
  return uniqueInOrder(raw.split(/[\s,]+/));
}
