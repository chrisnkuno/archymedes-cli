import { describe, expect, it } from "vitest";
import { parseLayoutCommand, resolveLayout, wantsPinnedFooter, workspaceFrameOptions } from "./layout-choice";

describe("layout choice", () => {
  it("starts in the fixed workspace by default", () => {
    expect(resolveLayout({}, {})).toBe("fixed");
    expect(resolveLayout({}, { ARCHYMEDES_LAYOUT: "fixed" })).toBe("fixed");
    expect(resolveLayout({}, { ARCHYMEDES_LAYOUT: "nonsense" })).toBe("fixed");
  });

  it("opts out through the environment, a pinned footer, or a terminal that cannot address the cursor", () => {
    expect(resolveLayout({}, { ARCHYMEDES_LAYOUT: " Scrollback " })).toBe("scrollback");
    expect(resolveLayout({}, { TERM: "dumb" })).toBe("scrollback");
    expect(resolveLayout({ pin: true }, {})).toBe("scrollback");
    expect(resolveLayout({}, { ARCHYMEDES_PIN: "1" })).toBe("scrollback");
  });

  it("lets an explicit layout win over everything else", () => {
    expect(resolveLayout({ layout: "fixed", pin: true }, { ARCHYMEDES_LAYOUT: "scrollback" })).toBe("fixed");
    expect(resolveLayout({ layout: "scrollback" }, {})).toBe("scrollback");
  });

  it("reads the pinned-footer preference", () => {
    expect(wantsPinnedFooter(false, {})).toBe(false);
    expect(wantsPinnedFooter(false, { ARCHYMEDES_PIN: "0" })).toBe(false);
    expect(wantsPinnedFooter(false, { ARCHYMEDES_PIN: "yes" })).toBe(true);
    expect(wantsPinnedFooter(true, {})).toBe(true);
  });

  it("parses /layout, toggling when no layout is named", () => {
    expect(parseLayoutCommand("/layouts", "fixed")).toBeNull();
    expect(parseLayoutCommand("/layout", "fixed")).toEqual({ layout: "scrollback" });
    expect(parseLayoutCommand("/layout", "scrollback")).toEqual({ layout: "fixed" });
    expect(parseLayoutCommand("/layout scrollback", "scrollback")).toEqual({ layout: "scrollback" });
    expect(parseLayoutCommand("/layout wide", "fixed")).toHaveProperty("error");
  });

  it("builds frame options that honour motion and mouse opt-outs", () => {
    const input = { emit: () => true };
    expect(workspaceFrameOptions({}, input)).toEqual({ motion: true, input });
    expect(workspaceFrameOptions({ ARCHYMEDES_MOUSE: "0", NO_COLOR: "1" }, input)).toEqual({ motion: false, input: undefined });
  });
});
