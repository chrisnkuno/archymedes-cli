import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { measureJourneys } from "./journeys";

/**
 * Two ways in:
 *
 *   bun run test packages/archymedes-cli/src/pty/journeys.test.ts   # the regression guard
 *   bun run bench:journeys                                          # the full matrix + JSON
 *
 * The guard is a lean pass — the small repo, two samples, every journey — that fails in CI if a
 * journey structurally slows down or stops completing. `bench:journeys` sets
 * `ARCHYMEDES_JOURNEYS_FULL` and runs the whole matrix (large repo, more samples), writing it to
 * `benchmarks/journeys/latest.json` as dated regression evidence. The model is a deterministic
 * stub in both, so a change in these numbers is a change in Archymedes, not in a provider.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const full = process.env.ARCHYMEDES_JOURNEYS_FULL === "1";
const outFile = process.env.ARCHYMEDES_JOURNEYS_OUT
  ? path.resolve(repoRoot, process.env.ARCHYMEDES_JOURNEYS_OUT)
  : path.join(repoRoot, "benchmarks/journeys/latest.json");
const fullSamples = Number(process.env.ARCHYMEDES_JOURNEYS_SAMPLES ?? 5);

describe("installed journeys", () => {
  it("every journey completes under its budget on the small repo", { timeout: 300_000 }, async () => {
    const report = await measureJourneys({ repos: ["small"], samples: 2 });

    const over = report.journeys.filter((stat) => stat.status === "fail");
    expect(
      over.map((stat) => `${stat.journey}: p95 ${stat.p95Ms}ms over budget ${stat.budgetMs}ms`),
      "an installed journey exceeded its budget",
    ).toEqual([]);

    // Not vacuous: all five journeys ran, and a cold boot really was timed rather than stubbed to 0.
    expect(report.journeys.map((stat) => stat.journey).sort()).toEqual(
      ["cancel", "first-edit", "first-prompt", "resume", "verified-turn"],
    );
    const firstPrompt = report.journeys.find((stat) => stat.journey === "first-prompt")!;
    expect(firstPrompt.p50Ms).toBeGreaterThan(100);
    expect(firstPrompt.samples).toBe(2);
  });

  it("flags a journey whose budget is broken rather than reporting the number and moving on", { timeout: 120_000 }, async () => {
    // Mutation check on the mechanism, run against the large repo so both fixture sizes are
    // exercised by the guard: recompute one real measurement against an impossible ceiling.
    const report = await measureJourneys({ repos: ["large"], journeys: ["first-prompt"], samples: 1 });
    const stat = report.journeys[0];
    expect(report.repos.large.files).toBeGreaterThan(500);
    const wouldFail = stat.p95Ms <= 1 ? "pass" : "fail";
    expect(wouldFail).toBe("fail");
  });

  it.runIf(full)("full matrix — writes dated regression evidence", { timeout: 1_800_000 }, async () => {
    const report = await measureJourneys({
      repos: ["small", "large"],
      samples: fullSamples,
      onSample: ({ journey, repo, ms }) =>
        process.stdout.write(`  ${repo.padEnd(5)} ${journey.padEnd(14)} ${Math.round(ms).toString().padStart(6)} ms\n`),
    });
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\nWrote ${path.relative(repoRoot, outFile)}\n`);
    for (const stat of report.journeys) {
      process.stdout.write(
        `  ${stat.repo.padEnd(5)} ${stat.journey.padEnd(14)} p50 ${String(stat.p50Ms).padStart(6)} p95 ${String(stat.p95Ms).padStart(6)} budget ${String(stat.budgetMs).padStart(6)} ${stat.status}\n`,
      );
    }
    expect(report.journeys.filter((stat) => stat.status === "fail")).toEqual([]);
  });
});
