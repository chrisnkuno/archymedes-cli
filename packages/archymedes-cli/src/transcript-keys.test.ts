import { describe, expect, it } from "vitest";
import { isTranscriptKey, transcriptScrollForKey } from "./transcript-keys";

describe("transcript scroll keys", () => {
  it("pages, moves by line with a modifier, and jumps to either end", () => {
    expect(transcriptScrollForKey({ name: "pageup" }, false)).toEqual({ kind: "pageUp" });
    expect(transcriptScrollForKey({ name: "pagedown" }, true)).toEqual({ kind: "pageDown" });
    expect(transcriptScrollForKey({ name: "up", meta: true }, false)).toEqual({ kind: "up", rows: 1 });
    expect(transcriptScrollForKey({ name: "down", ctrl: true }, true)).toEqual({ kind: "down", rows: 1 });
    expect(transcriptScrollForKey({ name: "home", ctrl: true }, false)).toEqual({ kind: "top" });
    expect(transcriptScrollForKey({ name: "end", ctrl: true }, true)).toEqual({ kind: "live" });
  });

  it("leaves composer keys alone", () => {
    for (const name of ["up", "down", "home", "end", "left", "a"]) expect(transcriptScrollForKey({ name }, true)).toBeNull();
    expect(transcriptScrollForKey(undefined, true)).toBeNull();
    expect(isTranscriptKey({ name: "up" })).toBe(false);
    expect(isTranscriptKey({ name: "up", meta: true })).toBe(true);
  });

  it("uses Escape only to leave history", () => {
    expect(transcriptScrollForKey({ name: "escape" }, true)).toEqual({ kind: "live" });
    expect(transcriptScrollForKey({ name: "escape" }, false)).toBeNull();
  });
});
