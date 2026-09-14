import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * How many columns a string actually occupies.
 *
 * Escape codes are zero-width and must not count, or every wrap calculation drifts by the length
 * of its own colouring. CJK and emoji occupy two columns; treating them as one is what makes a
 * box border sit one character short of its own corner.
 */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const character of text.replace(ANSI, "")) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x300 && code <= 0x36f) continue; // combining marks sit on the previous cell
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals through Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
    (code >= 0x1f300 && code <= 0x1f9ff) // Emoji
  );
}

/**
 * Cuts to a visible width without splitting a colour sequence — the rows here are unpainted.
 *
 * Exported because the palette and the model picker are the same menu wearing different clothes,
 * and they each grew their own width arithmetic. Three copies is how two of them end up wrapping
 * on a narrow terminal while the third does not.
 */
export function clipTo(text: string, width: number, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  // Room is reserved for the mark *as the terminal will draw it*. A unicode ellipsis is one column
  // and an ASCII one is three, so reserving a single column — which was right for as long as the
  // mark was hardcoded — overflows every clipped row by two the moment the ASCII set is in use.
  // Two columns is enough to wrap a row, and a wrapped row is a line the frame did not reserve.
  const mark = visibleWidth(glyphs.ellipsis) < width ? glyphs.ellipsis : "";
  const budget = width - visibleWidth(mark);
  let out = "";
  const segments = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((entry) => entry.segment)
    : [...text];
  for (const segment of segments) {
    if (visibleWidth(out + segment) > budget) break;
    out += segment;
  }
  return `${out}${mark}`;
}
