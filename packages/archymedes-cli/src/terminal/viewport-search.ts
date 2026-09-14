import { maxTop, type ViewportState } from "./viewport";

export type ViewportSearch = { query: string; matches: readonly number[]; index: number };

const STYLE_PATTERN = /\x1b\[[0-9;]*m/g;

/** Puts the current match on screen, a third of the way down, so its context comes with it. */
function reveal(viewport: ViewportState, search: ViewportSearch): ViewportState {
  if (search.matches.length === 0) return viewport;
  const line = search.matches[search.index];
  const top = Math.max(0, Math.min(line - Math.floor(viewport.height / 3), maxTop(viewport)));
  return { ...viewport, top };
}

/**
 * Finds every row containing `query` and moves to the first match at or after the view.
 * Case-insensitive and literal: someone searching a transcript for `call(` is not writing a regex.
 * An empty query clears the search.
 */
export function searchViewport(viewport: ViewportState, query: string): { viewport: ViewportState; search: ViewportSearch | null } {
  const trimmed = query.trim();
  if (!trimmed) return { viewport, search: null };
  const needle = trimmed.toLowerCase();
  const matches: number[] = [];
  viewport.lines.forEach((line, index) => {
    if (line.replace(STYLE_PATTERN, "").toLowerCase().includes(needle)) matches.push(index);
  });
  const from = matches.findIndex((line) => line >= viewport.top);
  const search = { query: trimmed, matches, index: from === -1 ? 0 : from };
  return { viewport: reveal(viewport, search), search };
}

/** Next or previous match, wrapping around — a search that stops at the end is one you repeat by hand. */
export function stepViewportSearch(viewport: ViewportState, search: ViewportSearch, direction: 1 | -1): { viewport: ViewportState; search: ViewportSearch } {
  if (search.matches.length === 0) return { viewport, search };
  const next = { ...search, index: (search.index + direction + search.matches.length) % search.matches.length };
  return { viewport: reveal(viewport, next), search: next };
}
