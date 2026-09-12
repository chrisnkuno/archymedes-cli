import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnArchymedes, type ArchymedesProcess } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * Installed-journey timings, measured through the real terminal binary.
 *
 * `reliability/latest.json` grades a model's answers; this measures the *product* around them —
 * how long a person waits for a usable prompt, for a first edit to land, for a turn to finish and
 * be gradeable, for a cancel to take, and for a resumed session to come back. The model is the SSE
 * stub (`anthropic-stub.ts`), scripted identically on every run, so a change in these numbers is a
 * change in Archymedes, not in a provider or a network. That is the whole point: these are
 * regression evidence, not a comparison against other tools.
 *
 * Every journey is one cold `bun run archymedes` under a pseudo-terminal. `bun` startup and Node
 * module load are inside the measurement on purpose — they are inside the wait a real user has.
 * A few ms of local fixture setup (a throwaway config dir, the in-process stub server) sits inside
 * the first-prompt number too; it is constant across runs, so it does not move the regression signal.
 */

const PROMPT = /›|auto >/;
const ANTHROPIC_TEST_KEY = "sk-test-fake";
const plain = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

export type JourneyName = "first-prompt" | "first-edit" | "verified-turn" | "cancel" | "resume";
export type RepoSize = "small" | "large";

export type JourneySample = { journey: JourneyName; repo: RepoSize; ms: number };

export type JourneyStat = {
  journey: JourneyName;
  repo: RepoSize;
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  /** A generous ceiling that catches a structural regression, not a slow shared machine. */
  budgetMs: number;
  status: "pass" | "fail";
};

export type JourneyReport = {
  generatedAt: string;
  harness: "pty + anthropic-stub";
  deterministic: true;
  node: string;
  platform: string;
  arch: string;
  /** Named so nobody reads these as a comparative industry benchmark. */
  model: "stub";
  repos: Record<RepoSize, { files: number }>;
  samplesPerJourney: number;
  journeys: JourneyStat[];
};

/**
 * Coarse ceilings — a structural-regression trip wire, not a target. Observed p95 on a warm
 * developer machine is a few hundred ms per journey; these sit ~20x above that so a cold CI
 * runner passes, while a change that turns a sub-second journey into a multi-second one does not.
 */
const BUDGETS_MS: Record<JourneyName, { small: number; large: number }> = {
  "first-prompt": { small: 6_000, large: 7_000 },
  "first-edit": { small: 7_000, large: 8_000 },
  "verified-turn": { small: 9_000, large: 10_000 },
  cancel: { small: 2_500, large: 2_500 },
  resume: { small: 8_000, large: 9_000 },
};

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

async function makeRepo(size: RepoSize): Promise<{ dir: string; files: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `archymedes-journey-${size}-`));
  // A real project, so the walk, the ignore rules and the checkpoint path are all exercised.
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "bench@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "bench"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), `# ${size} fixture\n`);
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: `${size}-fixture`, private: true }, null, 2));
  const modules = size === "large" ? 40 : 2;
  const perModule = size === "large" ? 15 : 2;
  let files = 2;
  for (let m = 0; m < modules; m += 1) {
    const moduleDir = path.join(dir, "src", `module-${m}`);
    await mkdir(moduleDir, { recursive: true });
    for (let f = 0; f < perModule; f += 1) {
      await writeFile(path.join(moduleDir, `file-${f}.ts`), `export const id${m}_${f} = ${m * 100 + f};\n`);
      files += 1;
    }
  }
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "fixture"], { cwd: dir });
  return { dir, files };
}

type Session = {
  proc: ArchymedesProcess;
  stub: AnthropicStub;
  configDir: string;
  cwd: string;
  dispose: () => Promise<void>;
};

async function boot(cwd: string, extraArgs: string[] = [], sharedConfigDir?: string): Promise<Session> {
  const stub = await startAnthropicStub();
  // A resume journey boots twice and the second process must read the first's history, so the
  // caller can pin the config directory; every other journey gets a throwaway one.
  const configDir = sharedConfigDir ?? await mkdtemp(path.join(os.tmpdir(), "archymedes-journey-config-"));
  const ownsConfigDir = sharedConfigDir === undefined;
  const proc = spawnArchymedes({
    cwd,
    cols: 100,
    rows: 34,
    args: ["--currency", "USD", "--auto", ...extraArgs],
    env: {
      ANTHROPIC_API_KEY: ANTHROPIC_TEST_KEY,
      ANTHROPIC_BASE_URL: stub.url,
      ARCHYMEDES_CONFIG_DIR: configDir,
      ARCHYMEDES_FX_OFFLINE: "true",
      TZ: "UTC",
    },
  });
  return {
    proc,
    stub,
    configDir,
    cwd,
    dispose: async () => {
      proc.kill();
      await stub.close();
      if (ownsConfigDir) await rm(configDir, { recursive: true, force: true });
    },
  };
}

