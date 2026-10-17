import type { ColorDepth } from "./color-depth";

/**
 * The escape codes for weight and emphasis, and the one function that decides whether to emit them.
 * Colours are not here: they come from the theme palette (`theme/theme.ts`), so `/theme` reaches them.
 *
 * `tui.ts` and `markdown.ts` each grew their own private copy of this constant block and their own
 * `paint`, which is how a renderer ends up honouring `NO_COLOR` in one file and not in the next.
 * New rendering modules take these instead.
 */

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const ITALIC = "\x1b[3m";
export const STRIKE = "\x1b[9m";
export const REVERSE = "\x1b[7m";

/** Paints `text` unless the destination cannot show colour, in which case the code is dropped. */
export function paint(text: string, code: string, depth: ColorDepth): string {
  return depth === "none" || code === "" ? text : `${code}${text}${RESET}`;
}

/** Two codes at once — `bold cyan` and friends, without nesting two resets inside each other. */
export function paintAll(text: string, codes: readonly string[], depth: ColorDepth): string {
  return depth === "none" || codes.length === 0 ? text : `${codes.join("")}${text}${RESET}`;
}
