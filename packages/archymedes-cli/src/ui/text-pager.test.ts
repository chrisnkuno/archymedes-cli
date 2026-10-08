import { describe, expect, it } from "vitest";
import { applyPagerAction, composePagerFrame, initialPagerState, keyToPagerAction, type PagerState } from "./text-pager";

const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");

function press(state: PagerState, name: string, character?: string) {
  return applyPagerAction(state, keyToPagerAction({ name }, character, state));
}

describe("the built-in pager", () => {
  it("opens on the end of the transcript, with colour codes stripped", () => {
    const state = initialPagerState(`\x1b[32mgreen\x1b[0m\n${text}`, 10);
    expect(state.lines[0]).toBe("green");
    expect(state.top).toBe(state.lines.length - 10);
  });

  it("scrolls, pages and jumps to either end", () => {
    let state = initialPagerState(text, 10);
    state = press(state, "home").state;
    expect(state.top).toBe(0);
    state = press(state, "down").state;
    expect(state.top).toBe(1);
    state = press(state, "pagedown").state;
    expect(state.top).toBe(10);
    state = press(state, "end").state;
    expect(state.top).toBe(40);
    state = press(state, "down").state;
    expect(state.top).toBe(40); // never past the last screenful
  });

  it("leaves on Esc or q — the way out every screen shares", () => {
    const state = initialPagerState(text, 10);
    expect(press(state, "escape").exit).toBe(true);
    expect(press(state, "q", "q").exit).toBe(true);
  });

  it("finds text, and Esc in the search box cancels the search rather than the pager", () => {
    let state = press(initialPagerState(text, 10), "home").state;
    state = press(state, "/", "/").state;
    for (const character of "line 25") state = press(state, character === " " ? "space" : character, character).state;
    const searchEscape = press(state, "escape");
    expect(searchEscape.exit).toBeUndefined();
    state = press(state, "return").state;
    expect(state.lines[state.top]).toBe("line 25");
  });

  it("says how to leave on its key bar", () => {
    const frame = composePagerFrame(initialPagerState(text, 10), 80);
    expect(frame.at(-1)!.text).toContain("Esc back");
    expect(frame[0].text).toContain("41-50 of 50");
    expect(frame).toHaveLength(12);
  });
});
