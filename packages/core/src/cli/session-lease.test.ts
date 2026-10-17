import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireSessionLease, leaseFile, LEASE_STALE_MS, sessionHolder, type LeaseDependencies } from "./session-lease";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "lease-")); });
afterEach(() => fs.rm(root, { recursive: true, force: true }));

/** A terminal: its own pid, on this host unless told otherwise; `alive` is which pids are running. */
const terminal = (pid: number, alive: Set<number>, extra: LeaseDependencies = {}): LeaseDependencies =>
  ({ pid, host: "here", isAlive: (candidate) => alive.has(candidate), heartbeatMs: 0, ...extra });

describe("session leases", () => {
  it("lets one terminal hold a session and tells another who has it, until it is released", async () => {
    const alive = new Set([100, 200]);
    const first = await acquireSessionLease(root, "s1", terminal(100, alive));
    expect("lease" in first).toBe(true);
    const second = await acquireSessionLease(root, "s1", terminal(200, alive));
    expect(second).toEqual({ heldBy: expect.objectContaining({ pid: 100, host: "here" }) });
    expect(await sessionHolder(root, "s1", terminal(200, alive))).toMatchObject({ pid: 100 });
    // Another session is free.
    expect("lease" in await acquireSessionLease(root, "s2", terminal(200, alive))).toBe(true);
    if ("lease" in first) await first.lease.release();
    expect(await sessionHolder(root, "s1", terminal(200, alive))).toBeNull();
    expect("lease" in await acquireSessionLease(root, "s1", terminal(200, alive))).toBe(true);
  });

  it("counts a second open in the same process as held: one session, one owner", async () => {
    const alive = new Set([100]);
    expect("lease" in await acquireSessionLease(root, "s1", terminal(100, alive))).toBe(true);
    expect("heldBy" in await acquireSessionLease(root, "s1", terminal(100, alive))).toBe(true);
  });

  it("takes over a lease whose process is gone", async () => {
    const alive = new Set([100, 200]);
    await acquireSessionLease(root, "s1", terminal(100, alive));
    alive.delete(100); // the first terminal was killed and never released
    expect(await sessionHolder(root, "s1", terminal(200, alive))).toBeNull();
    const taken = await acquireSessionLease(root, "s1", terminal(200, alive));
    expect("lease" in taken).toBe(true);
    expect(JSON.parse(await fs.readFile(leaseFile(root, "s1"), "utf8")).pid).toBe(200);
  });

  it("trusts another machine's lease only while it is kept fresh", async () => {
    const alive = new Set([200]);
    await acquireSessionLease(root, "s1", { pid: 100, host: "there", heartbeatMs: 0 });
    expect(await sessionHolder(root, "s1", terminal(200, alive))).toMatchObject({ host: "there" });
    const old = new Date(Date.now() - LEASE_STALE_MS - 1_000);
    await fs.utimes(leaseFile(root, "s1"), old, old);
    expect("lease" in await acquireSessionLease(root, "s1", terminal(200, alive))).toBe(true);
  });

  it("never releases a lease that has since passed to someone else", async () => {
    const alive = new Set([100, 200]);
    const first = await acquireSessionLease(root, "s1", terminal(100, alive));
    alive.delete(100);
    const second = await acquireSessionLease(root, "s1", terminal(200, alive));
    if ("lease" in first) await first.lease.release();
    expect(await sessionHolder(root, "s1", terminal(300, alive))).toMatchObject({ pid: 200 });
    if ("lease" in second) await second.lease.release();
  });

  it("gives a session to exactly one of many terminals opening it at once, fresh or stale", async () => {
    // Repeated: an interleaving that breaks it shows up in a few rounds, not every one.
    for (const [round, stale] of Array.from({ length: 30 }, (_, i) => [i, i % 2 === 1] as const)) {
      const id = `race-${round}`;
      const alive = new Set(Array.from({ length: 24 }, (_, i) => 1_000 + i));
      if (stale) await acquireSessionLease(root, id, terminal(9, new Set([9]))); // pid 9 is not in `alive`: dead
      const results = await Promise.all([...alive].map((pid) => acquireSessionLease(root, id, terminal(pid, alive))));
      const winners = results.filter((result) => "lease" in result);
      expect(winners.length, stale ? "reclaiming a stale lease" : "a fresh session").toBe(1);
      const holder = JSON.parse(await fs.readFile(leaseFile(root, id), "utf8")).pid;
      for (const result of results) if ("heldBy" in result) expect(alive.has(result.heldBy.pid)).toBe(true);
      expect(results.filter((result) => "heldBy" in result && result.heldBy.pid !== holder)).toEqual([]);
      // Nothing set aside is left behind in the sessions directory.
      expect((await fs.readdir(path.dirname(leaseFile(root, id)))).filter((name) => name.endsWith(".reclaim"))).toEqual([]);
    }
  });
});
