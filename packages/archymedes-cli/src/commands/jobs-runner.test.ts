import type { Job } from "@archymedes/core/cli/jobs";
import { describe, expect, it } from "vitest";
import { UNICODE_GLYPHS } from "../text/glyphs";
import { runJobsCommand, type JobsContext } from "./jobs-runner";

function context(job: Partial<Job> | null, overrides: Partial<JobsContext> = {}) {
  const written: string[] = [];
  const signalled: number[] = [];
  const same = (text: string) => text;
  const ctx: JobsContext = {
    listJobs: async () => [],
    getJob: async () => job as Job | null,
    cancelJob: async () => ({ ok: job !== null }),
    resolveApproval: async (_id, _decision, digest) => digest === "d1",
    startJob: async () => ({ id: "job-1" }),
    signalWorker: (pid) => signalled.push(pid),
    write: (text) => written.push(text),
    paint: { dim: same, cyan: same, green: same, yellow: same, bold: same },
    glyphs: UNICODE_GLYPHS,
    width: 80,
    ...overrides,
  };
  return { ctx, written, signalled };
}

describe("/jobs", () => {
  it("cancels a job and signals the worker that held its lease", async () => {
    const { ctx, written, signalled } = context({ lease: { workerId: "host:4242" } } as Partial<Job>);
    await runJobsCommand({ kind: "cancel", id: "job-1" }, ctx);
    expect(signalled).toEqual([4242]);
    expect(written).toEqual(["  cancelled job-1.\n"]);
    const missing = context(null);
    await runJobsCommand({ kind: "cancel", id: "job-9" }, missing.ctx);
    expect(missing.written[0]).toContain("No job job-9 to cancel");
  });

  it("binds an approval to the action shown, and says when it changed", async () => {
    const same = context({ pendingApproval: { summary: "run npm test", actionDigest: "d1" } } as Partial<Job>);
    await runJobsCommand({ kind: "approve", id: "job-1", decision: "allow" }, same.ctx);
    expect(same.written).toEqual(["  approving: run npm test\n", "  delivered — the worker will pick it up shortly.\n"]);
    const changed = context({ pendingApproval: { summary: "rm -rf", actionDigest: "d2" } } as Partial<Job>);
    await runJobsCommand({ kind: "approve", id: "job-1", decision: "allow" }, changed.ctx);
    expect(changed.written.at(-1)).toContain("nothing was authorized");
  });

  it("starts a job and explains an empty list", async () => {
    const { ctx, written } = context(null);
    await runJobsCommand({ kind: "list" }, ctx);
    await runJobsCommand({ kind: "run", objective: "run tests" }, ctx);
    expect(written[0]).toContain("no background jobs");
    expect(written[1]).toContain("/attach job-1");
  });
});
