import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { countLines, LARGE_FILE_LINES, type Metrics } from "./guards";

/**
 * Guards beyond `packages/friday-cli`, counted like its own (per file, ratcheted in baseline.json):
 * the size line over `packages/core/src` and the Go code, imports between internal/ packages the
 * package matrix (go-sections.json) does not allow, and internal/tui files outside every section.
 */

/** Source trees the size guard reads besides the CLI's own, with the files it counts there. */
export const SIZE_ROOTS: ReadonlyArray<{ root: string; file: RegExp }> = [
  { root: "packages/core/src", file: /(?<!\.test)\.tsx?$/ },
  { root: "internal", file: /(?<!_test)\.go$/ },
  { root: "cmd", file: /(?<!_test)\.go$/ },
];

export type GoSections = { packages: Record<string, readonly string[]>; tui: Record<string, string> };

const MODULE = "github.com/chrisnkuno/friday-cli/internal/";
const INTERNAL_IMPORT = new RegExp(`"${MODULE.replace(/[./]/g, "\\$&")}([a-z0-9_]+(?:/[a-z0-9_]+)?)`, "g");

/**
 * The section a path or import names: `internal/<pkg>`, except under `internal/core`, where the Go
 * engine's packages are sections of their own (`core/loop`, `core/policy`), so its layering is
 * held to as well (docs/continuation/GO_ENGINE.md).
 */
function goSection(path: string): string {
  const [first, second] = path.split("/");
  return first === "core" && second ? `core/${second}` : first!;
}

/** Go files under root, relative to the repository, tests included when asked. */
export function goFiles(repoRoot: string, root: string, tests = false): string[] {
  return walk(repoRoot, root, (name) => name.endsWith(".go") && (tests || !name.endsWith("_test.go")));
}

/** Imports of other internal/ packages that `file`'s package may not make. Files outside internal/ are unrestricted. */
export function countGoLayering(file: string, source: string, packages: GoSections["packages"]): number {
  const path = /^internal\/([a-z0-9_]+(?:\/[a-z0-9_]+)?)\//.exec(file)?.[1];
  if (!path) return 0;
  const own = goSection(path);
  const allowed = new Set([own, ...(packages[own] ?? [])]);
  let violations = 0;
  for (const match of source.matchAll(INTERNAL_IMPORT)) if (!allowed.has(goSection(match[1]!))) violations += 1;
  return violations;
}

/** The section an internal/tui file belongs to, by its prefix; undefined when it has none. */
export function tuiSectionOf(file: string, sections: GoSections["tui"]): string | undefined {
  const name = path.posix.basename(file);
  if (name.endsWith("_test.go") && name.startsWith("suite_")) return "suite";
  return Object.keys(sections).find((section) => name.startsWith(`${section}_`));
}

/** The repository-wide counts, merged into the CLI's metrics by recheck. */
export function collectRepoMetrics(repoRoot: string, sections: GoSections): Required<Pick<Metrics, "largeFiles" | "goLayering" | "unsectioned">> {
  const metrics = { largeFiles: {} as Record<string, number>, goLayering: {} as Record<string, number>, unsectioned: {} as Record<string, number> };
  for (const { root, file: counted } of SIZE_ROOTS) {
    for (const file of walk(repoRoot, root, (name) => counted.test(name))) {
      const lines = countLines(readFileSync(path.join(repoRoot, file), "utf8"));
      if (lines > LARGE_FILE_LINES) metrics.largeFiles[file] = lines;
    }
  }
  for (const file of goFiles(repoRoot, "internal", true)) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    const layering = countGoLayering(file, source, sections.packages);
    if (layering > 0) metrics.goLayering[file] = layering;
    if (file.startsWith("internal/tui/") && !tuiSectionOf(file, sections.tui)) metrics.unsectioned[file] = 1;
  }
  return metrics;
}

function walk(repoRoot: string, root: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) { if (entry !== "node_modules" && entry !== "testdata") visit(full); }
      else if (keep(entry)) found.push(path.relative(repoRoot, full).split(path.sep).join("/"));
    }
  };
  visit(path.join(repoRoot, root));
  return found.sort();
}
