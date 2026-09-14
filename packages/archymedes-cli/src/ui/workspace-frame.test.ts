import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { frameText, WorkspaceFrame, workspaceHeader } from "./workspace-frame";
import { LineLog } from "../terminal/output";
import { buildPalette, builtinThemes } from "../theme/theme";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../text/glyphs";
import { visibleWidth } from "../text/text-width";

const context = { version: "2.1.0", workspace: "workspace", model: "provider/model", mode: "build", palette: buildPalette(builtinThemes()[0], "none"), glyphs: UNICODE_GLYPHS, busy: false };

describe("fixed session workspace", () => {
  it("fits the mode rail and metadata without breaking graphemes or leaking cursor commands", () => {
    for (const width of [1, 4, 12, 24, 40, 64, 80, 120]) {
      for (const glyphs of [ASCII_GLYPHS, UNICODE_GLYPHS]) for (const theme of builtinThemes()) {
        const rows = workspaceHeader({ ...context, workspace: "项目👩‍💻".repeat(20), model: "long/".repeat(30), glyphs, palette: buildPalette(theme, "truecolor") }, width);
        expect(rows).toHaveLength(4);
        for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    }
    expect(frameText("\x1b[31m界👩‍💻abc\x1b[0m", visibleWidth("界👩‍💻"))).toContain("界👩‍💻");
    expect(frameText("👩‍💻abc", 1)).toBe("");
    expect(frameText("safe\x1b[2J\x1b[Htext", 80)).toBe("safetext");
  });

  function setup(motion = false) {
    const writes: string[] = [];
    const stream = { columns: 80, rows: 24, write: (text: string) => { writes.push(text); return true; } };
    const log = new LineLog();
    log.write(Array.from({ length: 100 }, (_, i) => `entry ${i}`).join("\n") + "\n");
    const frame = new WorkspaceFrame(stream, () => context, () => log, { motion });
    frame.enter();
    // Retire the opening identity so this exercises the actual transcript.
    log.write("latest\n");
    return { writes, stream, log, frame };
  }

  it("keeps history still as new output arrives, then returns to the live tail", () => {
    const { frame, log, writes } = setup();
    frame.scroll({ kind: "pageUp" });
    expect(frame.browsing).toBe(true);
    const before = writes.length;
    log.write("new arrival\n");
    frame.write("new arrival\n");
    frame.refresh();
    expect(writes.slice(before).join("")).not.toContain("new arrival");
    frame.scroll({ kind: "live" });
    expect(writes.at(-2)).toContain("new arrival");
    expect(frame.browsing).toBe(false);
    frame.exit();
  });

  it("lends only the body to menus and restores history after resize and dismissal", () => {
    const { frame, writes, stream } = setup();
    frame.menu.paint("Choose a mode\n> build\n  plan");
    expect(writes.at(-2)).toContain("Choose a mode");
    expect(frame.current.scrollTop).toBe(5);
    stream.columns = 24; stream.rows = 10;
    frame.resize();
    expect(frame.current.inputRow).toBe(9);
    frame.menu.erase();
    expect(writes.join("")).toContain("latest");
    frame.exit();
  });

  it("returns to live projection when short history or a resize removes the scroll offset", () => {
    const { frame, log, writes, stream } = setup();
    log.clear(); log.write("short history\n");
    frame.scroll({ kind: "pageUp" });
    expect(frame.browsing).toBe(false);
    log.write("new short arrival\n");
    frame.refresh();
    expect(writes.at(-2)).toContain("new short arrival");
    log.write(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n");
    frame.scroll({ kind: "pageUp" });
    log.write("arrival during history\n");
    stream.rows = 100;
    frame.resize();
    expect(frame.browsing).toBe(false);
    expect(writes.at(-2)).toContain("arrival during history");
    frame.exit();
  });

  it("keeps redraws above suggestions and restores the transcript when they close", () => {
    const { frame, writes } = setup();
    frame.renderSuggestions(["first", "second", "third"]);
    const before = writes.length;
    frame.refresh();
    const redraw = writes.slice(before).join("");
    for (let row = frame.current.scrollBottom - 2; row <= frame.current.scrollBottom; row++) {
      expect(redraw).not.toContain(`\x1b[${row};1H`);
    }
    frame.clearSuggestions();
    expect(writes.at(-2)).toContain("latest");
    frame.exit();
  });

  it("retires the intro as soon as a partial output line arrives", () => {
    const { frame, log, writes } = setup();
    // Return to the same committed line count captured when the frame entered.
    log.clear();
    log.write(Array.from({ length: 100 }, (_, i) => `entry ${i}`).join("\n") + "\n");
    log.write("partial output");
    frame.refresh();
    expect(writes.at(-2)).toContain("partial output");
    frame.exit();
  });

  it("never lets embedded newlines, tabs or C1 controls move a frame row", () => {
    expect(frameText("one\ntwo\tthree\u0085four", 80)).toBe("onetwo threefour");
    expect(frameText("safe\x1b", 80)).toBe("safe");
  });

  it("cleans up motion, margins and the alternate screen exactly once", () => {
    vi.useFakeTimers();
    try {
      const { frame, writes } = setup(true);
      frame.exit(); frame.exit();
      const count = writes.length;
      vi.advanceTimersByTime(1000);
      expect(writes).toHaveLength(count);
      expect(writes.join("").match(/\x1b\[\?1049l/g)).toHaveLength(1);
      expect(writes.at(-1)).toContain("\x1b[r\x1b[?25h");
      const quiet = setup(false);
      const quietCount = quiet.writes.length;
      vi.advanceTimersByTime(1000);
      expect(quiet.writes).toHaveLength(quietCount);
      quiet.frame.exit();
    } finally { vi.useRealTimers(); }
  });

  const body = (writes: string[]) => writes.at(-2) ?? "";

  it("scrolls by line and page, shows position and a scrollbar, and returns live at the bottom", () => {
    const { frame, writes } = setup();
    frame.scroll({ kind: "down", rows: 1 });
    expect(frame.browsing).toBe(false);
    frame.scroll({ kind: "up", rows: 1 });
    expect(frame.browsing).toBe(true);
    expect(writes.at(-1)).toContain("HISTORY");
    expect(body(writes)).toContain(`;80H`);
    expect(body(writes)).not.toContain("latest");
    frame.scroll({ kind: "top" });
    expect(body(writes)).toContain("entry 0");
    expect(writes.at(-1)).toContain("HISTORY TOP");
    frame.scroll({ kind: "pageDown" });
    expect(frame.browsing).toBe(true);
    frame.scroll({ kind: "bottom" });
    expect(frame.browsing).toBe(false);
    expect(body(writes)).toContain("latest");
    frame.scroll({ kind: "up", rows: 2 });
    frame.scroll({ kind: "down", rows: 2 });
    expect(frame.browsing).toBe(false);
    frame.exit();
  });

  it("counts output that arrives while reading history, and ignores scrolling under a menu", () => {
    const { frame, log, writes } = setup();
    frame.scroll({ kind: "pageUp" });
    log.write("one\ntwo\n");
    frame.write("one\ntwo\n");
    expect(writes.at(-1)).toContain("+2 new");
    frame.scroll({ kind: "live" });
    frame.menu.paint("Menu");
    frame.scroll({ kind: "pageUp" });
    expect(frame.browsing).toBe(false);
    frame.exit();
  });

  it("finds text in history, steps through matches with wrap-around, and returns live when turned off", () => {
    const { frame, writes } = setup();
    expect(frame.find({ kind: "query", text: "ENTRY 7" })).toEqual({ status: "found", index: 1, total: 11, query: "ENTRY 7" });
    expect(frame.browsing).toBe(true);
    expect(writes.at(-1)).toContain('FIND 1/11 "ENTRY 7"');
    expect(writes.at(-2)).toContain("entry 7");
    expect(writes.at(-2)).toContain("◀");
    frame.find({ kind: "prev" });
    expect(writes.at(-1)).toContain('FIND 11/11');
    expect(frame.find({ kind: "next" })).toMatchObject({ status: "found", index: 1 });
    frame.scroll({ kind: "bottom" });
    expect(frame.browsing).toBe(false);
    frame.find({ kind: "query", text: "entry 99" });
    expect(frame.browsing).toBe(true);
    expect(frame.find({ kind: "off" })).toEqual({ status: "cleared" });
    expect(frame.browsing).toBe(false);
    expect(writes.at(-2)).toContain("latest");
    frame.exit();
  });

  it("stays live when a search finds nothing, and labels the top of history", () => {
    const { frame, writes } = setup();
    expect(frame.find({ kind: "query", text: "nowhere" })).toEqual({ status: "none", query: "nowhere" });
    expect(frame.browsing).toBe(false);
    expect(frame.find({ kind: "next" })).toEqual({ status: "idle" });
    frame.scroll({ kind: "top" });
    expect(writes.at(-1)).toContain("HISTORY TOP");
    frame.exit();
  });

  it("replays history with its colours but without cursor movement", () => {
    const writes: string[] = [];
    const stream = { columns: 80, rows: 24, write: (text: string) => { writes.push(text); return true; } };
    const log = new LineLog();
    log.write(Array.from({ length: 60 }, (_, i) => `\x1b[33mwarn ${i}\x1b[0m\x1b[2A`).join("\n") + "\n");
    const frame = new WorkspaceFrame(stream, () => context, () => log, { motion: false });
    frame.enter();
    log.write("tail\n");
    frame.scroll({ kind: "pageUp" });
    expect(body(writes)).toContain("\x1b[33mwarn");
    expect(body(writes)).not.toContain("\x1b[2A");
    frame.exit();
  });

  it("turns wheel reporting on only with an input, scrolls on a notch, and restores the input on exit", () => {
    const writes: string[] = [];
    const stream = { columns: 80, rows: 24, write: (text: string) => { writes.push(text); return true; } };
    const log = new LineLog();
    log.write(Array.from({ length: 100 }, (_, i) => `entry ${i}`).join("\n") + "\n");
    const input = new EventEmitter();
    const typed: string[] = [];
    input.on("data", (chunk: string) => typed.push(chunk));
    const frame = new WorkspaceFrame(stream, () => context, () => log, { motion: false, input });
    frame.enter();
    log.write("latest\n");
    expect(writes.join("")).toContain("\x1b[?1000h\x1b[?1006h");
    input.emit("data", "\x1b[<64;5;5M");
    expect(frame.browsing).toBe(true);
    expect(typed).toEqual([]);
    input.emit("data", "\x1b[<65;5;5M\x1b[<65;5;5M");
    expect(frame.browsing).toBe(false);
    frame.exit();
    expect(writes.at(-1)).toContain("\x1b[?1006l\x1b[?1000l");
    input.emit("data", "x");
    expect(typed).toEqual(["x"]);
  });
});
