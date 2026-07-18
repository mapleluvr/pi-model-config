import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  TwoPaneSettingsPanel,
  getVisibleSettingsWindow,
  normalizeSettingsPanelState,
  openSettingsPanel,
  type SettingsCategoryDescriptor,
  type SettingsPanelResult,
} from "../settings-panel.ts";

const categories: SettingsCategoryDescriptor[] = [
  {
    id: "general",
    label: "General",
    fields: [
      { id: "name", label: "Display name", displayValue: "Example", searchText: "name label", action: "edit-field" },
      { id: "limits", label: "Limits", displayValue: "2 entries", warning: "Review limits", action: "open-section" },
    ],
  },
  {
    id: "actions",
    label: "Actions",
    fields: [
      { id: "delete", label: "Delete", displayValue: "Permanent", action: "run-action" },
    ],
  },
];

const plainTheme = {
  fg: (_name: string, value: string) => value,
};

const ansiTheme = {
  fg: (_name: string, value: string) => `\u001b[36m${value}\u001b[0m`,
};

const bindings = {
  matches(data: string, action: string) {
    return data === ({
      "tui.select.up": "UP",
      "tui.select.down": "DOWN",
      "tui.select.confirm": "OK",
      "tui.select.cancel": "CANCEL",
    } as Record<string, string>)[action];
  },
  getKeys(action: string) {
    return ({
      "tui.select.up": ["ctrl+p"],
      "tui.select.down": ["ctrl+n"],
      "tui.select.confirm": ["ctrl+j"],
      "tui.select.cancel": ["ctrl+x"],
    } as Record<string, string[]>)[action] ?? [];
  },
};

function makePanel(options: {
  width?: number;
  initialState?: Parameters<typeof normalizeSettingsPanelState>[1];
  theme?: typeof plainTheme;
} = {}) {
  const results: SettingsPanelResult[] = [];
  let renderRequests = 0;
  const panel = new TwoPaneSettingsPanel({
    title: "Provider: example",
    subtitle: "Settings",
    categories,
    initialState: options.initialState,
    theme: options.theme ?? plainTheme,
    keybindings: bindings as any,
    requestRender: () => { renderRequests += 1; },
    done: (result) => results.push(result),
  });
  const width = options.width ?? 120;
  return { panel, results, width, renderRequests: () => renderRequests };
}

function text(lines: string[]): string {
  return lines.join("\n");
}

test("normalizes removed category and field IDs deterministically", () => {
  assert.deepEqual(normalizeSettingsPanelState(categories, {
    categoryId: "removed",
    fieldId: "removed",
    focusedPane: "fields",
    categoryScrollOffset: 99,
    fieldScrollOffset: 99,
    narrowScreen: "fields",
  }), {
    categoryId: "general",
    fieldId: "name",
    focusedPane: "fields",
    categoryScrollOffset: 0,
    fieldScrollOffset: 0,
    narrowScreen: "fields",
  });

  assert.equal(normalizeSettingsPanelState(categories, {
    categoryId: "actions",
    fieldId: "name",
  }).fieldId, "delete");
});

test("keeps selected rows inside a bounded visible window", () => {
  assert.deepEqual(getVisibleSettingsWindow(20, 0, 8, 7), { startIndex: 0, endIndex: 7, offset: 0 });
  assert.deepEqual(getVisibleSettingsWindow(20, 9, 0, 7), { startIndex: 3, endIndex: 10, offset: 3 });
  assert.deepEqual(getVisibleSettingsWindow(20, 19, 3, 7), { startIndex: 13, endIndex: 20, offset: 13 });
  assert.deepEqual(getVisibleSettingsWindow(2, 1, 8, 7), { startIndex: 0, endIndex: 2, offset: 0 });
});

