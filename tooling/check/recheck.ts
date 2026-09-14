import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectMetrics, compareToBaseline, findUnwiredExports, readTree, type Metrics, type SectionRules } from "./guards";

/**
 * `bun run recheck` — the loop run after every change.
 *   guards → typecheck → tests related to changed files (unit project)
 * Flags: --pty also runs every terminal test; --all runs the whole suite instead of related tests;
 * --full runs `release:check`; --update-baseline accepts current guard counts (say why in TRACKER.md);
 * --unwired lists exports no product code reaches.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BASELINE = path.join(HERE, "baseline.json");
const args = new Set(process.argv.slice(2));
const results: Array<{ step: string; ok: boolean; detail: string }> = [];

function run(step: string, command: string, commandArgs: string[]): boolean {
  const started = Date.now();
  process.stdout.write(`\n▸ ${step}: ${command} ${commandArgs.join(" ")}\n`);
  const outcome = spawnSync(command, commandArgs, { cwd: REPO, stdio: "inherit" });
  const ok = outcome.status === 0;
  results.push({ step, ok, detail: `${((Date.now() - started) / 1000).toFixed(1)}s` });
  return ok;
}

function changedFiles(): string[] {
  const git = (gitArgs: string[]) => spawnSync("git", gitArgs, { cwd: REPO, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const files = new Set([...git(["diff", "--name-only", "HEAD"]), ...git(["ls-files", "--others", "--exclude-standard"])]);
  return [...files].filter((file) => /\.(ts|tsx)$/.test(file) && existsSync(path.join(REPO, file)));
}

const sectionConfig = JSON.parse(readFileSync(path.join(HERE, "sections.json"), "utf8")) as { sourceRoot: string; allowed: SectionRules };
const current = collectMetrics(REPO, sectionConfig.sourceRoot, sectionConfig.allowed);
{
  const allow = JSON.parse(readFileSync(path.join(HERE, "unwired-allow.json"), "utf8")) as Record<string, string>;
  const sources = readTree(path.join(REPO, sectionConfig.sourceRoot));
  const consumers = Object.values(readTree(path.join(REPO, "tooling/dev")));
  const unwired = findUnwiredExports(sources, consumers, new Set(Object.keys(allow)));
  current.unwired = Object.fromEntries(Object.entries(unwired).map(([file, names]) => [`${sectionConfig.sourceRoot}/${file}`, names.length]));
  if (args.has("--unwired")) for (const [file, names] of Object.entries(unwired)) console.log(`  unwired ${file}: ${names.join(", ")}`);
}
if (args.has("--update-baseline") || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Baseline written to ${path.relative(REPO, BASELINE)}.`);
}
const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Metrics;
const { regressions, improvements } = compareToBaseline(baseline, current);
for (const f of improvements) console.log(`  ✓ ${f.guard} ${f.file}: ${f.baseline} → ${f.current} (run --update-baseline to lock in)`);
for (const f of regressions) console.log(`  ✗ ${f.guard} ${f.file}: ${f.baseline} → ${f.current}`);
const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, n) => sum + n, 0);
results.push({
  step: "guards",
  ok: regressions.length === 0,
  detail: `theme leaks ${total(current.themeLeaks)}; layering ${total(current.layering ?? {})}; helper copies ${total(current.duplicateHelpers ?? {})}; unwired ${total(current.unwired ?? {})}; ${Object.keys(current.largeFiles).length} files over the size line`,
});

let ok = regressions.length === 0;
if (args.has("--full")) ok = run("release:check", "bun", ["run", "release:check"]) && ok;
else {
  ok = run("typecheck", "bun", ["run", "typecheck"]) && ok;
  if (args.has("--all")) ok = run("tests", "bunx", ["vitest", "run"]) && ok;
  else {
    const changed = changedFiles();
    if (changed.length === 0) results.push({ step: "tests", ok: true, detail: "no changed TypeScript files" });
    else ok = run(`unit tests related to ${changed.length} changed files`, "bunx", ["vitest", "related", "--run", "--passWithNoTests", "--project", "unit", ...changed]) && ok;
    // Terminal tests spawn the CLI as a process rather than importing it, so `related` cannot select them.
    if (args.has("--pty")) ok = run("terminal (pty) tests", "bunx", ["vitest", "run", "--project", "pty"]) && ok;
  }
}

console.log("\nrecheck summary");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.step.padEnd(34)} ${r.detail}`);
process.exit(ok ? 0 : 1);
