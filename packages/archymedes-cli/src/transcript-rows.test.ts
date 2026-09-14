import { describe, expect, it } from "vitest";
import { visibleWidth } from "./markdown";
import { sanitizeTranscript, transcriptRows } from "./transcript-rows";

describe("transcript rows", () => {
  it("keeps colour while removing cursor movement, terminal modes and hyperlinks", () => {
    const text = "\x1b[36mcyan\x1b[0m \x1b[2K\x1b[1A\x1b]8;;https://x\x07link\x1b]8;;\x07 \x1b[?25hdone";
    expect(sanitizeTranscript(text)).toBe("\x1b[36mcyan\x1b[0m link done");
  });

  it("keeps only what a carriage return left visible", () => {
    expect(sanitizeTranscript("spinner 1\rspinner 2\rfinal\n")).toBe("final\n");
  });

  it("wraps by visible width and reopens a style across the wrap", () => {
    const rows = transcriptRows("\x1b[32mabcdefgh\x1b[0m", 3);
    expect(rows).toEqual(["\x1b[32mabc\x1b[0m", "\x1b[32mdef\x1b[0m", "\x1b[32mgh\x1b[0m"]);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(3);
  });

  it("carries an unclosed style to the next logical line and stops after a reset", () => {
    expect(transcriptRows("\x1b[1;33mwarn\nstill\x1b[0m\nplain", 20)).toEqual([
      "\x1b[1;33mwarn\x1b[0m", "\x1b[1;33mstill\x1b[0m", "plain",
    ]);
  });

  it("never splits a grapheme, expands tabs, and keeps blank lines", () => {
    expect(transcriptRows("界👩‍💻ab", visibleWidth("界👩‍💻"))).toEqual(["界👩‍💻", "ab"]);
    expect(transcriptRows("a\n\n\tx", 4)).toEqual(["a", "", "    ", "x"]);
    expect(transcriptRows("a\tb", 20)).toEqual(["a       b"]);
  });

  it("replaces a glyph wider than the row instead of overflowing", () => {
    expect(transcriptRows("界", 1)).toEqual(["?"]);
  });
});
