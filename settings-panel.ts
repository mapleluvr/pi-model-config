import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

export type SettingsFieldActionKind = "edit-field" | "open-section" | "run-action";
export type SettingsPanelPane = "categories" | "fields";
export type SettingsPanelNarrowScreen = "categories" | "fields";

export interface SettingsFieldDescriptor {
  id: string;
  label: string;
  displayValue: string;
  warning?: string;
  searchText?: string;
  action: SettingsFieldActionKind;
}

export interface SettingsCategoryDescriptor {
  id: string;
  label: string;
  fields: SettingsFieldDescriptor[];
}

export interface SettingsPanelState {
  categoryId?: string;
  fieldId?: string;
  focusedPane: SettingsPanelPane;
  categoryScrollOffset: number;
  fieldScrollOffset: number;
  narrowScreen: SettingsPanelNarrowScreen;
}

interface SettingsPanelBaseResult {
  state: SettingsPanelState;
}

export type SettingsPanelResult =
  | (SettingsPanelBaseResult & {
      type: SettingsFieldActionKind;
      categoryId: string;
      fieldId: string;
    })
  | (SettingsPanelBaseResult & { type: "search" | "back" });

export interface SettingsPanelModel {
  title: string;
  subtitle?: string;
  categories: SettingsCategoryDescriptor[];
}

export interface TwoPaneSettingsPanelOptions extends SettingsPanelModel {
  initialState?: Partial<SettingsPanelState>;
  theme: Theme;
  keybindings: KeybindingsManager;
  requestRender: () => void;
  done: (result: SettingsPanelResult) => void;
  maxVisibleRows?: number;
}

export interface VisibleSettingsWindow {
  startIndex: number;
  endIndex: number;
  offset: number;
}

const WIDE_MIN_COLUMNS = 88;
const DEFAULT_MAX_VISIBLE_ROWS = 9;

function clampInteger(value: unknown, minimum: number, maximum: number): number {
  const integer = typeof value === "number" && Number.isInteger(value) ? value : minimum;
  return Math.max(minimum, Math.min(integer, maximum));
}

export function getVisibleSettingsWindow(
  totalItems: number,
  selectedIndex: number,
  requestedOffset: number,
  maxVisible: number,
): VisibleSettingsWindow {
  if (totalItems <= 0 || maxVisible <= 0) {
    return { startIndex: 0, endIndex: 0, offset: 0 };
  }
  const count = Math.min(totalItems, Math.max(1, Math.floor(maxVisible)));
  const selected = clampInteger(selectedIndex, 0, totalItems - 1);
  let offset = clampInteger(requestedOffset, 0, Math.max(0, totalItems - count));
  if (selected < offset) offset = selected;
  if (selected >= offset + count) offset = selected - count + 1;
  offset = clampInteger(offset, 0, Math.max(0, totalItems - count));
  return {
    startIndex: offset,
    endIndex: Math.min(totalItems, offset + count),
    offset,
  };
}

export function normalizeSettingsPanelState(
  categories: SettingsCategoryDescriptor[],
  initialState: Partial<SettingsPanelState> = {},
): SettingsPanelState {
  const requestedCategory = initialState.categoryId;
  const category = categories.find((entry) => entry.id === requestedCategory) ?? categories[0];
  const categoryWasRetained = category !== undefined && category.id === requestedCategory;
  const requestedField = initialState.fieldId;
  const field = category?.fields.find((entry) => entry.id === requestedField) ?? category?.fields[0];
  const fieldWasRetained = field !== undefined && field.id === requestedField;
  const categoryMaxOffset = Math.max(0, categories.length - 1);
  const fieldMaxOffset = Math.max(0, (category?.fields.length ?? 0) - 1);

  return {
    categoryId: category?.id,
    fieldId: field?.id,
    focusedPane: initialState.focusedPane === "fields" ? "fields" : "categories",
    categoryScrollOffset: categoryWasRetained
      ? clampInteger(initialState.categoryScrollOffset, 0, categoryMaxOffset)
      : 0,
    fieldScrollOffset: fieldWasRetained
      ? clampInteger(initialState.fieldScrollOffset, 0, fieldMaxOffset)
      : 0,
    narrowScreen: initialState.narrowScreen === "fields" ? "fields" : "categories",
  };
}

