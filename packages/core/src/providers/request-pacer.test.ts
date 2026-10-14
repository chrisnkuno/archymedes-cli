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

describe("the window budget keeps the agent fast", () => {
  const clock = () => {
    let t = 1_000_000;
    const sleeps: number[] = [];
    return { now: () => t, sleeps, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
  };

  it("never waits while the minute holds fewer requests than the cap", async () => {
    const c = clock();
    const pacer = new RequestPacer({ windowCap: 5, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 5; i += 1) await pacer.wait();
    expect(c.sleeps).toEqual([]);
    expect(pacer.inWindow).toBe(5);
  });

  it("waits only until the oldest request leaves the window, not for the whole minute", async () => {
    const c = clock();
    const pacer = new RequestPacer({ windowCap: 3, now: c.now, sleep: c.sleep });
    await pacer.wait();
    c.sleep(20_000); // 20 s pass
    c.sleeps.length = 0;
    await pacer.wait();
    await pacer.wait(); // the window now holds three
    await pacer.wait(); // the fourth must wait for the first (started 20 s ago) to expire: 40 s
    expect(c.sleeps).toHaveLength(1);
    expect(c.sleeps[0]).toBeGreaterThan(39_000);
    expect(c.sleeps[0]).toBeLessThan(40_100);
  });

  it("learns the cap from a 429 that came after many requests", async () => {
    const c = clock();
    const pacer = new RequestPacer({ now: c.now, sleep: c.sleep });
    for (let i = 0; i < 12; i += 1) await pacer.wait(); // the 12th is the one refused
    pacer.reportRateLimited();
    expect(pacer.windowBudget).toBe(11);
  });

  it("does not take a 429 after a few requests for the per-minute limit (one busy upstream model)", async () => {
    const c = clock();
    const pacer = new RequestPacer({ windowCap: 20, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 3; i += 1) await pacer.wait();
    pacer.reportRateLimited();
    expect(pacer.windowBudget).toBe(20);
    const early = new RequestPacer({ now: c.now, sleep: c.sleep });
    await early.wait();
    early.reportRateLimited();
    expect(early.windowBudget).toBeUndefined();
  });

  it("forgets a learned cap after a few quiet windows", async () => {
    const c = clock();
    const pacer = new RequestPacer({ windowCap: 20, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 12; i += 1) await pacer.wait();
    pacer.reportRateLimited();
    expect(pacer.windowBudget).toBe(11);
    await c.sleep(6 * 60_000);
    await pacer.wait();
    expect(pacer.windowBudget).toBe(20);
  });

  it("adds no measurable cost per request while under the cap", async () => {
    const pacer = new RequestPacer({ windowCap: 1_000_000 });
    const started = performance.now();
    for (let i = 0; i < 400; i += 1) await pacer.wait();
    expect(performance.now() - started).toBeLessThan(50);
  });
});
