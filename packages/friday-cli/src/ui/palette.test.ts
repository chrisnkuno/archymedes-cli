import { describe, expect, it } from "vitest";
import { advancePalette, rankPaletteEntries, type PaletteEntry, type PaletteKey } from "./palette";

const entries: PaletteEntry[] = [
  { command: "/mode", args: "[plan|build|auto]", description: "Show or switch the permission mode" },
  { command: "/undo", description: "Revert the last turn's changes" },
  { command: "/diff", description: "What changed since the last checkpoint" },
  { command: "/cost", description: "Token and cost breakdown for this session", chord: "F7" },
];

const press = (name: string, extra: Partial<PaletteKey["key"]> = {}, str?: string): PaletteKey => ({ str, key: { name, ...extra } });
const type = (text: string): PaletteKey[] => [...text].map((char) => ({ str: char, key: { name: char } }));

describe("ranking", () => {
  it("puts a name match above a description match", () => {
    // "/undo" describes itself as reverting changes, so a naive substring search over everything
    // would rank it above "/diff" for the query "diff". Names have to win.
    expect(rankPaletteEntries(entries, "diff").map((entry) => entry.command)).toEqual(["/diff"]);
    expect(rankPaletteEntries(entries, "checkpoint").map((entry) => entry.command)).toEqual(["/diff"]);
  });

  it("finds a command by what it does, not only by its name", () => {
    // The case the palette exists for: nobody guesses "/undo" from the word "revert".
    expect(rankPaletteEntries(entries, "revert").map((entry) => entry.command)).toEqual(["/undo"]);
    expect(rankPaletteEntries(entries, "permission").map((entry) => entry.command)).toEqual(["/mode"]);
  });

  it("ignores a leading slash and surrounding space", () => {
    expect(rankPaletteEntries(entries, "  /co ").map((entry) => entry.command)).toEqual(["/cost"]);
  });

  it("returns everything for an empty query and nothing for a miss", () => {
    expect(rankPaletteEntries(entries, "")).toHaveLength(4);
    expect(rankPaletteEntries(entries, "kubernetes")).toEqual([]);
  });

  it("keeps equally good matches in catalog order", () => {
    // Reshuffling ties between keystrokes makes the highlighted row jump under the user's fingers.
    const ranked = rankPaletteEntries([...entries].reverse(), "o");
    expect(ranked.map((entry) => entry.command)).toEqual(["/cost", "/undo", "/mode", "/diff"]);
  });
});

describe("keystrokes", () => {
  it("filters as characters arrive and resets the selection", () => {
    let state = { query: "", selected: 2 };
    for (const key of type("und")) state = advancePalette(state, entries, key).state;
    expect(state).toEqual({ query: "und", selected: 0 });
  });

  it("moves the selection without running off either end", () => {
    let state = { query: "", selected: 0 };
    state = advancePalette(state, entries, press("up")).state;
    expect(state.selected).toBe(0);
    for (let index = 0; index < 10; index += 1) state = advancePalette(state, entries, press("down")).state;
    expect(state.selected).toBe(3);
  });

  it("returns the selected command on Enter", () => {
    const step = advancePalette({ query: "diff", selected: 0 }, entries, press("return"));
    expect(step.done).toEqual({ command: "/diff" });
  });

  it("leaves a trailing space on a command that takes arguments", () => {
    // Choosing "/mode" should leave the cursor ready to type "plan", not submit a bare "/mode".
    expect(advancePalette({ query: "mode", selected: 0 }, entries, press("return")).done).toEqual({ command: "/mode " });
  });

  it("dismisses on Escape and on the key that opened it", () => {
    expect(advancePalette({ query: "", selected: 0 }, entries, press("escape")).done).toEqual({});
    expect(advancePalette({ query: "", selected: 0 }, entries, press("g", { ctrl: true })).done).toEqual({});
    expect(advancePalette({ query: "", selected: 0 }, entries, press("c", { ctrl: true })).done).toEqual({});
  });

  it("chooses nothing when Enter lands on an empty result list", () => {
    expect(advancePalette({ query: "kubernetes", selected: 0 }, entries, press("return")).done).toEqual({});
  });

  it("clamps a stale selection when Enter uses it", () => {
    expect(advancePalette({ query: "diff", selected: 99 }, entries, press("return")).done).toEqual({ command: "/diff" });
  });

  it("edits the query with Backspace and Ctrl+U", () => {
    expect(advancePalette({ query: "diff", selected: 0 }, entries, press("backspace")).state.query).toBe("dif");
    expect(advancePalette({ query: "diff", selected: 3 }, entries, press("u", { ctrl: true })).state).toEqual({ query: "", selected: 0 });
  });

  it("does not let control keys and escape sequences leak into the query", () => {
    const before = { query: "di", selected: 0 };
    expect(advancePalette(before, entries, press("left")).state.query).toBe("di");
    expect(advancePalette(before, entries, press("a", { ctrl: true }, "")).state.query).toBe("di");
    expect(advancePalette(before, entries, press("f1", {}, "OP")).state.query).toBe("di");
  });
});

