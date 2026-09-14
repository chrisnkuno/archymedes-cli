import { describe, expect, it } from "vitest";
import { compareToBaseline, countHelperCopies, findUnwiredExports, countLayeringViolations, countLines, countThemeLeaks, LARGE_FILE_LINES, sectionOf } from "./guards";

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

  it("counts imports that point against the section matrix, leaving root and unknown directories unrestricted", () => {
    const rules = { text: ["text"], render: ["render", "text"], ui: ["ui", "render", "text"] };
    const source = `import { a } from "../text/ansi";\nimport { b } from "../ui/chooser";\nconst c = await import("./markdown");\nimport x from "@archymedes/core";`;
    expect(sectionOf("render/sections.ts", rules)).toBe("render");
    expect(sectionOf("archymedes.ts", rules)).toBeUndefined();
    expect(sectionOf("pty/harness.ts", rules)).toBeUndefined();
    expect(countLayeringViolations("render/sections.ts", source, rules)).toBe(1);
    expect(countLayeringViolations("archymedes.ts", `import { b } from "./ui/chooser";`, rules)).toBe(0);
    expect(countLayeringViolations("text/ansi.ts", `import { b } from "../render/banner";`, rules)).toBe(1);
  });

  it("counts private copies of the shared escape and width helpers", () => {
    expect(countHelperCopies(`const RESET = "x";\nfunction paint(a) {}\nexport function visibleWidth() {}\nconst paintRgb = 1;\n  const DIM = 2;`)).toBe(3);
  });

  it("finds exports only tests reach, counting own-module use, consumers and the allowlist as wired", () => {
    const sources = {
      "render/picture.ts": "export function renderGlyph() {}\nexport function helper() {}\nexport const used = helper();\nexport function demoOnly() {}\nexport function allowed() {}",
      "render/picture.test.ts": "renderGlyph(); used; allowed();",
      "app/cat.ts": "import { used } from '../render/picture';",
      "pty/harness.ts": "renderGlyph();",
    };
    expect(findUnwiredExports(sources, ["demoOnly()"], new Set(["render/picture.ts:allowed"]))).toEqual({ "render/picture.ts": ["renderGlyph"] });
  });

  it("fails on growth, reports shrinkage, and treats new files from zero or the size threshold", () => {
    const baseline = { themeLeaks: { "a.ts": 3 }, largeFiles: { "big.ts": 900 } };
    const current = { themeLeaks: { "a.ts": 1, "new.ts": 1 }, largeFiles: { "big.ts": 950, "grown.ts": LARGE_FILE_LINES + 1 } };
    const { regressions, improvements } = compareToBaseline(baseline, current);
    expect(regressions.map((f) => `${f.guard}:${f.file}`).sort()).toEqual(["size:big.ts", "size:grown.ts", "theme:new.ts"]);
    expect(improvements).toEqual([{ guard: "theme", file: "a.ts", baseline: 3, current: 1 }]);
  });
});
