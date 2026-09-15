import { GUTTER, heading, note, rule, type SectionStyle } from "../render/sections";
import type { GlyphSet } from "../text/glyphs";
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
    case "show":
      write(`${GUTTER}${paint.cyan(context.active.name)}${context.active.description ? paint.dim(` — ${context.active.description}`) : ""}\n`);
      write(swatch(paint));
      return;
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
