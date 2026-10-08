import { UNICODE_GLYPHS, type GlyphSet } from "../text/glyphs";
import { filterItems, terminalColumns, windowStart, type ChooserItem } from "./chooser";
import { clipTo, visibleWidth } from "../text/text-width";
import type { KeypressEvent } from "../terminal/keybindings";
import type { ModelCatalog, ModelChoice } from "../session/models";
import type { ProviderId } from "@archymedes/core/providers/agent-matrix";
import { SpringAnimator } from "../render/tui";

/**
 * Choosing a model by moving to it, rather than by naming it.
 *
 * `/model` could already list and switch, but both halves asked the user to carry something: the
 * numbered list asked them to read a number and then type it somewhere else, and the typed form
 * asked them to know the id. Neither is hard; both are a step between deciding and doing that a
 * cursor and Return remove entirely.
 *
 * The other thing a menu can do that a printed list cannot is *lead somewhere*. A provider with no
 * key is the most common reason the list is short, and printing "set OPENAI_API_KEY" leaves the
 * person holding a task. Here that line is a row you can select, and selecting it opens settings —
 * the dead end becomes the fix.
 *
 * Typing narrows the list — model ids are unguessable from memory, so the picker filters as you
 * type and ranks a leading match above a mere containing one, the same rule the command palette
 * already follows.
 */

export type PickerRow =
  | { kind: "model"; choice: ModelChoice; header?: string }
  /** Selecting this leaves the picker and opens the settings menu. */
  | { kind: "settings"; label: string; header?: string };

export type PickerResult =
  | { kind: "model"; choice: ModelChoice }
  | { kind: "settings" }
  /**
   * Show the same models as a table instead — a view, not a choice.
   *
   * Returned rather than handled here because the table already exists, fully driven, in `table.ts`.
   * A second navigation implementation inside this file would be the same keys written twice, and the
   * copy that drifts is always the one nobody is looking at. `/models` runs the two surfaces in turn
   * and lets each one say when the other should take over.
   */
  | { kind: "table" };

export type PickerState = { selected: number; query: string };

/**
 * The rows matching a typed query, best first.
 *
 * Ranked by the chooser's own rule — an id that *starts* with the query outranks one
 * that merely contains it — over the model id with the provider label as the secondary
 * text, so `anthropic` finds the Claude rows and `openai` finds both the models and the
 * row that adds the missing key. An empty query returns everything in order, which is
 * what keeps every existing no-query behavior exactly as it was.
 */
export function filterPickerRows(rows: readonly PickerRow[], query: string): PickerRow[] {
  const items: ChooserItem<number>[] = rows.map((row, index) => row.kind === "model"
    ? { value: index, label: row.choice.model, description: row.choice.providerLabel }
    : { value: index, label: row.label, description: row.header ?? "" });
  const picked: PickerRow[] = [];
  for (const item of filterItems(items, query)) {
    const row = rows[item.value];
    if (row) picked.push(row);
  }
  return picked;
}

/**
 * The rows, in the order they are shown: what you can switch to, then what you could fix.
 *
 * Unconfigured providers come after the usable models deliberately. They are the more interesting
 * rows to someone setting up and the less interesting to everyone else, and the list is opened to
 * switch models far more often than to add a key.
 */
export function buildPickerRows(catalog: ModelCatalog): PickerRow[] {
  const rows: PickerRow[] = [];
  let lastProvider: ProviderId | null = null;
  for (const choice of catalog.choices) {
    const header = choice.provider === lastProvider ? undefined : choice.providerLabel;
    lastProvider = choice.provider;
    rows.push({ kind: "model", choice, ...(header ? { header } : {}) });
  }
  for (const entry of catalog.unconfigured) {
    rows.push({ kind: "settings", header: entry.label, label: `Add a key — needs ${entry.missing.join(" and ")}` });
  }
  rows.push({ kind: "settings", header: "Settings", label: "Keys, models, pricing and voice…" });
  return rows;
}

