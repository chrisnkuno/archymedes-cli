import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LARGE_FILE_LINES } from "./guards";
import { collectRepoMetrics, countGoLayering, tuiSectionOf, type GoSections } from "./repo-guards";

const SECTIONS: GoSections = { packages: { theme: [], render: ["theme"], tui: ["render", "theme"] }, tui: { core: "", chat: "", app: "" } };
const imports = (...packages: string[]) => `import (\n${packages.map((name) => `\t"github.com/chrisnkuno/friday-cli/internal/${name}"`).join("\n")}\n)`;

describe("repository guards", () => {
  it("counts Go imports against the package matrix, leaving cmd/ unrestricted", () => {
    expect(countGoLayering("internal/render/mark.go", imports("theme"), SECTIONS.packages)).toBe(0);
    expect(countGoLayering("internal/theme/theme.go", imports("render", "tui"), SECTIONS.packages)).toBe(2);
    expect(countGoLayering("internal/render/x.go", imports("render", "acp"), SECTIONS.packages)).toBe(1);
    expect(countGoLayering("cmd/friday/main.go", imports("tui", "acp"), SECTIONS.packages)).toBe(0);
  });

  it("places a tui file by its prefix, cross-section tests in suite_, and nothing else", () => {
    expect(tuiSectionOf("internal/tui/chat_composer.go", SECTIONS.tui)).toBe("chat");
    expect(tuiSectionOf("internal/tui/app_changes_branches_test.go", SECTIONS.tui)).toBe("app");
    expect(tuiSectionOf("internal/tui/suite_invariants_test.go", SECTIONS.tui)).toBe("suite");
    expect(tuiSectionOf("internal/tui/suite_helpers.go", SECTIONS.tui)).toBeUndefined();
    expect(tuiSectionOf("internal/tui/composer.go", SECTIONS.tui)).toBeUndefined();
    expect(tuiSectionOf("internal/tui/chatty.go", SECTIONS.tui)).toBeUndefined();
  });

  it("collects sizes over core and Go, Go layering, and unsectioned tui files", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "repo-guards-"));
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), text);
    };
    const long = "x\n".repeat(LARGE_FILE_LINES + 5);
    write("packages/core/src/big.ts", long);
    write("packages/core/src/big.test.ts", long);
    write("internal/tui/core_model.go", long);
    write("internal/tui/stray.go", "package tui\n");
    write("internal/theme/theme.go", imports("tui"));
    write("cmd/friday/main.go", "package main\n");
    expect(collectRepoMetrics(repo, SECTIONS)).toEqual({
      largeFiles: { "packages/core/src/big.ts": LARGE_FILE_LINES + 5, "internal/tui/core_model.go": LARGE_FILE_LINES + 5 },
      goLayering: { "internal/theme/theme.go": 1 },
      unsectioned: { "internal/tui/stray.go": 1 },
    });
  });
});
