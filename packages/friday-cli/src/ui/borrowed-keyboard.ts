import type { Interface } from "node:readline/promises";
import type { KeypressEvent } from "../terminal/keybindings";
import type { OutputStream } from "../terminal/output";
import { rowsOccupied } from "../render/tui";
import { runChooser, type ChooserItem, type ChooserPaint, type RunChooserOptions } from "./chooser";
import { runTable, type RunTableOptions, type TableRow } from "./table";

// Taking the keyboard from readline for a moment, for a menu or a table drawn at the cursor: what
// `archymedes settings`, `history` and the theme and model lists open. Split from `shortcuts.ts`,
// which adds the feature keys and the full-screen surfaces on top.

/** One keystroke as a borrowed-keyboard surface receives it. */
export type PaletteKey = { str?: string; key: KeypressEvent };

/**
 * The minimum needed to take the keyboard for a moment: something to read, something to paint on,
 * and the readline to hand control back to. A plain menu needs no keybinding registry, and asking
 * for one would mean the settings menu could not open before shortcuts are installed.
 */
export type KeyboardHost = {
  readline: Interface;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
};

/**
 * Draws a menu frame in place, and takes it away again.
 *
 * Two things here were wrong for as long as menus have existed, and both showed up as the same
 * symptom — a settings menu still sitting on screen after it had been answered:
 *
 * - **Rows, not lines.** The erase counted `\n`s, but a row longer than the terminal wraps onto
 *   two or more of them. Every wrapped description left one line behind on each repaint, which is
 *   why a wide menu on a narrow window smeared and a narrow one looked fine.
 * - **Nothing erased the last frame.** Each repaint cleared its predecessor, so the final frame —
 *   the one on screen when the user pressed Enter — was never anyone's predecessor and simply
 *   stayed. `erase()` is what the borrowing code calls on the way out.
 */
function painter(output: OutputStream): { paint: (frame: string) => void; erase: () => void } {
  let rows = 0;
  const erase = () => {
    for (let row = 0; row < rows; row += 1) output.write("\x1b[1A\x1b[2K");
    if (rows > 0) output.write("\r");
    rows = 0;
  };
  return {
    erase,
    paint: (frame) => {
      erase();
      output.write(`${frame}\n`);
      const columns = output.columns ?? 80;
      rows = frame.split("\n").reduce((total, line) => total + rowsOccupied(line, columns), 0);
    },
  };
}

/**
 * Runs a full-screen chooser with the terminal to itself.
 *
 * `readline` is listening for the same keypresses and would treat them as line editing — Up would
 * recall history instead of moving the selection. Detaching its listener for the duration is the
 * narrow way to borrow the keyboard; restoring in `finally` is what keeps a thrown error from
 * leaving the prompt permanently deaf.
 *
 * Shared by the palette and the model picker rather than written twice: the borrowing is the part
 * that is easy to get subtly wrong and impossible to notice until a prompt somewhere stops
 * responding, so there is one copy of it to be correct.
 */
let workspaceMenu: { paint: (frame: string) => void; erase: () => void; height: () => number; width: () => number } | undefined;

export function menuRows(host: KeyboardHost): number {
  return host.output === process.stdout && workspaceMenu ? workspaceMenu.height() : host.output.rows ?? 24;
}

export function menuColumns(host: KeyboardHost): number {
  return host.output === process.stdout && workspaceMenu ? workspaceMenu.width() : host.output.columns ?? 80;
}

/** The fixed workspace lends its body to every picker without moving the composer. */
export function setWorkspaceMenu(surface: typeof workspaceMenu): void { workspaceMenu = surface; }

/**
 * Keys a menu received but never read, held briefly for the menu opened right after it.
 *
 * A keypress chunk is decoded all at once: a fast typist, a paste, or a terminal that batches input
 * can deliver "Enter, r, w, a, n, d, a" in one go. The first menu takes the Enter and closes, and
 * the rest used to be dropped with it — so choosing a field and typing its value straight away
 * lost the value. Chained menus (a settings field, then its values) open within moments of each
 * other; anything older than this belongs to nobody and is discarded as before.
 */