test("renders wide at 120 and 88, narrow at 87 and 40, with bounded ANSI widths", () => {
  const snapshots = new Map<number, string[]>([
    [120, [
      "Provider: example",
      "Settings",
      "Categories [FOCUS]             | Fields",
      "> General                      | * Display name  Example",
      "  Actions                      |   Limits  2 entries",
      "Tab/Left/Right switch pane  ctrl+p/ctrl+n move  ctrl+j activate  / search  ctrl+x back",
    ]],
    [88, [
      "Provider: example",
      "Settings",
      "Categories [FOCUS]         | Fields",
      "> General                  | * Display name  Example",
      "  Actions                  |   Limits  2 entries",
      "Tab/Left/Right switch pane  ctrl+p/ctrl+n move  ctrl+j activate  / search  ctrl+x back",
    ]],
    [87, [
      "Provider: example",
      "Settings",
      "Categories [FOCUS]",
      "> General",
      "  Actions",
      "ctrl+p/ctrl+n move  ctrl+j open  / search  ctrl+x back",
    ]],
    [40, [
      "Provider: example",
      "Settings",
      "Categories [FOCUS]",
      "> General",
      "  Actions",
      "ctrl+p/ctrl+n move  ctrl+j open  / searc",
    ]],
  ]);

  for (const width of [120, 88, 87, 40]) {
    const plainLines = makePanel({ width }).panel.render(width)
      .map((line) => line.replaceAll("\u001b[0m", "").trimEnd());
    assert.deepEqual(plainLines, snapshots.get(width));

    const lines = makePanel({ width, theme: ansiTheme }).panel.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("wide navigation previews categories, marks focus textually, and activates field semantics", () => {
  const { panel, results, renderRequests } = makePanel();
  assert.match(text(panel.render(120)), /> General/);
  panel.handleInput("DOWN");
  assert.equal(panel.getState().categoryId, "actions");
  assert.equal(panel.getState().fieldId, "delete");
  assert.match(text(panel.render(120)), /> Actions/);
  panel.handleInput("OK");
  assert.equal(panel.getState().focusedPane, "fields");
  assert.match(text(panel.render(120)), /Fields \[FOCUS\]/);
  panel.handleInput("OK");
  assert.equal(results[0]?.type, "run-action");
  assert.equal(results[0]?.fieldId, "delete");
  assert.ok(renderRequests() >= 2);
});

test("wide pane controls and warning rendering retain semantic field IDs", () => {
  const { panel, results } = makePanel({ initialState: { focusedPane: "fields", fieldId: "limits" } });
  const rendered = text(panel.render(88));
  assert.match(rendered, /! Review limits/);
  assert.match(rendered, /> Limits/);
  panel.handleInput("\x1b[D");
  assert.equal(panel.getState().focusedPane, "categories");
  panel.handleInput("\t");
  assert.equal(panel.getState().focusedPane, "fields");
  panel.handleInput("OK");
  assert.deepEqual(results[0] && { type: results[0].type, categoryId: results[0].categoryId, fieldId: results[0].fieldId }, {
    type: "open-section", categoryId: "general", fieldId: "limits",
  });
});

test("search and configured cancel return complete restorable state", () => {
  const searchPanel = makePanel({ initialState: { categoryId: "actions", fieldId: "delete", focusedPane: "fields" } });
  searchPanel.panel.handleInput("/");
  assert.equal(searchPanel.results[0]?.type, "search");
  assert.deepEqual(searchPanel.results[0]?.state, searchPanel.panel.getState());

  const backPanel = makePanel({ initialState: { categoryId: "actions", fieldId: "delete" } });
  backPanel.panel.handleInput("CANCEL");
  assert.equal(backPanel.results[0]?.type, "back");
  assert.equal(backPanel.results[0]?.state.categoryId, "actions");
});

test("narrow confirm enters fields, cancel returns to categories, then closes", () => {
  const { panel, results } = makePanel({ width: 87 });
  panel.render(87);
  panel.handleInput("OK");
  assert.equal(panel.getState().narrowScreen, "fields");
  assert.match(text(panel.render(87)), /Provider: example > General/);
  panel.handleInput("CANCEL");
  assert.equal(panel.getState().narrowScreen, "categories");
  assert.equal(results.length, 0);
  panel.handleInput("CANCEL");
  assert.equal(results[0]?.type, "back");
});

test("restores category, field, focus, offsets, and narrow screen", () => {
  const initialState = {
    categoryId: "general",
    fieldId: "limits",
    focusedPane: "fields" as const,
    categoryScrollOffset: 0,
    fieldScrollOffset: 1,
    narrowScreen: "fields" as const,
  };
  const { panel } = makePanel({ initialState });
  assert.deepEqual(panel.getState(), initialState);
  assert.match(text(panel.render(40)), /> Limits/);
});

test("footer uses injected configured action labels and only literal custom controls", () => {
  const { panel } = makePanel();
  const rendered = text(panel.render(120));
  assert.match(rendered, /ctrl\+p\/ctrl\+n move/);
  assert.match(rendered, /ctrl\+j activate/);
  assert.match(rendered, /ctrl\+x back/);
  assert.match(rendered, /Tab\/Left\/Right/);
  assert.doesNotMatch(rendered, /Enter|Esc|Up\/Down/);
});

test("openSettingsPanel uses the sole non-overlay custom wrapper", async () => {
  let options: unknown;
  const expected = { type: "back", state: normalizeSettingsPanelState(categories) } as SettingsPanelResult;
  const ctx = {
    ui: {
      custom: async (factory: any, suppliedOptions: unknown) => {
        options = suppliedOptions;
        const component = factory({ requestRender() {} }, plainTheme, bindings, () => {});
        assert.ok(component instanceof TwoPaneSettingsPanel);
        return expected;
      },
    },
  };
  const result = await openSettingsPanel(ctx as any, { title: "Title", categories });
  assert.equal(result, expected);
  assert.deepEqual(options, { overlay: false });
});
