/**
 * A built-in pager for `/pager`, for when `less` is not there to hand the transcript to.
 *
 * Windows has no `less` out of the box, and an `ENOENT` is a poor answer to "let me scroll back".
 * This is the small version of it: arrows, pages, ends, a search, and Esc (or q) back to the chat —
 * the same way out every other screen in Archymedes has. Pure state, like `editor.ts`; the screen in
 * `pager-screen.tsx` only paints the rows this composes.
 */

export type PagerState = {
  lines: string[];
  top: number;
  /** Rows available for text, after the title and the key bar. */
  height: number;
  search: { query: string; typing: boolean };
  message?: string;
};

export type PagerAction =
  | { kind: "scroll"; rows: number }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "exit" }
  | { kind: "search" }
  | { kind: "searchType"; character: string }
  | { kind: "searchBackspace" }
  | { kind: "searchCommit" }
  | { kind: "searchCancel" }
  | { kind: "searchNext" }
  | { kind: "none" };

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** Opens on the last screenful: a transcript is read from where it ended. */
export function initialPagerState(text: string, height: number): PagerState {
  const lines = text.replace(ANSI, "").replace(/\r/g, "").split("\n");
  const rows = Math.max(1, height);
  return { lines, top: Math.max(0, lines.length - rows), height: rows, search: { query: "", typing: false } };
}

export function keyToPagerAction(key: { name?: string; ctrl?: boolean }, character: string | undefined, state: PagerState): PagerAction {
  const name = key.name ?? "";
  if (key.ctrl && name === "c") return { kind: "exit" };
  if (state.search.typing) {
    if (name === "escape") return { kind: "searchCancel" };
    if (name === "return" || name === "enter") return { kind: "searchCommit" };
    if (name === "backspace") return { kind: "searchBackspace" };
    if (character && character.length === 1 && character >= " ") return { kind: "searchType", character };
    return { kind: "none" };
  }
  if (name === "escape" || character === "q") return { kind: "exit" };
  if (name === "up" || character === "k") return { kind: "scroll", rows: -1 };
  if (name === "down" || character === "j" || name === "return" || name === "enter") return { kind: "scroll", rows: 1 };
  if (name === "pageup" || character === "b") return { kind: "scroll", rows: -(state.height - 1) };
  if (name === "pagedown" || name === "space" || character === " ") return { kind: "scroll", rows: state.height - 1 };
  if (name === "home" || character === "g") return { kind: "home" };
  if (name === "end" || character === "G") return { kind: "end" };
  if (character === "/") return { kind: "search" };
  if (character === "n") return { kind: "searchNext" };
  return { kind: "none" };
}

function clampTop(state: PagerState, top: number): number {
  return Math.max(0, Math.min(top, Math.max(0, state.lines.length - state.height)));
}

function findFrom(state: PagerState, from: number): number {
  const needle = state.search.query.toLowerCase();
  if (!needle) return -1;
  for (let offset = 0; offset < state.lines.length; offset += 1) {
    const row = (from + offset) % state.lines.length;
    if (state.lines[row].toLowerCase().includes(needle)) return row;
  }
  return -1;
}

export function applyPagerAction(state: PagerState, action: PagerAction): { state: PagerState; exit?: boolean } {
  switch (action.kind) {
    case "exit": return { state, exit: true };
    case "scroll": return { state: { ...state, top: clampTop(state, state.top + action.rows), message: undefined } };
    case "home": return { state: { ...state, top: 0, message: undefined } };
    case "end": return { state: { ...state, top: clampTop(state, state.lines.length), message: undefined } };
    case "search": return { state: { ...state, search: { query: "", typing: true }, message: undefined } };
    case "searchType": return { state: { ...state, search: { ...state.search, query: state.search.query + action.character } } };
    case "searchBackspace": return { state: { ...state, search: { ...state.search, query: state.search.query.slice(0, -1) } } };
    case "searchCancel": return { state: { ...state, search: { query: "", typing: false } } };
    case "searchCommit":
    case "searchNext": {
      const settled = { ...state, search: { ...state.search, typing: false } };
      const row = findFrom(settled, action.kind === "searchCommit" ? state.top : state.top + 1);
      if (row < 0) return { state: { ...settled, message: state.search.query ? `no match for "${state.search.query}"` : undefined } };
      return { state: { ...settled, top: clampTop(settled, row), message: undefined } };
    }
    default: return { state };
  }
}

export type PagerRow = { text: string; bold?: boolean; dim?: boolean };

/** Title, the visible lines, and the key bar — clipped to the width, never wrapped. */
export function composePagerFrame(state: PagerState, columns: number, title = "transcript"): PagerRow[] {
  const clip = (text: string) => (text.length <= columns ? text : text.slice(0, Math.max(0, columns - 1)));
  const last = Math.min(state.lines.length, state.top + state.height);
  const position = `${state.lines.length === 0 ? 0 : state.top + 1}-${last} of ${state.lines.length}`;
  const body = state.lines.slice(state.top, state.top + state.height).map((text) => ({ text: clip(text) }));
  while (body.length < state.height) body.push({ text: "" });
  const bar = state.search.typing
    ? `/${state.search.query}   Enter find · Esc cancel`
    : state.message ?? "↑↓ scroll · PgUp/PgDn page · g/G ends · / find · Esc back";
  return [
    { text: clip(`${title}   ${position}`), bold: true },
    ...body,
    { text: clip(bar), dim: true },
  ];
}
