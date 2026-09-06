import { BOLD, paint } from "./ansi";
import { clipTo } from "./chooser";
import { ASCII_GLYPHS, type GlyphSet, UNICODE_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";
import type { Palette } from "./theme";

export type IdentityOptions = {
  width: number;
  rows: number;
  version: string;
  workspace: string;
  model: string;
  mode: string;
  palette: Palette;
  glyphs?: GlyphSet;
};

// A graduated ring sighted on its centre — an astrolabe read as a mark. Every row is the same
// width and the figure is symmetric on both axes, so it lands square in any terminal font.
const INSTRUMENT = ["    ╭───╮    ", "  ╭─┴───┴─╮  ", "  │       │  ", "  ├── ● ──┤  ", "  ╰─┬───┬─╯  ", "    ╰───╯    "];
const ASCII_INSTRUMENT = ["    .---.    ", "  .-+---+-.  ", "  |       |  ", "  +-- O --+  ", "  '-+---+-'  ", "    '---'    "];

/** Static, theme-aware identity. Metadata stays readable without delaying the prompt. */
export function renderIdentity(options: IdentityOptions): string {
  const { palette } = options;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(1, Math.floor(options.width));
  const ascii = glyphs.boxHorizontal === ASCII_GLYPHS.boxHorizontal;
  const mark = ascii ? "::" : "∴";
  const text = [
    `ARCHYMEDES  ${options.version}`,
    "A place to think. The tools to build.",
    "",
    `${options.mode} ${glyphs.middot} ${options.workspace}`,
    options.model,
    `/help ${glyphs.middot} /guide ${glyphs.middot} /workspace`,
  ];
  const codes = [palette.primary + BOLD, palette.text, "", palette.secondary, palette.muted, palette.primary];
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  if (width < 64 || options.rows < 20) {
    const lines = [`${mark} ${text[0]}`, text[3], text[4]];
    return lines.map((line, index) => paint(clipTo(clean(line), width, glyphs), index === 0 ? codes[0] : palette.muted, palette.depth)).join("\n");
  }
  const instrument = ascii ? ASCII_INSTRUMENT : INSTRUMENT;
  const artWidth = Math.max(...instrument.map(visibleWidth));
  const gap = 3;
  const margin = 2;
  return instrument.map((line, index) => {
    const drawing = line + " ".repeat(artWidth - visibleWidth(line));
    return " ".repeat(margin) + paint(drawing, palette.primary, palette.depth)
      + " ".repeat(gap) + paint(clipTo(clean(text[index]), width - margin - artWidth - gap, glyphs), codes[index], palette.depth);
  }).join("\n");
}
