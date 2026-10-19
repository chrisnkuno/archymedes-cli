import { DIM, paint } from "../text/ansi";
import type { ColorDepth } from "../text/color-depth";
import { UNICODE_GLYPHS, type GlyphSet } from "../text/glyphs";

/**
 * Folded blocks, and the handle that unfolds them.
 *
 * The transcript has one screen and a turn can produce a thousand lines. The usual answers are both
 * bad: print everything and the answer scrolls away above the reader, or truncate and the detail is
 * gone for good. So long output is folded to a readable height and *kept*, tagged with a number
 * the reader can ask for — `[3] +140 lines · /expand 3`.
 *
 * A full-screen pager was the other option and is the wrong one here. Archymedes's transcript is an
 * append-only scroll precisely so it stays copy-pasteable and scrollable with the terminal's own
 * scrollback; a pager takes the keyboard, hides the session behind it, and gives back a view you
 * cannot quote. Expansion prints *into the transcript* instead, so the expanded copy scrolls and
 * copies exactly like everything around it.
 *
 * Entries live for the session and are capped, because this is a convenience over output the model
 * already consumed — not a second store of record.
 */

const MAX_ENTRIES = 64;

export type Expandable = {
  id: number;
  /** What the reader is asking to see: "src/app.ts", "npm test output". */
  label: string;
  /** The whole thing, already rendered for the terminal. */
  full: string;
  /** How many lines were withheld — the number that makes the offer worth making. */
  hidden: number;
};

export class ExpandableStore {
  private entries: Expandable[] = [];
  private nextId = 1;

  /** Files a folded block and returns its id; ids never repeat within a session. */
  add(label: string, full: string, hidden: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.entries.push({ id, label, full, hidden });
    // Oldest first: the block a reader asks to expand is nearly always one they can still see.
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    return id;
  }

  get(id: number): Expandable | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  get last(): Expandable | undefined {
    return this.entries.at(-1);
  }

  get all(): readonly Expandable[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }

  /** A new thread has nothing to do with the last one's output. */
  clear(): void {
    this.entries = [];
  }
}

/** The one-line offer printed under a folded block. */
export function expandHint(id: number, hidden: number, depth: ColorDepth, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  return paint(`${glyphs.collapsed} ${hidden} more line${hidden === 1 ? "" : "s"} hidden ${glyphs.middot} /expand ${id}`, DIM, depth);
}