/** Where the cursor starts: on the model in use, so the common case is "look, then Escape". */
export function initialSelection(rows: readonly PickerRow[], current: { provider: ProviderId; model: string }): number {
  const index = rows.findIndex((row) => row.kind === "model" && row.choice.provider === current.provider && row.choice.model === current.model);
  return index >= 0 ? index : 0;
}

export type PickerPaint = {
  dim(text: string): string;
  cyan(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
};

export type RenderPickerOptions = {
  /** Terminal columns. Rows are clipped to it; a wrapped row corrupts the repaint. */
  width?: number;
  /** Visible rows before the list scrolls under the selection. */
  height?: number;
  /** Characters this terminal can draw; the cursor, the current-model dot and the legend come from here. */
  glyphs?: GlyphSet;
  current: { provider: ProviderId; model: string };
  price: (choice: ModelChoice) => string;
  paint: PickerPaint;
  /** The active filter, shown above the list. The frame's rows are already filtered. */
  query?: string;
  /**
   * The row the cursor is moving away from, for one transitional frame. The outgoing row
   * keeps a dim cursor alongside the new selection's bright one — the same glide the
   * chooser drives, so learning it anywhere teaches it everywhere.
   */
  transitionFrom?: number;
  /** Content animation only: frame dimensions and hit targets never move. */
  focusProgress?: number;
};

/** Group headings are recomputed on the visible rows, not carried from the full list. */
function groupOf(row: PickerRow): string {
  return row.kind === "model" ? row.choice.providerLabel : (row.header ?? row.label);
}

export function renderModelPicker(frame: { rows: readonly PickerRow[]; selected: number }, options: RenderPickerOptions): string {
  const { paint } = options;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const height = options.height ?? 10;
  // Same windowing rule as the palette: keep the selection on screen, or the arrow keys look broken.
  const columns = terminalColumns(options.width);
  const start = windowStart(frame.selected, frame.rows.length, height);
  const visible = frame.rows.slice(start, start + height);
  const naturalWidth = Math.max(0, ...visible.map((row) => visibleWidth(row.kind === "model" ? row.choice.model : row.label)));
  const labelBudget = Math.max(0, Math.min(naturalWidth, Math.floor(Math.max(0, columns - 11) * 0.65)));

  const lines: string[] = [];
  // The query is feedback, not a row: it sits above the list the way the chooser's does.
  if (options.query) lines.push(paint.dim(clipTo(`  filter: ${options.query}`, columns)));
  if (visible.length === 0) lines.push(paint.dim(clipTo("  (no match)", columns)));

  // A filtered list regroups: the stored header belonged to a run of rows most of which may
  // be gone, so headings are re-derived from the visible runs and the first row of each run
  // carries its group's name.
  let lastGroup: string | undefined;
  for (const [offset, row] of visible.entries()) {
    const group = groupOf(row);
    if (group !== lastGroup) lines.push(paint.cyan(clipTo(`  ${group}`, columns)));
    lastGroup = group;
    const active = start + offset === frame.selected;
    const fadingOut = !active && start + offset === options.transitionFrom;
    const cursor = active ? paint.green(glyphs.prompt) : fadingOut ? paint.dim(glyphs.prompt) : " ";
    const number = offset < 9 ? `${offset + 1}.` : "  ";
    if (columns < 9) {
      const label = row.kind === "model" ? row.choice.model : row.label;
      lines.push(active ? paint.green(clipTo(`${glyphs.prompt}${label}`, columns)) : clipTo(label, columns));
      continue;
    }
    if (row.kind === "settings") {
      lines.push(`  ${cursor} ${paint.dim(number)} ${paint.yellow(clipTo(row.label, columns - 7))}`);
      continue;
    }
    const isCurrent = row.choice.provider === options.current.provider && row.choice.model === options.current.model;
    const tags = [row.choice.isProviderDefault ? "default" : "", isCurrent ? "current" : ""].filter(Boolean).join(", ");
    const shownModel = clipTo(row.choice.model, labelBudget);
    const padded = shownModel + " ".repeat(Math.max(0, labelBudget - visibleWidth(shownModel)));
    const focus = Math.max(0, Math.min(1, options.focusProgress ?? 1));
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(padded)].map((part) => part.segment);
    const illuminated = Math.round(graphemes.length * focus);
    const label = active
      ? paint.cyan(graphemes.slice(0, illuminated).join("")) + graphemes.slice(illuminated).join("")
      : padded;
    const tail = `${options.price(row.choice)}${tags ? `  (${tags})` : ""}`;
    const room = Math.max(0, columns - visibleWidth(`  ${active ? glyphs.prompt : " "} ${number} ${isCurrent ? glyphs.circleFull : " "} ${padded}  `));
    lines.push(`  ${cursor} ${paint.dim(number)} ${isCurrent ? paint.green(glyphs.circleFull) : " "} ${label}  ${paint.dim(clipTo(tail, room))}`);
  }
  lines.push(paint.dim(clipTo(`  ${glyphs.arrowUp}${glyphs.arrowDown} move ${glyphs.middot} Enter choose ${glyphs.middot} t table ${glyphs.middot} type to filter ${glyphs.middot} Esc back`, columns)));
  return lines.join("\n");
}

