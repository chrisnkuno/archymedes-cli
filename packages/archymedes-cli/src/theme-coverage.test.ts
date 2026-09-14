import { describe, expect, it } from "vitest";
import { highlightCode } from "./code-view";
import { composeExplainPanel, initialExplainPanelState } from "./explain-view";
import { renderMarkdown } from "./markdown";
import { renderPatch, parsePatch } from "./patch-view";
import { outcomeMark, toneCode } from "./sections";
import { ANSI_PALETTE, buildPalette, findBuiltinTheme, roleCode } from "./theme";
import { box, renderPromptBox } from "./tui";

const archymedes = buildPalette(findBuiltinTheme("archymedes")!, "truecolor");
const blueprint = buildPalette(findBuiltinTheme("blueprint")!, "truecolor");

describe("theme coverage", () => {
  it("resolves roles through the palette, falling back to ANSI and to nothing without colour", () => {
    expect(roleCode("primary", archymedes, "truecolor")).toBe(archymedes.primary);
    expect(roleCode("primary", undefined, "truecolor")).toBe(ANSI_PALETTE.primary);
    expect(ANSI_PALETTE.primary).toBe("\x1b[36m");
    expect(roleCode("error", archymedes, "none")).toBe("");
  });

  it("paints assistant markdown with the theme instead of fixed ANSI colours", () => {
    const text = "## Heading\n- item with `code`\n> quote\n```ts\nconst x = 1;\n```";
    const themed = renderMarkdown(text, { width: 60, depth: "truecolor", palette: blueprint });
    expect(themed).toContain(blueprint.primary);
    expect(themed).toContain(blueprint.secondary);
    expect(themed).toContain(blueprint.accent);
    expect(themed).toContain(blueprint.success);
    expect(themed).not.toMatch(/\x1b\[3[0-7]m/);
    expect(renderMarkdown(text, { width: 60, depth: "truecolor" })).toContain("\x1b[36m");
  });

  it("themes boxes, the prompt bar, section tones, code and patches", () => {
    const style = { width: 60, depth: "truecolor" as const, palette: archymedes };
    expect(box(["hi"], { depth: "truecolor", title: "you", titleColor: "green", borderColor: "red", palette: archymedes })).toContain(archymedes.success);
    expect(renderPromptBox({ mode: "plan", workspace: "w", depth: "truecolor", width: 60, palette: archymedes }).top).toContain(archymedes.warning);
    expect(toneCode("bad", style)).toBe(archymedes.error);
    expect(outcomeMark("pass", style)).toContain(archymedes.success);
    expect(highlightCode('const s = "x";', "truecolor", archymedes)).toContain(archymedes.primary);
    const patch = "diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new\n";
    expect(parsePatch(patch)).toHaveLength(1);
    expect(renderPatch(patch, style).text).toContain(archymedes.success);
  });

  it("hands the editor's explain panel theme token values, not escape codes", () => {
    const panel = { ...initialExplainPanelState(), open: true, tab: "diff" as const };
    const rows = composeExplainPanel({ path: "a.ts", before: "old\n", after: "new\n", panel }, 40, 10, archymedes.tokens);
    expect(rows.map((row) => row.color)).toContain(archymedes.tokens.success);
    expect(rows.every((row) => !row.color?.includes("\x1b"))).toBe(true);
  });
});
