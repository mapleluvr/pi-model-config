export type CompatBooleanChoice = "default" | "false" | "true";

export function applyCompatBooleanChoice(
  compat: Record<string, any>,
  key: string,
  choice: CompatBooleanChoice,
): Record<string, any> {
  const next = { ...compat };

  if (choice === "default") {
    delete next[key];
    return next;
  }

  next[key] = choice === "true";
  return next;
}
