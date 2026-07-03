import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";

export interface SearchableMultiSelectOption {
  value: string;
  label?: string;
  description?: string;
  searchText?: string;
  warning?: string;
}

export interface SearchableMultiSelectConfig {
  maxVisible?: number;
  hint?: string;
  emptyMessage?: string;
}

interface RenderSearchableMultiSelectOptionLineOptions {
  isCursor: boolean;
  isSelected: boolean;
  width: number;
  color?: (text: string) => string;
  muted?: (text: string) => string;
  warningColor?: (text: string) => string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function getSearchableText(option: SearchableMultiSelectOption): string {
  return [option.value, option.label, option.description, option.searchText, option.warning]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

export function filterSearchableMultiSelectOptions(
  options: SearchableMultiSelectOption[],
  query: string,
): SearchableMultiSelectOption[] {
  const trimmed = query.trim();
  if (!trimmed) return options;
  return fuzzyFilter(options, trimmed, getSearchableText);
}

export function toggleSelection(selectedValues: string[], value: string): string[] {
  if (selectedValues.includes(value)) {
    return selectedValues.filter((selected) => selected !== value);
  }
  return [...selectedValues, value];
}

export function selectAllValues(options: SearchableMultiSelectOption[]): string[] {
  return uniqueInOrder(options.map((option) => option.value));
}

export function clearSelection(): string[] {
  return [];
}

export function getVisibleRange(
  totalItems: number,
  selectedIndex: number,
  maxVisible: number,
): { startIndex: number; endIndex: number } {
  if (totalItems <= 0 || maxVisible <= 0) return { startIndex: 0, endIndex: 0 };

  const visibleCount = Math.min(totalItems, Math.max(1, maxVisible));
  const selected = clamp(selectedIndex, 0, totalItems - 1);
  const startIndex = Math.max(
    0,
    Math.min(selected - Math.floor(visibleCount / 2), totalItems - visibleCount),
  );
  return { startIndex, endIndex: Math.min(startIndex + visibleCount, totalItems) };
}

export function renderSearchableMultiSelectOptionLine(
  option: SearchableMultiSelectOption,
  opts: RenderSearchableMultiSelectOptionLineOptions,
): string {
  const color = opts.color ?? ((text: string) => text);
  const muted = opts.muted ?? ((text: string) => text);
  const warningColor = opts.warningColor ?? ((text: string) => text);
  const cursor = opts.isCursor ? color("> ") : "  ";
  const checkbox = opts.isSelected ? "[x] " : "[ ] ";
  const label = option.label || option.value;
  const labelText = opts.isCursor ? color(label) : label;
  const warning = option.warning ? warningColor(`  ${option.warning}`) : "";
  const description = option.description ? muted(`  ${option.description}`) : "";
  return truncateToWidth(`${cursor}${checkbox}${labelText}${warning}${description}`, Math.max(1, opts.width), "");
}

class SearchableMultiSelectComponent implements Component, Focusable {
  private readonly searchInput = new Input();
  private readonly options: SearchableMultiSelectOption[];
  private filteredOptions: SearchableMultiSelectOption[];
  private selectedValues: string[];
  private cursorIndex = 0;
  private readonly maxVisible: number;
  private readonly title: string;
  private readonly hint: string;
  private readonly emptyMessage: string;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (result: string[] | undefined) => void;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    title: string,
    options: SearchableMultiSelectOption[],
    initialValues: string[],
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: string[] | undefined) => void,
    config: SearchableMultiSelectConfig = {},
  ) {
    this.title = title;
    this.options = options;
    this.filteredOptions = options;
    this.selectedValues = uniqueInOrder(initialValues);
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.maxVisible = config.maxVisible ?? 10;
    this.hint = config.hint ?? "输入关键字过滤，空格切换，Enter 保存，Esc 取消";
    this.emptyMessage = config.emptyMessage ?? "无匹配选项";
    this.searchInput.onSubmit = () => this.done(this.selectedValues);
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const query = this.searchInput.getValue();
    const { startIndex, endIndex } = getVisibleRange(
      this.filteredOptions.length,
      this.cursorIndex,
      this.maxVisible,
    );
    const lines: string[] = [];
    const border = this.theme.fg("borderMuted", "─".repeat(safeWidth));
    const selectedSet = new Set(this.selectedValues);

    lines.push(border);
    lines.push(this.line(this.theme.fg("accent", this.title), safeWidth));
    lines.push(this.line(this.theme.fg("muted", this.hint), safeWidth));
    lines.push(this.line(
      this.theme.fg("muted", `搜索 (${this.filteredOptions.length}/${this.options.length}) selected=${this.selectedValues.length}${query ? `: ${query}` : ""}`),
      safeWidth,
    ));
    lines.push(...this.searchInput.render(safeWidth));

    if (this.filteredOptions.length === 0) {
      lines.push(this.line(this.theme.fg("muted", `  ${this.emptyMessage}`), safeWidth));
    } else {
      for (let index = startIndex; index < endIndex; index++) {
        const option = this.filteredOptions[index];
        if (!option) continue;
        lines.push(renderSearchableMultiSelectOptionLine(option, {
          isCursor: index === this.cursorIndex,
          isSelected: selectedSet.has(option.value),
          width: safeWidth,
          color: (text) => this.theme.fg("accent", text),
          muted: (text) => this.theme.fg("muted", text),
          warningColor: (text) => this.theme.fg("warning", text),
        }));
      }

      if (startIndex > 0 || endIndex < this.filteredOptions.length) {
        lines.push(this.line(
          this.theme.fg("muted", `  (${this.cursorIndex + 1}/${this.filteredOptions.length})`),
          safeWidth,
        ));
      }
    }

    lines.push(border);
    return lines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveCursor(-1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveCursor(1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.done(this.selectedValues);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }

    if (data === " ") {
      this.toggleCurrent();
      return;
    }

    if (data === "a") {
      this.selectedValues = selectAllValues(this.options);
      return;
    }

    if (data === "n") {
      this.selectedValues = clearSelection();
      return;
    }

    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== previousQuery) {
      this.applyFilter();
    }
  }

  private line(text: string, width: number): string {
    return truncateToWidth(text, width, "");
  }

  private applyFilter(): void {
    this.filteredOptions = filterSearchableMultiSelectOptions(this.options, this.searchInput.getValue());
    if (this.filteredOptions.length === 0) {
      this.cursorIndex = 0;
      return;
    }
    this.cursorIndex = clamp(this.cursorIndex, 0, this.filteredOptions.length - 1);
  }

  private moveCursor(delta: number): void {
    if (this.filteredOptions.length === 0) return;
    const next = this.cursorIndex + delta;
    if (next < 0) {
      this.cursorIndex = this.filteredOptions.length - 1;
      return;
    }
    if (next >= this.filteredOptions.length) {
      this.cursorIndex = 0;
      return;
    }
    this.cursorIndex = next;
  }

  private toggleCurrent(): void {
    const option = this.filteredOptions[this.cursorIndex];
    if (!option) return;
    this.selectedValues = toggleSelection(this.selectedValues, option.value);
  }
}

export async function searchableMultiSelect(
  ctx: ExtensionCommandContext,
  title: string,
  options: SearchableMultiSelectOption[],
  initialValues: string[],
  config: SearchableMultiSelectConfig = {},
): Promise<string[] | undefined> {
  return await ctx.ui.custom<string[] | undefined>((_tui, theme, keybindings, done) => {
    return new SearchableMultiSelectComponent(title, options, initialValues, theme, keybindings, done, config);
  });
}
