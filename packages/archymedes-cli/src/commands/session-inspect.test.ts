import { describe, expect, it } from "vitest";
import { renderTask, renderTodos, type InspectContext } from "./session-inspect";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../text/glyphs";
import { visibleWidth } from "../text/text-width";
import { buildPalette, builtinThemes } from "../theme/theme";

function context(overrides: Partial<InspectContext> = {}): InspectContext {
  return {
    style: { width: 80, depth: "none", glyphs: UNICODE_GLYPHS },
    glyphs: UNICODE_GLYPHS,
    depth: "none",
    plan: [],
    files: [],
    checks: [],
    turnsTaken: false,
    ...overrides,
  };
}

describe("session inspection commands", () => {
  it("renders /todos as a titled box, or nothing when there is no plan", () => {
    expect(renderTodos(context())).toBeNull();
    const rendered = renderTodos(context({
      plan: [
        { text: "read the config", status: "done" },
        { text: "wire the route", status: "in_progress" },
        { text: "add a test", status: "pending" },
      ],
    }));
    expect(rendered).toContain("todos");
    expect(rendered).toContain("read the config");
    expect(rendered).toContain("add a test");
  });

  it("renders /task from the session snapshot, delegating to the task view", () => {
    const rendered = renderTask(context({
      request: "add a slug helper",
      plan: [{ text: "write slug()", status: "done" }, { text: "test it", status: "pending" }],
      files: [["src/slug.ts", { added: 12, removed: 0 }]],
      checks: [["tests", false]],
      lastTurnStatus: "failed",
      turnsTaken: true,
    }));
    expect(rendered).toContain("add a slug helper");
    expect(rendered).toContain("src/slug.ts");
    expect(rendered).toContain("tests failed");
    expect(rendered).toContain("blockers");
    expect(rendered).toContain("last turn failed  -> /retry or /continue");
  });

  it("does not treat the default last-turn status as a blocker before any turn has run", () => {
    const rendered = renderTask(context({ request: undefined, plan: [{ text: "x", status: "pending" }], lastTurnStatus: "failed", turnsTaken: false }));
    expect(rendered).not.toContain("last turn failed");
  });

  it("stays within the width across themes, depths and glyph sets", () => {
    for (const width of [24, 40, 80]) {
      for (const theme of builtinThemes()) {
        for (const depth of ["none", "truecolor"] as const) {
          for (const glyphs of [ASCII_GLYPHS, UNICODE_GLYPHS]) {
            const ctx = context({
              style: { width, depth, glyphs, palette: buildPalette(theme, depth) },
              glyphs,
              depth,
              request: "打".repeat(120),
              plan: [{ text: "step ".repeat(40), status: "in_progress" }],
              files: [["a/very/deep/path/module.ts".repeat(4), { added: 9, removed: 2 }]],
              checks: [["typecheck", false]],
              turnsTaken: true,
            });
            // `renderTask` clips every line; `renderTodos` inherits `box`'s size-to-content
            // behaviour unchanged by this extraction, so it is not width-checked here.
            for (const line of renderTask(ctx).split("\n")) {
              expect(visibleWidth(line)).toBeLessThanOrEqual(width);
            }
          }
        }
      }
    }
  });
});
