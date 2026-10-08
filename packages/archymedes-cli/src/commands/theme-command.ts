import { GUTTER, heading, note, rule, type SectionStyle } from "../render/sections";
import type { GlyphSet } from "../text/glyphs";
import { clipTo } from "../text/text-width";
import type { ChooserItem } from "../ui/chooser";
import type { DiscoveredTheme } from "../theme/theme-files";
import type { Theme, ThemeCommand } from "../theme/theme";

type Paint = (text: string) => string;

export type ThemeCommandContext = {
  discover(): Promise<DiscoveredTheme[]>;
  find(name: string): Promise<Theme | undefined>;
  directory(scope: "project" | "user"): string;
  active: { name: string; description?: string };
  /** Switches the session to a theme; the next line printed uses it. */
  apply(theme: Theme): void;
  write(text: string): void;
  /** Read after `apply`, so the swatch is painted in the new theme. */
  paint(): { dim: Paint; yellow: Paint; cyan: Paint; green: Paint; red: Paint; accent: Paint };
  style(): SectionStyle;
  glyphs: GlyphSet;
  /** Columns available to a printed line; a theme's description is clipped to it rather than wrapped mid-word. */
  width?: number;
  /**
   * A list to pick from, when there is a keyboard to pick with. Bare `/theme` then opens the themes
   * the way bare `/model` opens the models; without one it prints the current theme as it always did.
   */
  choose?(items: ChooserItem<string>[], initialIndex: number): Promise<string | undefined>;
};

/** The roles side by side: names mean nothing until they are seen in the terminal drawing them. */
function swatch(paint: ReturnType<ThemeCommandContext["paint"]>): string {
  return `${GUTTER}${paint.cyan("primary")}  ${paint.accent("accent")}  ${paint.green("success")}  ${paint.yellow("warning")}  ${paint.red("error")}  ${paint.dim("muted")}\n`;
}

/** `/theme [list | where | <name>]`. */
export async function runThemeCommand(command: ThemeCommand, context: ThemeCommandContext): Promise<void> {
  const { write, glyphs } = context;
  const paint = context.paint();
  const style = context.style();
  switch (command.kind) {
    case "invalid":
      write(paint.yellow(`  ${command.reason}\n`));
      return;
    case "where":
      write(`${heading("themes", 2, style)}\n`);
      for (const scope of ["project", "user"] as const) write(`${note(`${scope}: ${context.directory(scope)}`, style)}\n`);
      write(`${note("drop a .tss file in either — the same format TermUI themes use", style)}\n`);
      return;
    case "list":
      write(`${heading("themes", 2, style)}\n`);
      for (const theme of await context.discover()) {
        const marker = theme.name === context.active.name ? glyphs.circleFull : " ";
        const origin = theme.source === "builtin" ? "" : ` (${theme.source})`;
        write(`${GUTTER}${marker} ${paint.cyan(theme.name)}${paint.dim(origin)}${theme.description ? paint.dim(` — ${theme.description}`) : ""}\n`);
      }
      write(`${note("/theme <name> to change it", style)}\n`);
      return;
    case "show": {
      if (context.choose) {
        const themes = await context.discover();
        const items = themes.map((theme) => ({
          value: theme.name,
          label: theme.name,
          ...(theme.description ? { description: theme.description } : {}),
          ...(theme.name === context.active.name ? { hint: "current" } : theme.source === "builtin" ? {} : { hint: theme.source }),
        }));
        const picked = await context.choose(items, Math.max(0, themes.findIndex((theme) => theme.name === context.active.name)));
        if (picked === undefined || picked === context.active.name) {
          write(paint.dim(`  theme unchanged: ${context.active.name}\n`));
          return;
        }
        await runThemeCommand({ kind: "set", name: picked }, context);
        return;
      }
      const line = `${context.active.name}${context.active.description ? ` — ${context.active.description}` : ""}`;
      const clipped = context.width ? clipTo(line, Math.max(10, context.width - GUTTER.length), glyphs) : line;
      write(`${GUTTER}${paint.cyan(clipped.slice(0, context.active.name.length))}${paint.dim(clipped.slice(context.active.name.length))}\n`);
      write(swatch(paint));
      return;
    }
    case "set": {
      const chosen = await context.find(command.name);
      if (!chosen) { write(paint.yellow(`  No theme named "${command.name}". /theme list shows what there is.\n`)); return; }
      context.apply(chosen);
      write(`${rule(context.style(), { label: chosen.name, tone: "accent" })}\n`);
      write(swatch(context.paint()));
      return;
    }
  }
}