let typeAhead: { keys: PaletteKey[]; at: number } | undefined;
const TYPE_AHEAD_MS = 1_000;

export async function withBorrowedKeyboard<T>(
  host: KeyboardHost,
  self: unknown,
  body: (keys: AsyncIterable<PaletteKey>, paint: (frame: string) => void) => Promise<T>,
  /**
   * Where frames land. Defaults to a free-floating overlay printed at the cursor (what the
   * full-screen palette, model picker and settings menu all want) — but a caller already holding
   * reserved rows of its own (the inline suggestion dropdown, drawn into the pinned footer's
   * scroll-region reservation) needs to paint *there* instead, or the borrowed chooser would draw
   * a second, competing menu under the first.
   */
  surface: { paint: (frame: string) => void; erase: () => void } = (host.output === process.stdout ? workspaceMenu : undefined) ?? painter(host.output),
): Promise<T> {
  const borrowed = host.input.listeners("keypress").filter((listener) => listener !== self);
  for (const listener of borrowed) host.input.off("keypress", listener as never);

  const pending: PaletteKey[] = [];
  if (typeAhead && Date.now() - typeAhead.at <= TYPE_AHEAD_MS) pending.push(...typeAhead.keys);
  typeAhead = undefined;
  let wake: (() => void) | undefined;
  const collect = (str: string | undefined, key: KeypressEvent) => {
    pending.push({ ...(str === undefined ? {} : { str }), key: key ?? {} });
    wake?.();
  };
  host.input.on("keypress", collect);
  const onResize = () => { pending.push({ key: {} }); wake?.(); };
  host.output.on("resize", onResize);

  async function* keys(): AsyncGenerator<PaletteKey> {
    for (;;) {
      while (pending.length > 0) yield pending.shift()!;
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
    }
  }

  try {
    return await body(keys(), surface.paint);
  } finally {
    // The menu comes down with the keyboard. Leaving the last frame on screen is what made an
    // answered menu look like it was still asking.
    surface.erase();
    host.output.off("resize", onResize);
    host.input.off("keypress", collect);
    // Real keys only: a resize is delivered as an empty key and means nothing to the next menu.
    const unread = pending.filter((key) => key.str !== undefined || key.key.name !== undefined);
    typeAhead = unread.length > 0 ? { keys: unread, at: Date.now() } : undefined;
    for (const listener of borrowed) host.input.on("keypress", listener as never);
  }
}

/**
 * A generic list chooser over the borrowed keyboard — what `SettingsPrompts.choose` is wired to.
 *
 * Takes the host rather than a readline so every menu in the CLI reaches the terminal the same
 * way, and so a caller cannot accidentally leave readline listening underneath an open menu.
 */
export async function openChooser<T>(
  host: KeyboardHost,
  items: readonly ChooserItem<T>[],
  options: Omit<RunChooserOptions, "paint"> & { paint: ChooserPaint },
  self?: unknown,
): Promise<T | undefined> {
  const sized = {
    width: host.output.columns ?? 80,
    ...options,
    getSize: options.getSize ?? (() => ({ width: menuColumns(host), height: Math.max(1, menuRows(host) - 4) })),
  };
  return withBorrowedKeyboard(host, self, (keys, paint) => runChooser(keys, items, paint, sized));
}

/**
 * A table over the same borrowed keyboard, returning the row the user chose.
 *
 * The height it hands the table is the terminal minus a few rows, same as every other surface here:
 * a frame sized to the whole window scrolls its own top border off the screen, and the table cannot
 * work that out for itself because a pure renderer has no business asking the process how tall it is.
 */
export async function openTable(host: KeyboardHost, options: RunTableOptions, self?: unknown): Promise<TableRow | undefined> {
  const sized = {
    width: host.output.columns ?? 80,
    ...options,
    getSize: options.getSize ?? (() => ({ width: menuColumns(host), height: Math.max(1, menuRows(host) - 2) })),
  };
  return withBorrowedKeyboard(host, self, (keys, paint) => runTable(keys, paint, sized));
}