/**
 * Advances the picker one keystroke.
 *
 * Split from the reading loop for the same reason the palette's is: the whole interaction is then
 * testable without a terminal, and the loop below does nothing but turn keypresses into these calls.
 *
 * Movement and choice index into the *filtered* rows — resolving Enter against the full list
 * would silently return a different row than the one highlighted. Letters type into the filter
 * (model ids are full of digits and t's), so `t` and the digit jump only fire on an empty query,
 * and Escape clears the query before it cancels.
 */
export function advanceModelPicker(state: PickerState, rows: readonly PickerRow[], input: { str?: string; key: KeypressEvent }, options: { height?: number } = {}): {
  state: PickerState;
  done?: { result?: PickerResult };
} {
  const name = input.key.name;
  const query = state.query ?? "";
  const visible = filterPickerRows(rows, query);
  const last = Math.max(0, visible.length - 1);
  const height = Math.max(1, options.height ?? 10);
  const clamp = (index: number) => Math.max(0, Math.min(last, index));

  if (name === "escape" || (input.key.ctrl && (name === "c" || name === "g"))) {
    // Escape undoes the filter before it abandons the menu, which is what every editor
    // has trained: clearing the search is not leaving.
    return query ? { state: { selected: 0, query: "" } } : { state, done: {} };
  }
  if (name === "return" || name === "enter") {
    const row = visible.length > 0 ? visible[clamp(state.selected)] : undefined;
    if (!row) return { state, done: {} };
    return { state, done: { result: row.kind === "model" ? { kind: "model", choice: row.choice } : { kind: "settings" } } };
  }
  // Clamped rather than wrapped: wrapping past the end of a list this short reads as the cursor
  // having jumped somewhere at random.
  if (name === "up" || (input.key.ctrl && name === "p")) return { state: { selected: clamp(state.selected - 1), query } };
  if (name === "down" || (input.key.ctrl && name === "n")) return { state: { selected: clamp(state.selected + 1), query } };
  if (name === "pageup") return { state: { selected: clamp(state.selected - height), query } };
  if (name === "pagedown") return { state: { selected: clamp(state.selected + height), query } };
  if (name === "home") return { state: { selected: 0, query } };
  if (name === "end") return { state: { selected: last, query } };

  // The one key that is neither movement nor choice: the same models, with their prices in columns
  // you can order by. The list answers "what can I switch to"; the table answers "which of these is
  // cheapest", which the list cannot without the reader comparing every row by eye.
  //
  // Only on an empty query: once filtering, `t` is text — every other reading makes `sonnet`
  // flip to the table on its fourth letter.
  if ((input.str === "t" || input.str === "T") && !input.key.ctrl && !input.key.meta) {
    if (!query) return { state, done: { result: { kind: "table" } } };
  } else if (input.str && /^[1-9]$/.test(input.str) && !input.key.ctrl && !input.key.meta && !query) {
    // Typing a number still works, because the printed list taught people to do that and a menu that
    // silently ignores the habit it created is worse than one that never offered numbers at all.
    // Only on an empty query, for the same reason as `t`: `gpt-5.6` is unfindable if `5` jumps.
    const start = windowStart(state.selected, visible.length, height);
    const shown = Math.min(height, visible.length - start);
    const digit = Number(input.str);
    if (digit > shown) return { state };
    return { state: { selected: start + digit - 1, query } };
  }

  if (name === "backspace") return { state: { selected: 0, query: query.slice(0, -1) } };
  if (input.key.ctrl && name === "u") return { state: { selected: 0, query: "" } };
  // Printable characters only. An unhandled escape sequence otherwise arrives as raw bytes and
  // silently poisons the query with characters nobody typed. The cursor resets because the
  // ranked results just reshuffled underneath it.
  if (input.str && input.str.length === 1 && input.str >= " " && !input.key.ctrl && !input.key.meta) {
    return { state: { selected: 0, query: query + input.str } };
  }
  return { state };
}

