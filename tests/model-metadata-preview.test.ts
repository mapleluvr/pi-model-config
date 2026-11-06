import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { confirmModelMetadata } from "../model-metadata-preview.ts";

async function drivePreview(input: "accept" | "cancel"): Promise<{
  result: boolean;
  renderedPages: string[];
  totalLines: number;
}> {
  let result = false;
  let doneCalled = false;
  const renderedPages: string[] = [];
  const description = Array.from({ length: 24 }, (_, index) => (
    `field-${String(index).padStart(2, "0")}: nested-config-value-${"x".repeat(12)}`
  )).join("\n");
  const answer = await confirmModelMetadata({ ui: {
    custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: boolean) => void) => any) => {
      const component = factory({ terminal: { rows: 22 }, requestRender() {} }, {
        fg: (_color: string, value: string) => value,
      }, {
        matches: (data: string, action: string) => data === ({
          "tui.select.up": "UP",
          "tui.select.down": "DOWN",
          "tui.select.confirm": "ENTER",
          "tui.select.cancel": "ESC",
        } as Record<string, string>)[action],
      }, (value: boolean) => { result = value; doneCalled = true; });
      for (const width of [24, 80]) {
        for (let step = 0; step < 20; step++) {
          const lines = component.render(width);
          assert.ok(lines.length <= 15, "preview stays inside the available terminal height");
          assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
          renderedPages.push(lines.join("\n"));
          if (step < 18) component.handleInput(step % 2 === 0 ? "DOWN" : "\u001b[6~");
        }
      }
      component.handleInput(input === "accept" ? "ENTER" : "ESC");
      return result;
    },
  } } as any, description);
  assert.equal(doneCalled, true);
  return { result: answer, renderedPages, totalLines: description.split("\n").length };
}

test("the confirmation page scrolls through every preview row and accepts only Enter", async () => {
  const preview = await drivePreview("accept");
  assert.equal(preview.result, true);
  const rendered = preview.renderedPages.join("\n");
  assert.match(rendered, /field-00/);
  assert.match(rendered, /field-23/);
  assert.ok(preview.totalLines > 12);
});

test("canceling the full preview returns false without accepting the overwrite", async () => {
  const preview = await drivePreview("cancel");
  assert.equal(preview.result, false);
  assert.match(preview.renderedPages.join("\n"), /field-23/);
});