function padAnsi(text: string, width: number): string {
  const bounded = truncateToWidth(text, Math.max(0, width), "");
  return `${bounded}${" ".repeat(Math.max(0, width - visibleWidth(bounded)))}`;
}

function formatKeys(keybindings: KeybindingsManager, action: Parameters<KeybindingsManager["getKeys"]>[0]): string {
  return keybindings.getKeys(action).join("/");
}

export class TwoPaneSettingsPanel implements Component {
  private readonly title: string;
  private readonly subtitle?: string;
  private readonly categories: SettingsCategoryDescriptor[];
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly requestRender: () => void;
  private readonly done: (result: SettingsPanelResult) => void;
  private readonly maxVisibleRows: number;
  private state: SettingsPanelState;
  private lastWidth = WIDE_MIN_COLUMNS;

  constructor(options: TwoPaneSettingsPanelOptions) {
    this.title = options.title;
    this.subtitle = options.subtitle;
    this.categories = options.categories;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.requestRender = options.requestRender;
    this.done = options.done;
    this.maxVisibleRows = Math.max(1, Math.floor(options.maxVisibleRows ?? DEFAULT_MAX_VISIBLE_ROWS));
    this.state = normalizeSettingsPanelState(this.categories, options.initialState);
  }

  invalidate(): void {}

