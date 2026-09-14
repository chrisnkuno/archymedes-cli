import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Modules allowed to name raw colours: the escape table itself and the theme that maps roles onto it. */
export const THEME_ALLOWLIST = new Set(["ansi.ts", "theme.ts"]);
export const LARGE_FILE_LINES = 800;

export type Metrics = { themeLeaks: Record<string, number>; largeFiles: Record<string, number>; layering?: Record<string, number>; duplicateHelpers?: Record<string, number>; unwired?: Record<string, number> };
export type GuardFinding = { guard: "theme" | "size" | "layering" | "helpers" | "unwired"; file: string; baseline: number; current: number };
/** Section → sections it may import. A file's section is its first directory under the source root; anything else is unrestricted. */
export type SectionRules = Record<string, readonly string[]>;

const COLOUR_NAME = /\b(?:RED|GREEN|YELLOW|BLUE|MAGENTA|CYAN|GREY)\b/g;
const COLOUR_ESCAPE = /\\x1b\[(?:3[0-7]|9[0-7])m/g;
const WIDGET_COLOUR = /\bcolor\s*:\s*["'](?:red|green|yellow|blue|magenta|cyan|gr[ae]y|white)["']/g;

/** Hardcoded foreground colours: ANSI constants, raw `\x1b[3Xm` literals, or widget `color: "red"`, all of which ignore `/theme`. */
export function countThemeLeaks(source: string): number {
  return [COLOUR_NAME, COLOUR_ESCAPE, WIDGET_COLOUR].reduce((sum, pattern) => sum + (source.match(pattern)?.length ?? 0), 0);
}

const HELPER_DECLARATION = /^(?:export\s+)?(?:const|function)\s+(?:RESET|BOLD|DIM|ITALIC|UNDERLINE|REVERSE|STRIKE|paint|paintAll|visibleWidth|clipTo)\b/gm;
/** Owners of the shared escape and width helpers; a declaration anywhere else is a private copy. */
export const HELPER_OWNERS = new Set(["ansi.ts", "text-width.ts"]);

export function countHelperCopies(source: string): number {
  return source.match(HELPER_DECLARATION)?.length ?? 0;
}

export function countLines(source: string): number {
  return source === "" ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
}

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const RELATIVE_IMPORT = /(?:from\s+|import\s*\(\s*|^import\s+)["'](\.{1,2}\/[^"']+)["']/gm;

export function sectionOf(relativeToSource: string, rules: SectionRules): string | undefined {
  const [first, ...rest] = relativeToSource.split("/");
  return rest.length > 0 && first in rules ? first : undefined;
}

/** Imports from `file` (a path relative to the source root) into sections its own section may not depend on. */
export function countLayeringViolations(file: string, source: string, rules: SectionRules): number {
  const from = sectionOf(file, rules);
  if (!from) return 0;
  let violations = 0;
  for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    const to = sectionOf(target, rules);
    if (to && !rules[from].includes(to)) violations++;
  }
  return violations;
}

const EXPORTED_NAME = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
const isTestPath = (file: string) => /\.test\.tsx?$/.test(file) || /(^|\/)pty\//.test(file);

/**
 * Exports that no product code reaches: not another source file, not a consumer root such as
 * `tooling/dev`, and not their own module. Usually a finished component that was never wired in.
 * `allow` names deliberate exceptions as "path/in/source.ts:name".
 */
export function findUnwiredExports(sources: Readonly<Record<string, string>>, consumers: readonly string[] = [], allow: ReadonlySet<string> = new Set()): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  const files = Object.keys(sources);
  for (const file of files) {
    if (isTestPath(file)) continue;
    for (const [, name] of sources[file].matchAll(EXPORTED_NAME)) {
      if (allow.has(`${file}:${name}`)) continue;
      const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
      const ownUses = (sources[file].match(word)?.length ?? 0) - 1;
      const reached = ownUses > 0
        || files.some((other) => other !== file && !isTestPath(other) && word.test(sources[other]))
        || consumers.some((text) => word.test(text));
      word.lastIndex = 0;
      if (!reached) (found[file] ??= []).push(name);
    }
  }
  return found;
}

export function readTree(root: string, filter: (file: string) => boolean = () => true): Record<string, string> {
  const tree: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) { if (entry !== "node_modules") walk(full); }
      else if (/\.tsx?$/.test(entry)) {
        const relative = path.relative(root, full).split(path.sep).join("/");
        if (filter(relative)) tree[relative] = readFileSync(full, "utf8");
      }
    }
  };
  walk(root);
  return tree;
}

export function collectMetrics(repoRoot: string, sourceRoot: string, rules: SectionRules = {}): Metrics {
  const metrics: Metrics = { themeLeaks: {}, largeFiles: {}, layering: {}, duplicateHelpers: {} };
  for (const file of sourceFiles(path.join(repoRoot, sourceRoot)).sort()) {
    const relative = path.relative(repoRoot, file).split(path.sep).join("/");
    const source = readFileSync(file, "utf8");
    if (!THEME_ALLOWLIST.has(path.basename(file))) {
      const leaks = countThemeLeaks(source);
      if (leaks > 0) metrics.themeLeaks[relative] = leaks;
    }
    const lines = countLines(source);
    if (lines > LARGE_FILE_LINES) metrics.largeFiles[relative] = lines;
    const inSource = path.relative(path.join(repoRoot, sourceRoot), file).split(path.sep).join("/");
    const layering = countLayeringViolations(inSource, source, rules);
    if (layering > 0) metrics.layering![relative] = layering;
    const copies = HELPER_OWNERS.has(path.basename(file)) ? 0 : countHelperCopies(source);
    if (copies > 0) metrics.duplicateHelpers![relative] = copies;
  }
  return metrics;
}

/** Ratchet: a count may fall or stay, never rise, and a file absent from the baseline starts at zero. */
export function compareToBaseline(baseline: Metrics, current: Metrics): { regressions: GuardFinding[]; improvements: GuardFinding[] } {
  const regressions: GuardFinding[] = [];
  const improvements: GuardFinding[] = [];
  const check = (guard: GuardFinding["guard"], before: Record<string, number>, after: Record<string, number>, floor: number) => {
    for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const was = before[file] ?? floor;
      const now = after[file] ?? floor;
      if (now > was) regressions.push({ guard, file, baseline: was, current: now });
      else if (now < was) improvements.push({ guard, file, baseline: was, current: now });
    }
  };
  check("theme", baseline.themeLeaks, current.themeLeaks, 0);
  check("size", baseline.largeFiles, current.largeFiles, LARGE_FILE_LINES);
  check("layering", baseline.layering ?? {}, current.layering ?? {}, 0);
  check("helpers", baseline.duplicateHelpers ?? {}, current.duplicateHelpers ?? {}, 0);
  check("unwired", baseline.unwired ?? {}, current.unwired ?? {}, 0);
  return { regressions, improvements };
}
