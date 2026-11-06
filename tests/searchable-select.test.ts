import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  filterSearchableOptions,
  getVisibleRange,
  renderSearchableOptionLine,
  searchableSelect,
  type SearchableSelectOption,
} from "../searchable-select.ts";

const modelOptions: SearchableSelectOption[] = [
  {
    value: "anthropic/claude-sonnet-4",
    label: "Model anthropic/claude-sonnet-4",
    description: "Claude Sonnet 4",
    searchText: "anthropic claude sonnet 4",
  },
  {
    value: "openai/gpt-5-mini",
    label: "Model openai/gpt-5-mini",
    description: "GPT-5 Mini",
    searchText: "openai gpt 5 mini",
  },
  {
    value: "Mapleluv/deepseek-v4-pro",
    label: "Model Mapleluv/deepseek-v4-pro",
    description: "DeepSeek V4 Pro",
    searchText: "Mapleluv deepseek v4 pro",
  },
];

test("filters options using native-style fuzzy token matching across value, label, description, and search text", () => {
  assert.deepEqual(
    filterSearchableOptions(modelOptions, "son anthropic").map((item) => item.value),
    ["anthropic/claude-sonnet-4"],
  );

  assert.deepEqual(
    filterSearchableOptions(modelOptions, "gpt mini").map((item) => item.value),
    ["openai/gpt-5-mini"],
  );

  assert.deepEqual(
    filterSearchableOptions(modelOptions, "v4 maple").map((item) => item.value),
    ["Mapleluv/deepseek-v4-pro"],
  );
});

test("ID-only search retains provider variants without matching display/provider text", () => {
  const options = [
    { value: "azure:astra", label: "Azure", searchText: "gpt-6-astra" },
    { value: "openai:astra", label: "OpenAI", searchText: "gpt-6-astra" },
    { value: "bedrock:astra", label: "Amazon Bedrock", searchText: "openai.gpt-6-astra-v1:0" },
    { value: "other", label: "GPT-6 Astra", searchText: "unrelated-model" },
  ];
  assert.deepEqual(filterSearchableOptions(options, "gpt6 astra", { searchTextOnly: true }).map(item => item.value), [
    "azure:astra", "openai:astra", "bedrock:astra",
  ]);
  assert.deepEqual(filterSearchableOptions(options, "Azure", { searchTextOnly: true }), []);
});

test("keeps an empty query in original option order", () => {
  assert.deepEqual(
    filterSearchableOptions(modelOptions, "   ").map((item) => item.value),
    modelOptions.map((item) => item.value),
  );
});

test("the real picker starts with the model ID query, renders provider variants, and selects the filtered row", async () => {
  const selected = await searchableSelect({ ui: {
    custom: async (factory: any) => {
      let result: string | undefined;
      const component = factory({}, { fg: (_color: string, value: string) => value }, {
        matches: (data: string, action: string) => data === ({
          "tui.select.down": "DOWN", "tui.select.confirm": "OK",
        } as Record<string, string>)[action],
      }, (value: string | undefined) => { result = value; });
      component.focused = true;
      for (const width of [40, 100]) {
        const lines = component.render(width);
        assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
        assert.match(lines.join("\n"), /2\/3/);
        assert.match(lines.join("\n"), /Azure/);
        assert.match(lines.join("\n"), /OpenAI/);
        assert.doesNotMatch(lines.join("\n"), /Unrelated/);
      }
      component.handleInput("DOWN");
      component.handleInput("OK");
      return result;
    },
  } } as any, "Metadata", [
    { value: "unrelated", label: "Unrelated", searchText: "not-the-query" },
    { value: "azure", label: "Azure · gpt-6-astra", searchText: "gpt-6-astra" },
    { value: "openai", label: "OpenAI · gpt-6-astra", searchText: "gpt-6-astra" },
  ], { initialQuery: "gpt-6-astra", searchTextOnly: true });
  assert.equal(selected, "openai");
});

test("centers the selected item inside a bounded visible window", () => {
  assert.deepEqual(getVisibleRange(25, 0, 10), { startIndex: 0, endIndex: 10 });
  assert.deepEqual(getVisibleRange(25, 12, 10), { startIndex: 7, endIndex: 17 });
  assert.deepEqual(getVisibleRange(25, 24, 10), { startIndex: 15, endIndex: 25 });
  assert.deepEqual(getVisibleRange(4, 3, 10), { startIndex: 0, endIndex: 4 });
  assert.deepEqual(getVisibleRange(0, 0, 10), { startIndex: 0, endIndex: 0 });
});

test("renders current option and search match counts without exceeding width", () => {
  const line = renderSearchableOptionLine(
    {
      value: "openai/gpt-5-mini",
      label: "Model openai/gpt-5-mini",
      description: "GPT-5 Mini ← 当前",
    },
    {
      isSelected: true,
      width: 36,
      color: (text) => text,
    },
  );

  assert.match(line, /^→ /);
  assert.match(line, /openai\/gpt-5-mini/);
  assert.ok(visibleWidth(line) <= 36);
});
