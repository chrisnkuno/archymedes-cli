import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setCodeStyle } from "./render/syntax";
import { renderMarkdown } from "./render/markdown";
import { ANSI_PALETTE, buildPalette, findBuiltinTheme, roleCode } from "./theme/theme";

const archymedes = buildPalette(findBuiltinTheme("archymedes")!, "truecolor");
const blueprint = buildPalette(findBuiltinTheme("blueprint")!, "truecolor");

describe("theme coverage", () => {
  // These check the theme-role highlighter; VS Code colours (the default) have their own tests in render/syntax.test.ts.
  beforeAll(() => setCodeStyle({ colors: "theme" }));
  afterAll(() => setCodeStyle({ colors: "vscode" }));

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

});