  getState(): SettingsPanelState {
    return { ...this.state };
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    this.lastWidth = safeWidth;
    const lines = safeWidth >= WIDE_MIN_COLUMNS
      ? this.renderWide(safeWidth)
      : this.renderNarrow(safeWidth);
    return lines.map((line) => truncateToWidth(line, safeWidth, ""));
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
      this.confirmSelection();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.cancel();
      return;
    }
    if (matchesKey(data, Key.slash)) {
      this.done({ type: "search", state: this.getState() });
      return;
    }
    if (matchesKey(data, Key.tab)) {
      if (this.isWide()) this.setFocusedPane(this.state.focusedPane === "categories" ? "fields" : "categories");
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.moveLeft();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.moveRight();
    }
  }

  private currentCategory(): SettingsCategoryDescriptor | undefined {
    return this.categories.find((entry) => entry.id === this.state.categoryId) ?? this.categories[0];
  }

  private currentField(): SettingsFieldDescriptor | undefined {
    const category = this.currentCategory();
    return category?.fields.find((entry) => entry.id === this.state.fieldId) ?? category?.fields[0];
  }

  private isWide(): boolean {
    return this.lastWidth >= WIDE_MIN_COLUMNS;
  }

  private setState(next: SettingsPanelState): void {
    this.state = next;
    this.requestRender();
  }

  private setFocusedPane(focusedPane: SettingsPanelPane): void {
    if (this.state.focusedPane === focusedPane) return;
    this.setState({ ...this.state, focusedPane });
  }

  private moveSelection(delta: number): void {
    if (this.isWide() ? this.state.focusedPane === "categories" : this.state.narrowScreen === "categories") {
      this.moveCategory(delta);
    } else {
      this.moveField(delta);
    }
  }

  private moveCategory(delta: number): void {
    if (this.categories.length === 0) return;
    const current = Math.max(0, this.categories.findIndex((entry) => entry.id === this.state.categoryId));
    const nextIndex = (current + delta + this.categories.length) % this.categories.length;
    const category = this.categories[nextIndex]!;
    const window = getVisibleSettingsWindow(
      this.categories.length,
      nextIndex,
      this.state.categoryScrollOffset,
      this.maxVisibleRows,
    );
    this.setState({
      ...this.state,
      categoryId: category.id,
      fieldId: category.fields[0]?.id,
      categoryScrollOffset: window.offset,
      fieldScrollOffset: 0,
    });
  }

  private moveField(delta: number): void {
    const category = this.currentCategory();
    if (!category || category.fields.length === 0) return;
    const current = Math.max(0, category.fields.findIndex((entry) => entry.id === this.state.fieldId));
    const nextIndex = (current + delta + category.fields.length) % category.fields.length;
    const window = getVisibleSettingsWindow(
      category.fields.length,
      nextIndex,
      this.state.fieldScrollOffset,
      this.maxVisibleRows,
    );
    this.setState({
      ...this.state,
      fieldId: category.fields[nextIndex]!.id,
      fieldScrollOffset: window.offset,
    });
  }

  private confirmSelection(): void {
    const onCategories = this.isWide()
      ? this.state.focusedPane === "categories"
      : this.state.narrowScreen === "categories";
    if (onCategories) {
      if (this.isWide()) this.setFocusedPane("fields");
      else this.setState({ ...this.state, focusedPane: "fields", narrowScreen: "fields" });
      return;
    }
    const category = this.currentCategory();
    const field = this.currentField();
    if (!category || !field) return;
    this.done({
      type: field.action,
      categoryId: category.id,
      fieldId: field.id,
      state: this.getState(),
    });
  }

  private cancel(): void {
    if (!this.isWide() && this.state.narrowScreen === "fields") {
      this.setState({ ...this.state, focusedPane: "categories", narrowScreen: "categories" });
      return;
    }
    this.done({ type: "back", state: this.getState() });
  }

  private moveLeft(): void {
    if (this.isWide()) {
      this.setFocusedPane("categories");
      return;
    }
    if (this.state.narrowScreen === "fields") {
      this.setState({ ...this.state, focusedPane: "categories", narrowScreen: "categories" });
    }
  }

  private moveRight(): void {
    if (this.isWide()) {
      this.setFocusedPane("fields");
      return;
    }
    if (this.state.narrowScreen === "categories") {
      this.setState({ ...this.state, focusedPane: "fields", narrowScreen: "fields" });
    }
  }

  private renderWide(width: number): string[] {
    const categoryWidth = Math.min(30, Math.max(24, Math.floor(width * 0.3)));
    const fieldWidth = Math.max(1, width - categoryWidth - 3);
    const compose = (left: string, right: string) =>
      `${padAnsi(left, categoryWidth)} | ${truncateToWidth(right, fieldWidth, "")}`;
    const categoryIndex = Math.max(0, this.categories.findIndex((entry) => entry.id === this.state.categoryId));
    const categoryWindow = getVisibleSettingsWindow(
      this.categories.length,
      categoryIndex,
      this.state.categoryScrollOffset,
      this.maxVisibleRows,
    );
    const category = this.currentCategory();
    const fields = category?.fields ?? [];
    const fieldIndex = Math.max(0, fields.findIndex((entry) => entry.id === this.state.fieldId));
    const fieldWindow = getVisibleSettingsWindow(
      fields.length,
      fieldIndex,
      this.state.fieldScrollOffset,
      this.maxVisibleRows,
    );
    const visibleCategories = this.categories.slice(categoryWindow.startIndex, categoryWindow.endIndex);
    const visibleFields = fields.slice(fieldWindow.startIndex, fieldWindow.endIndex);
    const lines: string[] = [
      this.theme.fg("accent", this.title),
      ...(this.subtitle ? [this.theme.fg("muted", this.subtitle)] : []),
      compose(
        this.state.focusedPane === "categories" ? "Categories [FOCUS]" : "Categories",
        this.state.focusedPane === "fields" ? "Fields [FOCUS]" : "Fields",
      ),
    ];
    const rowCount = Math.max(visibleCategories.length, visibleFields.length, 1);
    for (let row = 0; row < rowCount; row += 1) {
      const categoryEntry = visibleCategories[row];
      const fieldEntry = visibleFields[row];
      lines.push(compose(
        categoryEntry ? this.renderCategoryRow(categoryEntry) : "",
        fieldEntry ? this.renderFieldRow(fieldEntry) : "",
      ));
    }
    lines.push(this.theme.fg("muted", this.wideFooter()));
    return lines;
  }

  private renderNarrow(width: number): string[] {
    const category = this.currentCategory();
    const lines: string[] = [];
    if (this.state.narrowScreen === "categories") {
      const selectedIndex = Math.max(0, this.categories.findIndex((entry) => entry.id === this.state.categoryId));
      const window = getVisibleSettingsWindow(
        this.categories.length,
        selectedIndex,
        this.state.categoryScrollOffset,
        this.maxVisibleRows,
      );
      lines.push(this.theme.fg("accent", this.title));
      if (this.subtitle) lines.push(this.theme.fg("muted", this.subtitle));
      lines.push("Categories [FOCUS]");
      for (const entry of this.categories.slice(window.startIndex, window.endIndex)) {
        lines.push(this.renderCategoryRow(entry));
      }
      lines.push(this.theme.fg("muted", this.narrowCategoryFooter()));
      return lines;
    }

    const fields = category?.fields ?? [];
    const selectedIndex = Math.max(0, fields.findIndex((entry) => entry.id === this.state.fieldId));
    const window = getVisibleSettingsWindow(
      fields.length,
      selectedIndex,
      this.state.fieldScrollOffset,
      this.maxVisibleRows,
    );
    lines.push(this.theme.fg("accent", `${this.title} > ${category?.label ?? ""}`));
    if (this.subtitle) lines.push(this.theme.fg("muted", this.subtitle));
    lines.push("Fields [FOCUS]");
    for (const entry of fields.slice(window.startIndex, window.endIndex)) {
      lines.push(this.renderFieldRow(entry));
    }
    lines.push(this.theme.fg("muted", this.narrowFieldFooter()));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private renderCategoryRow(category: SettingsCategoryDescriptor): string {
    const selected = category.id === this.state.categoryId;
    const marker = selected ? (this.state.focusedPane === "categories" ? "> " : "* ") : "  ";
    const value = `${marker}${category.label}`;
    return selected ? this.theme.fg("accent", value) : value;
  }

  private renderFieldRow(field: SettingsFieldDescriptor): string {
    const selected = field.id === this.state.fieldId;
    const marker = selected ? (this.state.focusedPane === "fields" ? "> " : "* ") : "  ";
    const warning = selected && field.warning ? this.theme.fg("warning", `  ! ${field.warning}`) : "";
    const value = `${marker}${field.label}  ${field.displayValue}${warning}`;
    return selected ? this.theme.fg("accent", value) : value;
  }

  private configuredMovement(): string {
    const up = formatKeys(this.keybindings, "tui.select.up");
    const down = formatKeys(this.keybindings, "tui.select.down");
    return `${up}/${down}`;
  }

  private wideFooter(): string {
    return `Tab/Left/Right switch pane  ${this.configuredMovement()} move  ${formatKeys(this.keybindings, "tui.select.confirm")} activate  / search  ${formatKeys(this.keybindings, "tui.select.cancel")} back`;
  }

  private narrowCategoryFooter(): string {
    return `${this.configuredMovement()} move  ${formatKeys(this.keybindings, "tui.select.confirm")} open  / search  ${formatKeys(this.keybindings, "tui.select.cancel")} back`;
  }

  private narrowFieldFooter(): string {
    return `${this.configuredMovement()} move  ${formatKeys(this.keybindings, "tui.select.confirm")} activate  Left/${formatKeys(this.keybindings, "tui.select.cancel")} categories  / search`;
  }
}

export async function openSettingsPanel(
  ctx: ExtensionCommandContext,
  model: SettingsPanelModel,
  state?: Partial<SettingsPanelState>,
): Promise<SettingsPanelResult> {
  return await ctx.ui.custom<SettingsPanelResult>((tui, theme, keybindings, done) =>
    new TwoPaneSettingsPanel({
      ...model,
      initialState: state,
      theme,
      keybindings,
      requestRender: () => tui.requestRender(),
      done,
    }), { overlay: false });
}
