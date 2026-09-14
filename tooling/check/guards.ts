import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Modules allowed to name raw colours: the escape table itself and the theme that maps roles onto it. */
export const THEME_ALLOWLIST = new Set(["ansi.ts", "theme.ts"]);
export const LARGE_FILE_LINES = 800;

export type Metrics = { themeLeaks: Record<string, number>; largeFiles: Record<string, number> };
export type GuardFinding = { guard: "theme" | "size"; file: string; baseline: number; current: number };

const COLOUR_NAME = /\b(?:RED|GREEN|YELLOW|BLUE|MAGENTA|CYAN|GREY)\b/g;
const COLOUR_ESCAPE = /\\x1b\[(?:3[0-7]|9[0-7])m/g;
const WIDGET_COLOUR = /\bcolor\s*:\s*["'](?:red|green|yellow|blue|magenta|cyan|gr[ae]y|white)["']/g;

/** Hardcoded foreground colours: ANSI constants, raw `\x1b[3Xm` literals, or widget `color: "red"`, all of which ignore `/theme`. */
export function countThemeLeaks(source: string): number {
  return [COLOUR_NAME, COLOUR_ESCAPE, WIDGET_COLOUR].reduce((sum, pattern) => sum + (source.match(pattern)?.length ?? 0), 0);
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

export function collectMetrics(repoRoot: string, sourceRoot: string): Metrics {
  const metrics: Metrics = { themeLeaks: {}, largeFiles: {} };
  for (const file of sourceFiles(path.join(repoRoot, sourceRoot)).sort()) {
    const relative = path.relative(repoRoot, file).split(path.sep).join("/");
    const source = readFileSync(file, "utf8");
    if (!THEME_ALLOWLIST.has(path.basename(file))) {
      const leaks = countThemeLeaks(source);
      if (leaks > 0) metrics.themeLeaks[relative] = leaks;
    }
    const lines = countLines(source);
    if (lines > LARGE_FILE_LINES) metrics.largeFiles[relative] = lines;
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
  return { regressions, improvements };
}
