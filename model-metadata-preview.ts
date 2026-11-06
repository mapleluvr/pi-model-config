import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** Keep the complete diff readable even when nested values exceed the terminal height. */
export async function confirmModelMetadata(ctx: ExtensionCommandContext, description: string): Promise<boolean> {
  return ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
    const text = new Text(description, 0, 0);
    const scroll = new ScrollView(text);
    let lineCount = 0;
    return {
      render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const lines = scroll.render(safeWidth);
        lineCount = lines.length;
        const height = Math.min(lineCount, Math.max(1, Math.min(12, tui.terminal.rows - 6)));
        scroll.updateLayout(lineCount, height, () => tui.requestRender());
        return [
          theme.fg("accent", "覆盖当前模型元数据"),
          ...lines.slice(scroll.scrollTop, scroll.scrollTop + height),
          theme.fg("muted", `↑/↓ 滚动 · PgUp/PgDn 翻页 (${scroll.scrollTop + 1}-${scroll.scrollTop + height}/${lineCount})`),
          theme.fg("accent", "Enter 应用覆盖 · Esc 取消"),
        ].map(line => truncateToWidth(line, safeWidth, ""));
      },
      handleInput(data: string): void {
        if (keybindings.matches(data, "tui.select.cancel")) {
          done(false);
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          done(true);
        } else if (keybindings.matches(data, "tui.select.up")) {
          scroll.scrollBy(-1);
        } else if (keybindings.matches(data, "tui.select.down")) {
          scroll.scrollBy(1);
        } else if (matchesKey(data, Key.pageUp)) {
          scroll.scrollBy(-Math.max(1, scroll.viewportHeight));
        } else if (matchesKey(data, Key.pageDown)) {
          scroll.scrollBy(Math.max(1, scroll.viewportHeight));
        }
      },
      invalidate(): void {
        text.invalidate();
      },
    };
  });
}
