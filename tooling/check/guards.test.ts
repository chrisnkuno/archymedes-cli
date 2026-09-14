import { describe, expect, it } from "vitest";
import { compareToBaseline, countLines, countThemeLeaks, LARGE_FILE_LINES } from "./guards";

describe("recheck guards", () => {
  it("counts named ANSI colours and raw colour escapes, but not weights or truecolor", () => {
    expect(countThemeLeaks(`import { CYAN, BOLD } from "./ansi"; paint(x, CYAN);`)).toBe(2);
    expect(countThemeLeaks(String.raw`const y = "\x1b[33m"; const g = "\x1b[92m";`)).toBe(2);
    expect(countThemeLeaks(String.raw`"\x1b[2m" "\x1b[1m" "\x1b[38;2;1;2;3m" palette.primary cyanish`)).toBe(0);
    expect(countThemeLeaks(`{ text, color: "red" } { color: colors.error } { titleColor: "green" }`)).toBe(1);
  });

  it("counts lines with or without a trailing newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
  });

  it("fails on growth, reports shrinkage, and treats new files from zero or the size threshold", () => {
    const baseline = { themeLeaks: { "a.ts": 3 }, largeFiles: { "big.ts": 900 } };
    const current = { themeLeaks: { "a.ts": 1, "new.ts": 1 }, largeFiles: { "big.ts": 950, "grown.ts": LARGE_FILE_LINES + 1 } };
    const { regressions, improvements } = compareToBaseline(baseline, current);
    expect(regressions.map((f) => `${f.guard}:${f.file}`).sort()).toEqual(["size:big.ts", "size:grown.ts", "theme:new.ts"]);
    expect(improvements).toEqual([{ guard: "theme", file: "a.ts", baseline: 3, current: 1 }]);
  });
});
