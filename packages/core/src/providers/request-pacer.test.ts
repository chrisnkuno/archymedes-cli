import { describe, expect, it, vi } from "vitest";
import { RequestPacer } from "./request-pacer";

describe("request pacer", () => {
  it("starts unthrottled and costs nothing until the first 429", async () => {
    let now = 1_000;
    const sleep = vi.fn(async () => undefined);
    const pacer = new RequestPacer({ now: () => now, sleep });
    await pacer.wait();
    await pacer.wait();
    expect(pacer.paceMs).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    pacer.reportSuccess();
    expect(pacer.paceMs).toBe(0);
  });

  it("doubles the gap on every 429 and relaxes it on success", () => {
    const pacer = new RequestPacer({ baseGapMs: 2_000, maxGapMs: 120_000 });
    pacer.reportRateLimited();
    expect(pacer.paceMs).toBe(2_000);
    pacer.reportRateLimited();
    expect(pacer.paceMs).toBe(4_000);
    pacer.reportSuccess();
    expect(pacer.paceMs).toBe(3_500);
  });

  it("adopts an explicit retry-after when it asks for longer, capped at the ceiling", () => {
    const pacer = new RequestPacer({ baseGapMs: 2_000, maxGapMs: 120_000 });
    pacer.reportRateLimited(30_000);
    expect(pacer.paceMs).toBe(30_000);
    pacer.reportRateLimited(500_000);
    expect(pacer.paceMs).toBe(120_000);
    pacer.reportRateLimited(NaN);
    expect(pacer.paceMs).toBe(120_000);
  });

  it("spaces request starts by the learned gap", async () => {
    let now = 0;
    const slept: number[] = [];
    const pacer = new RequestPacer({ now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } });
    pacer.reportRateLimited();
    await pacer.wait();
    expect(slept).toEqual([2_000]);
    // A request right after the last start waits the full gap again.
    await pacer.wait();
    expect(slept).toEqual([2_000, 2_000]);
    // After enough wall-clock time passes, no wait is needed.
    now += 5_000;
    await pacer.wait();
    expect(slept).toEqual([2_000, 2_000]);
  });

  it("aborts a pending wait on cancellation", async () => {
    const pacer = new RequestPacer({ baseGapMs: 60_000 });
    await pacer.wait();
    pacer.reportRateLimited();
    const controller = new AbortController();
    const pending = pacer.wait(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toThrow("user cancelled");
  });

  it("rejects immediately on an already-aborted signal", async () => {
    const pacer = new RequestPacer();
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    await expect(pacer.wait(controller.signal)).rejects.toThrow("already gone");
  });
});
