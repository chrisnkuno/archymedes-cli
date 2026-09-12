import { describe, expect, it, vi } from "vitest";
import { renderGeometry, renderIdentity, writeIdentity } from "./identity";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";
import { buildPalette, builtinThemes } from "./theme";
import { renderPromptBox } from "./tui";

describe("Archymedes identity", () => {
  for (const width of [1, 8, 20, 40, 63, 64, 80, 120]) {
    it(`fits ${width} columns across themes, color depths and glyph sets`, () => {
      for (const theme of builtinThemes()) for (const depth of ["none", "ansi256", "truecolor"] as const) {
        for (const glyphs of [ASCII_GLYPHS, UNICODE_GLYPHS]) {
          const output = renderIdentity({ width, rows: 24, version: "1.10.0", workspace: "项目/".repeat(30), model: "provider/model".repeat(20), mode: "build", palette: buildPalette(theme, depth), glyphs });
          for (const line of output.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          if (depth === "none") expect(output).not.toContain("\x1b");
          if (depth === "ansi256") expect(output).not.toContain("\x1b[38;2;");
        }
      }
    });
  }

  it("uses three rows on a short terminal and neutralizes control characters in metadata", () => {
    const palette = buildPalette(builtinThemes()[0], "none");
    const output = renderIdentity({ width: 100, rows: 12, version: "1.10.0", workspace: "repo\n\x1b[2J", model: "model", mode: "plan", palette });
    expect(output.split("\n")).toHaveLength(3);
    expect(output).toContain("ARCHYMEDES");
    expect(output).not.toContain("\x1b");
  });

  it("uses the selected palette for composer borders and permission-mode colors", () => {
    for (const theme of builtinThemes()) {
      const palette = buildPalette(theme, "truecolor");
      const frame = renderPromptBox({ mode: "plan", workspace: "repo", width: 80, depth: "truecolor", palette });
      expect(frame.top).toContain(palette.primary);
      expect(frame.prefix).toContain(palette.warning);
      const plain = renderPromptBox({ mode: "plan", workspace: "repo", width: 80, depth: "none", palette });
      expect(Object.values(plain).join("")).not.toContain("\x1b");
    }
  });
});


describe("identity motion", () => {
  it("keeps every rotation within the same ASCII canvas", () => {
    for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
      const rows = renderGeometry(angle, true);
      expect(rows).toHaveLength(11);
      for (const row of rows) {
        expect(row).toHaveLength(23);
        expect(row).toMatch(/^[\x20-\x7e]+$/);
      }
    }
    expect(renderGeometry(0)).not.toEqual(renderGeometry(0.6));
  });

  it("settles on the original frame and stops redrawing after a resize", async () => {
    vi.useFakeTimers();
    try {
      const options = { width: 80, rows: 30, version: "test", workspace: "repo", model: "model", mode: "build", palette: buildPalette(builtinThemes()[0], "none") };
      const writes: string[] = [];
      const output = { write: (text: string) => writes.push(text) };
      const running = writeIdentity(options, output, { enabled: true, size: () => options });
      await vi.runAllTimersAsync();
      await running;
      expect(writes).toHaveLength(29);
      expect(writes.at(-1)?.replace(/\x1b\[11F|\x1b\[2K|\x1b\[\?2026[hl]/g, "")).toBe(writes[0]);
      writes.length = 0;
      const resized = writeIdentity(options, output, { enabled: true, size: () => ({ width: 40, rows: 30 }) });
      await vi.runAllTimersAsync();
      await resized;
      expect(writes).toHaveLength(1);
      writes.length = 0;
      const controller = new AbortController();
      const interrupted = writeIdentity(options, output, { enabled: true, size: () => options, signal: controller.signal });
      controller.abort();
      await vi.runAllTimersAsync();
      await interrupted;
      expect(writes).toHaveLength(1);
      writes.length = 0;
      await writeIdentity(options, output, { enabled: false, size: () => options });
      expect(writes).toHaveLength(1);
      expect(writes[0]).not.toContain("\x1b");
    } finally {
      vi.useRealTimers();
    }
  });
});
