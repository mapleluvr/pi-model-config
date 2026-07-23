import assert from "node:assert/strict";

export interface ScriptedUiValues {
  selects?: Array<string | undefined>;
  inputs?: Array<string | undefined>;
  editors?: Array<string | undefined>;
}

export type ScriptedUiCall =
  | { kind: "select"; title: string; options: string[]; result: string | undefined }
  | { kind: "input"; title: string; placeholder: string | undefined; result: string | undefined }
  | { kind: "editor"; title: string; initialValue: string | undefined; result: string | undefined }
  | { kind: "notify"; message: string; level: string | undefined };

function take<T>(values: T[], kind: string): T {
  if (values.length === 0) throw new Error(`Missing scripted ${kind} result`);
  return values.shift()!;
}

export function createScriptedUi(script: ScriptedUiValues = {}): {
  ctx: any;
  calls: ScriptedUiCall[];
  assertExhausted(): void;
} {
  const selects = [...(script.selects ?? [])];
  const inputs = [...(script.inputs ?? [])];
  const editors = [...(script.editors ?? [])];
  const calls: ScriptedUiCall[] = [];
  const ctx = {
    ui: {
      select: async (title: string, options: string[]) => {
        const result = take(selects, "select");
        calls.push({ kind: "select", title, options: [...options], result });
        if (result !== undefined && !options.includes(result)) {
          throw new Error("Scripted select result was not offered by the UI");
        }
        return result;
      },
      input: async (title: string, placeholder?: string) => {
        const result = take(inputs, "input");
        calls.push({ kind: "input", title, placeholder, result });
        return result;
      },
      editor: async (title: string, initialValue?: string) => {
        const result = take(editors, "editor");
        calls.push({ kind: "editor", title, initialValue, result });
        return result;
      },
      notify: (message: string, level?: string) => {
        calls.push({ kind: "notify", message, level });
      },
    },
  };
  return {
    ctx,
    calls,
    assertExhausted() {
      assert.equal(selects.length, 0, "unconsumed select results");
      assert.equal(inputs.length, 0, "unconsumed input results");
      assert.equal(editors.length, 0, "unconsumed editor results");
    },
  };
}

function containsString(value: unknown, forbidden: string, seen: Set<object>): boolean {
  if (typeof value === "string") return value.includes(forbidden);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsString(entry, forbidden, seen));
  return Object.values(value).some((entry) => containsString(entry, forbidden, seen));
}

export function assertRecordedUiDoesNotContain(calls: ScriptedUiCall[], forbidden: string): void {
  if (containsString(calls, forbidden, new Set())) {
    throw new Error("Recorded UI exposed a forbidden stored value");
  }
}
