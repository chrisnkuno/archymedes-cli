import { describe, expect, it } from "vitest";
import { renderIdentity } from "./identity";
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
