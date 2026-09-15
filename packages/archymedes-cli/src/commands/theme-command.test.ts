import { describe, expect, it } from "vitest";
import { UNICODE_GLYPHS } from "../text/glyphs";
import { findBuiltinTheme, type Theme } from "../theme/theme";
import { runThemeCommand, type ThemeCommandContext } from "./theme-command";

function context() {
  const written: string[] = [];
  const applied: string[] = [];
  let prefix = "old:";
  const paintWith = () => {
    const p = (text: string) => `${prefix}${text}`;
    return { dim: p, yellow: p, cyan: p, green: p, red: p, accent: p };
  };
  const ctx: ThemeCommandContext = {
    discover: async () => [{ ...findBuiltinTheme("archymedes")!, source: "builtin" }, { ...findBuiltinTheme("rainbow")!, source: "project", file: "x.tss" }],
    find: async (name) => findBuiltinTheme(name) as Theme | undefined,
    directory: (scope) => `/themes/${scope}`,
    active: { name: "archymedes" },
    apply: (theme) => { applied.push(theme.name); prefix = "new:"; },
    write: (text) => written.push(text),
    paint: paintWith,
    style: () => ({ width: 80, depth: "none" }),
    glyphs: UNICODE_GLYPHS,
  };
  return { ctx, written, applied };
}

describe("/theme", () => {
  it("lists themes with the active one marked and each non-builtin source named", async () => {
    const { ctx, written } = context();
    await runThemeCommand({ kind: "list" }, ctx);
    const text = written.join("");
    expect(text).toContain(`${UNICODE_GLYPHS.circleFull} old:archymedes`);
    expect(text).toContain("old: (project)");
  });

  it("applies a theme and paints the swatch in it, and explains an unknown name", async () => {
    const { ctx, written, applied } = context();
    await runThemeCommand({ kind: "set", name: "blueprint" }, ctx);
    expect(applied).toEqual(["blueprint"]);
    expect(written.at(-1)).toContain("new:primary");
    const missing = context();
    await runThemeCommand({ kind: "set", name: "nope" }, missing.ctx);
    expect(missing.applied).toEqual([]);
    expect(missing.written[0]).toContain('No theme named "nope"');
  });
});
