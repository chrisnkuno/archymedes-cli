import type { FixedLayoutAction } from "./fixed-layout";

export type TranscriptScroll = FixedLayoutAction | { kind: "live" };
export type ScrollKey = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean };

/** Rows one wheel notch moves: the pager convention, since one row feels stuck and a page overshoots. */
export const WHEEL_ROWS = 3;

/**
 * Transcript scrolling keys for the fixed workspace. Only keys the composer does not use:
 * page keys, modified arrows (bare arrows recall history), Ctrl+Home/End, and Escape while reading history.
 */
export function transcriptScrollForKey(key: ScrollKey | undefined, browsing: boolean): TranscriptScroll | null {
  if (!key?.name) return null;
  const modified = Boolean(key.ctrl || key.meta);
  switch (key.name) {
    case "pageup": return { kind: "pageUp" };
    case "pagedown": return { kind: "pageDown" };
    case "up": return modified ? { kind: "up", rows: 1 } : null;
    case "down": return modified ? { kind: "down", rows: 1 } : null;
    case "home": return key.ctrl ? { kind: "top" } : null;
    case "end": return key.ctrl ? { kind: "live" } : null;
    case "escape": return browsing ? { kind: "live" } : null;
    default: return null;
  }
}

/** True for keys that scroll the transcript, so composer features (suggestions) can ignore them. */
export function isTranscriptKey(key: ScrollKey | undefined): boolean {
  return transcriptScrollForKey(key, false) !== null;
}
