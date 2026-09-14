import { describe, expect, it } from "vitest";
import { renderTaskView, taskBlockers, type TaskViewInput } from "./task-view";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../text/glyphs";
import { visibleWidth } from "../text/text-width";
import { buildPalette, builtinThemes, findBuiltinTheme } from "../theme/theme";
import type { SectionStyle } from "./sections";

const style: SectionStyle = { width: 80, depth: "none" };

const full: TaskViewInput = {
  request: "add a slug helper and wire it into the router,   with tests",
  plan: [
    { text: "write slug()", status: "done" },
    { text: "add slug.test.ts", status: "done" },
    { text: "call it from router.ts", status: "in_progress" },
    { text: "run the suite", status: "pending" },
  ],
  files: [
    { path: "src/slug.ts", added: 18, removed: 0 },
    { path: "src/slug.test.ts", added: 24, removed: 0 },
    { path: "src/router.ts", added: 3, removed: 1 },
  ],
  checks: [{ kind: "tests", passed: true }, { kind: "typecheck", passed: false }],
  lastTurnStatus: "needs_verification",
};

describe("task view", () => {
  it("assembles request, plan, changed files, verification and blockers, each with a command handle", () => {
    const rendered = renderTaskView(full, style);
    expect(rendered).toContain("task");
    expect(rendered).toContain("add a slug helper and wire it into the router, with tests");
    expect(rendered).toContain("plan · /todos");
    expect(rendered).toContain("done write slug()");
    expect(rendered).toContain("wip  call it from router.ts");
    expect(rendered).toContain("changed · /diff · /undo");
    expect(rendered).toContain("src/slug.ts");
    expect(rendered).toContain("3 files · +45 -1");
    expect(rendered).toContain("tests passed · typecheck failed");
    expect(rendered).toContain("blockers");
    expect(rendered).toContain("typecheck failing  -> re-run and /diff");
    expect(rendered).toContain("2 plan steps open  -> /todos");
    expect(rendered).toContain("last turn unverified  -> run the checks");
  });

  it("names the blockers between the current state and a finished task", () => {
    expect(taskBlockers(full)).toEqual([
      "2 plan steps open  -> /todos",
      "typecheck failing  -> re-run and /diff",
      "last turn unverified  -> run the checks",
    ]);
    expect(taskBlockers({ plan: [{ text: "x", status: "done" }], files: [], checks: [{ kind: "tests", passed: true }] })).toEqual([]);
  });

  it("shows an on-track badge when a task is moving with nothing blocking it", () => {
    const rendered = renderTaskView(
      { plan: [{ text: "done", status: "done" }], files: [{ path: "a.ts", added: 1, removed: 0 }], checks: [{ kind: "tests", passed: true }] },
      style,
    );
    expect(rendered).toContain("on track");
    expect(rendered).not.toContain("blockers");
  });

  it("says so plainly before any work has been recorded", () => {
    const rendered = renderTaskView({ plan: [], files: [], checks: [] }, style);
    expect(rendered).toContain("nothing recorded yet");
    expect(rendered).not.toContain("request");
    expect(rendered).not.toContain("blockers");
  });

  it("stays within the width across themes, depths, glyph sets and narrow terminals", () => {
    for (const width of [24, 32, 48, 80, 120]) {
      for (const theme of builtinThemes()) {
        for (const depth of ["none", "ansi256", "truecolor"] as const) {
          for (const glyphs of [ASCII_GLYPHS, UNICODE_GLYPHS]) {
            const rendered = renderTaskView(
              { ...full, request: "打".repeat(200), plan: full.plan.map((item) => ({ ...item, text: item.text.repeat(20) })) },
              { width, depth, glyphs, palette: buildPalette(theme, depth) },
            );
            for (const line of rendered.split("\n")) {
              expect(visibleWidth(line), `${width}/${theme.name}/${depth} line too wide: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
            }
            if (depth === "none") expect(rendered).not.toContain("\x1b");
          }
        }
      }
    }
  });

  it("paints failing verification in the error tone and passing in the success tone", () => {
    const palette = buildPalette(findBuiltinTheme("archymedes")!, "truecolor");
    const failing = renderTaskView({ ...full }, { ...style, depth: "truecolor", palette });
    expect(failing).toContain(palette.error);

    const passing = renderTaskView(
      { plan: [{ text: "x", status: "done" }], files: [], checks: [{ kind: "tests", passed: true }] },
      { ...style, depth: "truecolor", palette },
    );
    expect(passing).toContain(palette.success);
  });
});
