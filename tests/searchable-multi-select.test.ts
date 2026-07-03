import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  clearSelection,
  filterSearchableMultiSelectOptions,
  getVisibleRange,
  renderSearchableMultiSelectOptionLine,
  selectAllValues,
  toggleSelection,
  type SearchableMultiSelectOption,
} from "../searchable-multi-select.ts";

const OPTIONS: SearchableMultiSelectOption[] = [
  { value: "read", label: "read", description: "Read files" },
  { value: "bash", label: "bash", description: "Execute shell commands" },
  { value: "subagent", label: "subagent", description: "Run subagents", warning: "Allows nested subagent fanout" },
];

test("toggles selected values while preserving existing order", () => {
  assert.deepEqual(toggleSelection(["read"], "bash"), ["read", "bash"]);
  assert.deepEqual(toggleSelection(["read", "bash"], "read"), ["bash"]);
});

test("selects all option values and clears selected values", () => {
  assert.deepEqual(selectAllValues(OPTIONS), ["read", "bash", "subagent"]);
  assert.deepEqual(clearSelection(), []);
});

test("filters multi-select options using fuzzy token search", () => {
  const filtered = filterSearchableMultiSelectOptions(OPTIONS, "shell bash");
  assert.deepEqual(filtered.map((option) => option.value), ["bash"]);
});

test("centers selected item inside a bounded visible window", () => {
  assert.deepEqual(getVisibleRange(30, 20, 8), { startIndex: 16, endIndex: 24 });
  assert.deepEqual(getVisibleRange(3, 2, 8), { startIndex: 0, endIndex: 3 });
});

test("renders selected and warned options without exceeding width", () => {
  const line = renderSearchableMultiSelectOptionLine(OPTIONS[2]!, {
    isCursor: true,
    isSelected: true,
    width: 36,
  });

  assert.match(line, /^> \[x\] subagent/);
  assert.ok(line.includes("Allows nested"));
  assert.ok(visibleWidth(line) <= 36);
});
