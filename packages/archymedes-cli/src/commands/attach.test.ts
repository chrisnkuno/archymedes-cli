import type { Job } from "@archymedes/core/cli/jobs";
import { describe, expect, it } from "vitest";
import { runAttach, type AttachContext } from "./attach";

function context(states: Array<Partial<Job> | null>, overrides: Partial<AttachContext> = {}) {
  const written: string[] = [];
  const events: string[] = [];
  let read = 0;
  const same = (text: string) => text;
  const ctx: AttachContext = {
    getJob: async () => (states.length > 1 ? states.shift() : states[0]) as Job | null,
    readLog: async (_id, offset) => ({ text: read++ === 0 ? "log line\n" : "", nextByte: offset + 9 }),
    resolveApproval: async (_id, decision, digest) => { events.push(`${decision}:${digest}`); return true; },
    isTerminal: (status) => status === "completed",
    describe: (job) => job.status,
    ask: async () => "y",
    takeInterrupt: () => { events.push("take"); return () => events.push("release"); },
    sleep: async () => undefined,
    write: (text) => written.push(text),
    paint: { dim: same, yellow: same },
    ...overrides,
  };
  return { ctx, written, events };
}

describe("/attach", () => {
  it("follows the log, answers an approval against the digest shown, and stops when the job ends", async () => {
    const { ctx, written, events } = context([
      { status: "running" },
      { status: "running", pendingApproval: { summary: "run tests", actionDigest: "d1" } } as Partial<Job>,
      { status: "completed" },
    ]);
    await runAttach("job-1", ctx);
    expect(written).toContain("log line\n");
    expect(events).toEqual(["take", "allow:d1", "release"]);
    expect(written.at(-1)).toBe("  job completed\n");
  });

  it("explains a missing job without taking Ctrl+C", async () => {
    const { ctx, written, events } = context([null]);
    await runAttach("nope", ctx);
    expect(written).toEqual(["  No job nope. /jobs lists what exists.\n"]);
    expect(events).toEqual([]);
  });
});