export type RunModelPickerOptions = RenderPickerOptions & {
  rows: readonly PickerRow[];
  /** Re-read before every frame so a live terminal resize cannot leave stale geometry behind. */
  getSize?: () => { width?: number; height?: number };
  motion?: boolean;
};

export async function runModelPicker(
  keys: AsyncIterable<{ str?: string; key: KeypressEvent }>,
  paint: (frame: string) => void,
  options: RunModelPickerOptions,
): Promise<PickerResult | undefined> {
  const { rows } = options;
  let state: PickerState = { selected: initialSelection(rows, options.current), query: "" };
  const frame = (frameState: PickerState, transitionFrom?: number, focusProgress?: number) => {
    const current = liveOptions();
    paint(renderModelPicker(
      { rows: filterPickerRows(rows, frameState.query), selected: frameState.selected },
      { ...current, query: frameState.query || undefined, transitionFrom, focusProgress },
    ));
  };
  const liveOptions = (): RunModelPickerOptions => {
    const size = options.getSize?.();
    const height = Math.max(1, Math.min(options.height ?? 10, size?.height ?? Number.POSITIVE_INFINITY));
    return { ...options, width: size?.width ?? options.width, height };
  };
  frame(state);

  // The cursor's glide: a single-step move gets one transitional frame — the outgoing row's
  // marker left dim rather than erased outright — before settling to just the new row's. The
  // same SpringAnimator the chooser drives, cancelled outright by the next keystroke: a person
  // moving quickly should never feel the glide as added latency.
  let glide: SpringAnimator | undefined;
  const settleGlide = () => { glide?.stop(); glide = undefined; };

  try { for await (const input of keys) {
    const current = liveOptions();
    const previousSelected = state.selected;
    const previousQuery = state.query;
    const step = advanceModelPicker(state, rows, input, { height: current.height });
    state = step.state;
    if (step.done) {
      settleGlide(); // a picker that returns must not leave a timer ticking after it
      return step.done.result;
    }
    settleGlide();
    // A filter keystroke reshuffles the rows rather than moving within them — gliding the
    // cursor across a list that just re-sorted would point at motion that never happened.
    const isSingleStep = state.query === previousQuery
      && (input.key.name === "up" || input.key.name === "down") && Math.abs(state.selected - previousSelected) === 1;
    const motion = options.motion ?? (process.env.ARCHYMEDES_NO_MOTION !== "1" && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb");
    if (!motion || !isSingleStep || previousSelected === state.selected) {
      frame(state);
      continue;
    }
    frame(state, previousSelected, 0);
    const animator: SpringAnimator = new SpringAnimator(0, (value) => {
      if (value < 0.95) {
        frame(state, value < 0.5 ? previousSelected : undefined, value);
        return;
      }
      animator.stop();
      glide = undefined;
      frame(state);
    }, { intervalMs: 30 });
    glide = animator;
    animator.retarget(1);
  }
  } finally { settleGlide(); }
  return undefined;
}
