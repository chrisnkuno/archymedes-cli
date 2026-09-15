import { describe, expect, it } from "vitest";
import { UNICODE_GLYPHS } from "../text/glyphs";
import { runGuideCommand, type GuideCommandContext } from "./guide-command";

function context(overrides: Partial<GuideCommandContext> = {}) {
  const written: string[] = [];
  const folds: string[] = [];
  const same = (text: string) => text;
  const ctx: GuideCommandContext = {
    openScreen: async () => false,
    fold: (label) => { folds.push(label); return 4; },
    foldAfterLines: 14,
    write: (text) => written.push(text),
    paint: { dim: same, yellow: same, cyan: same },
    style: { width: 80, depth: "none" },
    glyphs: UNICODE_GLYPHS,
    depth: "none",
    ...overrides,
  };
  return { ctx, written, folds };
}

describe("/guide", () => {
  it("opens the screen for a bare /guide and prints the index only when it cannot", async () => {
    const screen = context({ openScreen: async () => true });
    await runGuideCommand({ kind: "index" }, screen.ctx);
    expect(screen.written).toEqual([]);
    const printed = context();
    await runGuideCommand({ kind: "index" }, printed.ctx);
    expect(printed.written.join("")).toContain("Getting started");
  });

  it("folds the whole guide, prints a topic, and explains search misses and unknown topics", async () => {
    const all = context();
    await runGuideCommand({ kind: "all" }, all.ctx);
    expect(all.folds).toEqual(["guide"]);
    const topic = context();
    await runGuideCommand({ kind: "topic", id: "tabs" }, topic.ctx);
    expect(topic.written.join("")).toContain("Only the tab in front runs");
    const search = context();
    await runGuideCommand({ kind: "search", query: "zzzz-nothing" }, search.ctx);
    expect(search.written.join("")).toContain('Nothing in the guide mentions "zzzz-nothing"');
    const unknown = context();
    await runGuideCommand({ kind: "unknown", id: "nope" }, unknown.ctx);
    expect(unknown.written[0]).toContain('No guide topic called "nope"');
  });
});
