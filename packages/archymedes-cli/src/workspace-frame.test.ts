import { describe, expect, it, vi } from "vitest";
import { frameText, WorkspaceFrame, workspaceHeader } from "./workspace-frame";
import { LineLog } from "./output";
import { buildPalette, builtinThemes } from "./theme";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";

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
    const frame = new WorkspaceFrame(stream, () => context, () => log, motion);
    frame.enter();
    // Retire the opening identity so this exercises the actual transcript.
    log.write("latest\n");
    return { writes, stream, log, frame };
  }

  it("keeps history still as new output arrives, then returns to the live tail", () => {
    const { frame, log, writes } = setup();
    frame.navigate("up");
    expect(frame.browsing).toBe(true);
    const before = writes.length;
    log.write("new arrival\n");
    frame.write("new arrival\n");
    frame.refresh();
    expect(writes.slice(before).join("")).not.toContain("new arrival");
    frame.navigate("live");
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
    frame.navigate("up");
    expect(frame.browsing).toBe(false);
    log.write("new short arrival\n");
    frame.refresh();
    expect(writes.at(-2)).toContain("new short arrival");
    log.write(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n");
    frame.navigate("up");
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
});
