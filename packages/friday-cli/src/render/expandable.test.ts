import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS } from "../text/glyphs";
import { ExpandableStore, expandHint } from "./expandable";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("the fold store", () => {
  it("hands out ids that never repeat, so a printed hint stays valid", () => {
    const store = new ExpandableStore();
    const first = store.add("a", "A", 1);
    const second = store.add("b", "B", 2);
    expect(second).toBe(first + 1);
    expect(store.get(first)?.full).toBe("A");
    expect(store.get(second)?.label).toBe("b");
  });

  it("keeps the whole text, which is the difference between folding and truncating", () => {
    const store = new ExpandableStore();
    const full = Array.from({ length: 500 }, (_unused, index) => `line ${index}`).join("\n");
    const id = store.add("big", full, 486);
    expect(store.get(id)?.full).toBe(full);
  });

  it("bounds what it holds, and drops the oldest — never the block still on screen", () => {
    const store = new ExpandableStore();
    for (let index = 0; index < 100; index += 1) store.add(`entry ${index}`, "x", 1);
    expect(store.size).toBeLessThanOrEqual(64);
    expect(store.last?.label).toBe("entry 99");
    // Ids stay meaningful even after eviction: an old one simply resolves to nothing.
    expect(store.get(1)).toBeUndefined();
  });

  it("forgets everything when the thread does", () => {
    const store = new ExpandableStore();
    store.add("a", "A", 1);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.last).toBeUndefined();
  });
});

describe("what the reader is offered", () => {
  it("names the id in the hint, so expanding needs no counting back up the screen", () => {
    expect(plain(expandHint(7, 42, "none"))).toContain("/expand 7");
    expect(plain(expandHint(7, 42, "none"))).toContain("42 more lines");
  });

  it("says line rather than lines when there is one", () => {
    expect(plain(expandHint(1, 1, "none"))).toContain("1 more line ");
  });

  it("draws the hint in ASCII when the glyph set says so", () => {
    expect(expandHint(1, 2, "none", ASCII_GLYPHS)).not.toMatch(/[▸·]/);
  });
});
