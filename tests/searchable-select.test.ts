import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  filterSearchableOptions,
  getVisibleRange,
  renderSearchableOptionLine,
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

test("keeps an empty query in original option order", () => {
  assert.deepEqual(
    filterSearchableOptions(modelOptions, "   ").map((item) => item.value),
    modelOptions.map((item) => item.value),
  );
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