describe("finding a command you half-remember", () => {
  it("matches letters in order when they are not adjacent", () => {
    // Slash commands are short words with no separators, so there is nothing to abbreviate *by*:
    // a user who half-remembers a name has only the letters and their order to go on.
    expect(rankPaletteEntries(entries, "wnd").map((entry) => entry.command)).toEqual([]);
    expect(rankPaletteEntries(entries, "md").map((entry) => entry.command)).toContain("/mode");
    expect(rankPaletteEntries(entries, "df").map((entry) => entry.command)).toContain("/diff");
  });

  it("never lets a subsequence match outrank something typed exactly", () => {
    // Subsequence matching is generous enough to match most of the catalog on a short query, so it
    // has to sit beneath every literal match or it drowns the answers people meant.
    const ranked = rankPaletteEntries(entries, "cost").map((entry) => entry.command);
    expect(ranked[0]).toBe("/cost");
    const byName = rankPaletteEntries(entries, "diff").map((entry) => entry.command);
    expect(byName[0]).toBe("/diff");
  });

  it("still ranks a name match above a description match", () => {
    // The original guarantee, kept: typing "diff" must not put /undo first because its description
    // says "changes".
    const ranked = rankPaletteEntries(entries, "mode").map((entry) => entry.command);
    expect(ranked[0]).toBe("/mode");
  });
});

describe("moving through the palette", () => {
  const many: PaletteEntry[] = Array.from({ length: 20 }, (_unused, index) => ({ command: `/c${index}`, description: `command ${index}` }));

  it("pages with an overlap, so the row you were reading survives the jump", () => {
    const step = advancePalette({ query: "", selected: 0 }, many, press("pagedown"), { rows: 8 });
    expect(step.state.selected).toBe(7);
    const back = advancePalette(step.state, many, press("pageup"), { rows: 8 });
    expect(back.state.selected).toBe(0);
  });

  it("jumps to the ends", () => {
    expect(advancePalette({ query: "", selected: 5 }, many, press("end")).state.selected).toBe(19);
    expect(advancePalette({ query: "", selected: 5 }, many, press("home")).state.selected).toBe(0);
  });

  it("accepts Ctrl+P and Ctrl+N, since readline's own are unavailable while this is open", () => {
    expect(advancePalette({ query: "", selected: 3 }, many, press("n", { ctrl: true })).state.selected).toBe(4);
    expect(advancePalette({ query: "", selected: 3 }, many, press("p", { ctrl: true })).state.selected).toBe(2);
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(advancePalette({ query: "", selected: 0 }, many, press("pageup"), { rows: 8 }).state.selected).toBe(0);
    expect(advancePalette({ query: "", selected: 19 }, many, press("pagedown"), { rows: 8 }).state.selected).toBe(19);
  });

  it("erases a word of the query with Ctrl+W", () => {
    expect(advancePalette({ query: "show mode", selected: 0 }, entries, press("w", { ctrl: true })).state.query).toBe("show");
  });

  it("keeps every navigation key inside the match list as it narrows", () => {
    // End on a filtered list must land on the last *match*, not the last entry of the full catalog.
    const step = advancePalette({ query: "c1", selected: 0 }, many, press("end"), { rows: 8 });
    const matches = rankPaletteEntries(many, "c1");
    expect(step.state.selected).toBe(matches.length - 1);
  });
});
