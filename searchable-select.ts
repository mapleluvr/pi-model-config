import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";

export interface SearchableSelectOption {
  value: string;
  label?: string;
  description?: string;
  searchText?: string;
}

export interface SearchableSelectConfig {
  maxVisible?: number;
  hint?: string;
  emptyMessage?: string;
  initialValue?: string;
}

interface RenderSearchableOptionLineOptions {
  isSelected: boolean;
  width: number;
  color?: (text: string) => string;
  muted?: (text: string) => string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function getSearchableText(option: SearchableSelectOption): string {
  return [option.value, option.label, option.description, option.searchText]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

export function filterSearchableOptions(
  options: SearchableSelectOption[],
  query: string,
): SearchableSelectOption[] {
  const trimmed = query.trim();
  if (!trimmed) return options;
  return fuzzyFilter(options, trimmed, getSearchableText);
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

export function renderSearchableOptionLine(
  option: SearchableSelectOption,
  opts: RenderSearchableOptionLineOptions,
): string {
  const color = opts.color ?? ((text: string) => text);
  const muted = opts.muted ?? ((text: string) => text);
  const prefix = opts.isSelected ? color("→ ") : "  ";
  const label = option.label || option.value;
  const labelText = opts.isSelected ? color(label) : label;
  const description = option.description ? muted(`  ${option.description}`) : "";
  return truncateToWidth(`${prefix}${labelText}${description}`, Math.max(1, opts.width), "");
}

class SearchableSelectComponent implements Component, Focusable {
  private readonly searchInput = new Input();
  private readonly options: SearchableSelectOption[];
  private filteredOptions: SearchableSelectOption[];
  private selectedIndex = 0;
  private readonly maxVisible: number;
  private readonly title: string;
  private readonly hint: string;
  private readonly emptyMessage: string;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (result: string | undefined) => void;
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
    options: SearchableSelectOption[],
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: string | undefined) => void,
    config: SearchableSelectConfig = {},
  ) {
    this.title = title;
    this.options = options;
    this.filteredOptions = options;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.maxVisible = config.maxVisible ?? 10;
    this.hint = config.hint ?? "输入关键字过滤，↑/↓ 选择，Enter 确认，Esc 返回";
    this.emptyMessage = config.emptyMessage ?? "无匹配选项";

    const initialIndex = config.initialValue
      ? this.options.findIndex((option) => option.value === config.initialValue)
      : -1;
    this.selectedIndex = initialIndex >= 0 ? initialIndex : 0;
    this.searchInput.onSubmit = () => this.selectCurrent();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const query = this.searchInput.getValue();
    const { startIndex, endIndex } = getVisibleRange(
      this.filteredOptions.length,
      this.selectedIndex,
      this.maxVisible,
    );
    const lines: string[] = [];
    const border = this.theme.fg("borderMuted", "─".repeat(safeWidth));

    lines.push(border);
    lines.push(this.line(this.theme.fg("accent", this.title), safeWidth));
    lines.push(this.line(this.theme.fg("muted", this.hint), safeWidth));
    lines.push(this.line(
      this.theme.fg("muted", `🔍 搜索 (${this.filteredOptions.length}/${this.options.length})${query ? `: ${query}` : ""}`),
      safeWidth,
    ));
    lines.push(...this.searchInput.render(safeWidth));

    if (this.filteredOptions.length === 0) {
      lines.push(this.line(this.theme.fg("muted", `  ${this.emptyMessage}`), safeWidth));
    } else {
      for (let index = startIndex; index < endIndex; index++) {
        const option = this.filteredOptions[index];
        if (!option) continue;
        lines.push(renderSearchableOptionLine(option, {
          isSelected: index === this.selectedIndex,
          width: safeWidth,
          color: (text) => this.theme.fg("accent", text),
          muted: (text) => this.theme.fg("muted", text),
        }));
      }

      if (startIndex > 0 || endIndex < this.filteredOptions.length) {
        lines.push(this.line(
          this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredOptions.length})`),
          safeWidth,
        ));
      }
    }

    lines.push(border);
    return lines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
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
    this.filteredOptions = filterSearchableOptions(this.options, this.searchInput.getValue());
    if (this.filteredOptions.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = clamp(this.selectedIndex, 0, this.filteredOptions.length - 1);
  }

  private moveSelection(delta: number): void {
    if (this.filteredOptions.length === 0) return;
    const next = this.selectedIndex + delta;
    if (next < 0) {
      this.selectedIndex = this.filteredOptions.length - 1;
      return;
    }
    if (next >= this.filteredOptions.length) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = next;
  }

  private selectCurrent(): void {
    const option = this.filteredOptions[this.selectedIndex];
    if (option) this.done(option.value);
  }
}

export async function searchableSelect(
  ctx: ExtensionCommandContext,
  title: string,
  options: SearchableSelectOption[],
  config: SearchableSelectConfig = {},
): Promise<string | undefined> {
  if (options.length === 0) return undefined;

  return await ctx.ui.custom<string | undefined>((_tui, theme, keybindings, done) => {
    return new SearchableSelectComponent(title, options, theme, keybindings, done, config);
  });
}