async function runOnce(journey: JourneyName, repoDir: string): Promise<number> {
  if (journey === "first-prompt") {
    const t0 = performance.now();
    const session = await boot(repoDir);
    try {
      await session.proc.waitFor(PROMPT, { timeoutMs: 40_000 });
      return performance.now() - t0;
    } finally {
      await session.dispose();
    }
  }

  if (journey === "resume") {
    const sharedConfigDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-journey-resume-config-"));
    const first = await boot(repoDir, [], sharedConfigDir);
    try {
      await first.proc.waitFor(PROMPT, { timeoutMs: 40_000 });
      first.stub.enqueue({ kind: "text", text: "The note lives in note.txt." });
      const mark = first.proc.output().length;
      first.proc.writeLine("where does the note live");
      await first.proc.waitFor(/note\.txt/, { timeoutMs: 40_000, since: mark });
      // The session is only written to disk once the turn ends, so wait for the prompt to return
      // before leaving. Ctrl+C at an idle prompt is the clean way out.
      await first.proc.waitFor(PROMPT, { timeoutMs: 20_000, since: mark });
      first.proc.write("\x03");
      await first.proc.waitForExit(20_000).catch(() => first.proc.kill());
    } finally {
      await first.dispose();
    }
    const t0 = performance.now();
    const second = await boot(repoDir, ["--resume"], sharedConfigDir);
    try {
      await second.proc.waitFor(PROMPT, { timeoutMs: 40_000 });
      // Resume is only real if the earlier turn came back with it.
      if (!plain(second.proc.output()).includes("where does the note live")) {
        throw new Error("resumed session did not restore the prior transcript");
      }
      return performance.now() - t0;
    } finally {
      await second.dispose();
      await rm(sharedConfigDir, { recursive: true, force: true });
    }
  }

  const session = await boot(repoDir);
  try {
    await session.proc.waitFor(PROMPT, { timeoutMs: 40_000 });

    if (journey === "first-edit") {
      session.stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "added.ts", content: "export const added = true;\n" } });
      session.stub.enqueue({ kind: "text", text: "Added the file." });
      const mark = session.proc.output().length;
      const t0 = performance.now();
      session.proc.writeLine("add a small module");
      await session.proc.waitFor(/new file|added\.ts/, { timeoutMs: 40_000, since: mark });
      return performance.now() - t0;
    }

    if (journey === "verified-turn") {
      session.stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "sum.ts", content: "export const sum = (a: number, b: number) => a + b;\n" } });
      session.stub.enqueue({ kind: "tool_call", toolName: "run_command", input: { command: "true" }, text: "Checking it." });
      session.stub.enqueue({ kind: "text", text: "Done and checked." });
      const mark = session.proc.output().length;
      const t0 = performance.now();
      session.proc.writeLine("add sum and verify");
      await session.proc.waitFor(/turn complete|needs attention|verification (needed|not run)/, { timeoutMs: 40_000, since: mark });
      return performance.now() - t0;
    }

    // cancel: a long stream, interrupted; measured from Ctrl+C to a usable prompt.
    session.stub.enqueue({ kind: "text", text: "streaming ".repeat(400), chunkSize: 12, chunkDelayMs: 200 });
    const mark = session.proc.output().length;
    session.proc.writeLine("explain slowly");
    await session.proc.waitFor(/streaming streaming/, { timeoutMs: 20_000, since: mark });
    const afterStream = session.proc.output().length;
    const t0 = performance.now();
    session.proc.write("\x03");
    await session.proc.waitFor(/interrupted/i, { timeoutMs: 10_000, since: afterStream });
    await session.proc.waitFor(PROMPT, { timeoutMs: 15_000, since: session.proc.output().length });
    return performance.now() - t0;
  } finally {
    await session.dispose();
  }
}

export type MeasureOptions = {
  repos?: RepoSize[];
  journeys?: JourneyName[];
  samples?: number;
  /** Called after each sample, for progress output on a slow full run. */
  onSample?: (sample: JourneySample) => void;
};

export async function measureJourneys(options: MeasureOptions = {}): Promise<JourneyReport> {
  const repos = options.repos ?? ["small", "large"];
  const journeys = options.journeys ?? ["first-prompt", "first-edit", "verified-turn", "cancel", "resume"];
  const samples = Math.max(1, options.samples ?? 5);

  const repoDirs = {} as Record<RepoSize, { dir: string; files: number }>;
  for (const size of repos) repoDirs[size] = await makeRepo(size);

  const stats: JourneyStat[] = [];
  try {
    for (const repo of repos) {
      for (const journey of journeys) {
        const measured: number[] = [];
        for (let i = 0; i < samples; i += 1) {
          const ms = await runOnce(journey, repoDirs[repo].dir);
          measured.push(ms);
          options.onSample?.({ journey, repo, ms });
        }
        const sorted = [...measured].sort((a, b) => a - b);
        const budgetMs = BUDGETS_MS[journey][repo];
        const p95Ms = Math.round(percentile(sorted, 0.95));
        stats.push({
          journey,
          repo,
          samples,
          minMs: Math.round(sorted[0]),
          p50Ms: Math.round(percentile(sorted, 0.5)),
          p95Ms,
          budgetMs,
          status: p95Ms <= budgetMs ? "pass" : "fail",
        });
      }
    }
  } finally {
    for (const size of repos) await rm(repoDirs[size].dir, { recursive: true, force: true });
  }

  return {
    generatedAt: new Date().toISOString(),
    harness: "pty + anthropic-stub",
    deterministic: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    model: "stub",
    repos: Object.fromEntries(repos.map((size) => [size, { files: repoDirs[size].files }])) as Record<RepoSize, { files: number }>,
    samplesPerJourney: samples,
    journeys: stats,
  };
}
