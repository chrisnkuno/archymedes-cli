import { UNICODE_GLYPHS, type GlyphSet } from "../text/glyphs";
import { RESET } from "../text/ansi";
import { visibleWidth } from "../text/text-width";
import { padToWidth, sliceToWidth, type Align } from "../render/tui";

/**
 * A cell clipped and padded to exactly `width` columns, with the colour codes in it left intact.
 *
 * A cell too wide to fit is truncated with the terminal's own ellipsis glyph rather than simply cut,
 * so a clipped value is visibly clipped and not silently a different value.
 *
 * The walk itself now lives in `sliceToWidth`, which was fixed to copy escape sequences through
 * free — the bug was never this table's alone, since `tui.ts`'s own `table()` documents pre-painted
 * cells and clipped them through the same broken measure. What stays here is the part specific to a
 * cell: the ellipsis, the alignment, and closing a colour the cut left open.
 */
export function fitCell(text: string, width: number, align: Align = "left", glyphs: GlyphSet = UNICODE_GLYPHS): string {
  if (width <= 0) return "";
  const size = visibleWidth(text);
  if (size <= width) return padToWidth(text, width, align);

  const cut = sliceToWidth(text, Math.max(0, width - visibleWidth(glyphs.ellipsis)));
  // A cut that lands inside a painted run drops that run's terminator and bleeds the colour down the
  // rest of the page, so the ellipsis is preceded by a reset whenever a sequence was left open.
  const opened = cut.match(/\x1b\[[0-9;]*m/g)?.at(-1);
  const closed = opened === undefined || opened === RESET;
  return padToWidth(`${cut}${closed ? "" : RESET}${glyphs.ellipsis}`, width, align);
}
