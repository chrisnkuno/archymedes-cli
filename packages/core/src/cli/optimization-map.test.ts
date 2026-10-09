import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPTIMIZATION_TARGETS,
  describeBudget,
  judgeMeasurement,
  runOptimizationProbes,
  type OptimizationTarget,
  type ProbeResult,
} from "./optimization-map";

/**
 * The map, checked against the code it describes.
 *
 * This is the mechanism that makes the optimization map continuous rather than a snapshot: every
 * measurable target is measured on every run of the suite, so a change that quietly spends a
 * thousand more tokens per request fails here instead of being noticed in a bill three weeks later.
 */

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function describeFailure(result: ProbeResult): string {
  // The applied budget, not the target's static one: a probe may narrow it to the variant it
  // actually measured (see `Measurement`), and printing the wrong bound in the failure that
  // reports it would send the reader after a regression that did not happen.
  const applied = result.budget ?? result.target.budget;
  const bound = applied === result.target.budget
    ? describeBudget(result.target)
    : [applied.max !== undefined ? `<= ${applied.max}` : "", applied.min !== undefined ? `>= ${applied.min}` : ""]
      .filter(Boolean).join(" and ") + ` ${result.target.metric}`;
  return `${result.target.id}: measured ${result.measured}, budget ${bound}`
    + `${result.detail ? ` (${result.detail})` : ""}\n  → ${result.target.remediation}`;
}

describe("the optimization map", () => {
  it("holds every budget it claims to hold", { timeout: 120_000 }, async () => {
    const results = await runOptimizationProbes({ root: repositoryRoot });
    const broken = results.filter((result) => result.status === "fail" || result.status === "error");
    expect(broken.map(describeFailure), "an optimization budget regressed").toEqual([]);
    // A map where nothing is actually measured would pass this vacuously.
    expect(results.filter((result) => result.status === "pass").length).toBeGreaterThanOrEqual(8);
  });

  it("judges a probe against the variant it actually measured", async () => {
    // `cli.grep-latency` measures ripgrep when it is installed and the JavaScript walker when it is
    // not — different operations with different costs. Before probes could narrow their own budget,
    // a machine without ripgrep failed this target for a reason no change here could fix.
    const [result] = await runOptimizationProbes({ root: repositoryRoot }, ["cli.grep-latency"]);
    expect(result.status).toBe("pass");
    expect(result.detail).toBeTruthy();
    const applied = result.budget ?? result.target.budget;
    const viaRipgrep = result.detail!.startsWith("ripgrep");
    expect(applied.max).toBe(viaRipgrep ? result.target.budget.max : 1_000);
  }, 120_000);

  it("describes every target well enough for someone to act on a failure", () => {
    for (const target of OPTIMIZATION_TARGETS) {
      expect(target.id, "ids are addressable").toMatch(/^[a-z]+\.[a-z0-9.-]+$/);
      expect(target.what.length, target.id).toBeGreaterThan(20);
      expect(target.metric.length, target.id).toBeGreaterThan(2);
      expect(target.evidence.length, target.id).toBeGreaterThan(5);
      // The remediation is what makes a failing target actionable by a person or by Archymedes itself,
      // so it must say what to do — not merely restate the measurement.
      expect(target.remediation.length, target.id).toBeGreaterThan(60);
      expect(
        target.budget.max !== undefined || target.budget.min !== undefined,
        `${target.id} needs a bound to be checkable`,
      ).toBe(true);
    }
    expect(new Set(OPTIMIZATION_TARGETS.map((target) => target.id)).size).toBe(OPTIMIZATION_TARGETS.length);
  });

  it("reports an un-probed target as unmeasured rather than as passing", async () => {
    const unprobed = OPTIMIZATION_TARGETS.filter((target) => !target.measure).map((target) => target.id);
    const results = await runOptimizationProbes({ root: repositoryRoot }, unprobed);
    // A map that quietly counted "no probe" as "fine" would drift into decoration.
    expect(results.every((result) => result.status === "unmeasured")).toBe(true);
  });

  it("fails a target whose budget is broken, rather than reporting the number and moving on", async () => {
    // Mutation check on the mechanism itself: a probe that cannot fail is not a guardrail.
    const impossible = {
      ...OPTIMIZATION_TARGETS[0],
      id: "prompt.impossible-budget",
      budget: { max: 1 },
    };
    const [result] = await runProbeDirectly(impossible);
    expect(result.status).toBe("fail");
    expect(result.measured).toBeGreaterThan(1);
  });
});

/**
 * Runs one ad-hoc target through the same comparison the registry uses.
 *
 * `judgeMeasurement` is imported rather than reimplemented: this helper used to carry its own copy
 * of the two-line budget check, and that copy silently stopped matching the runner the moment a
 * probe could narrow its own budget.
 */
async function runProbeDirectly(target: OptimizationTarget): Promise<ProbeResult[]> {
  return [judgeMeasurement(target, await target.measure!({ root: repositoryRoot }))];
}
