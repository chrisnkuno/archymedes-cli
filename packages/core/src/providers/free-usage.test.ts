import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allowanceAfterCall, compactTokenCount, fileFreeUsageStore, formatModelAllowance, formatRequestsLeft, formatResetUtc, FreeUsageMeter, freeUsageFile,
  parseFreeAllowanceHeaders, parseFreeUsageDays, pruneFreeUsageDays, utcDay, type FreeUsageDays,
} from "./free-usage";

const NOON = Date.UTC(2026, 9, 8, 12, 0, 0);
const headers = (values: Record<string, string>) => new Headers(values);
const memoryStore = (initial: FreeUsageDays = {}) => {
  let days = { ...initial };
  return { read: async () => ({ ...days }), write: async (next: FreeUsageDays) => { days = { ...next }; }, days: () => days };
};

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe("free allowance headers", () => {
  it("reads the gateway's remaining tokens, reset time and warning", () => {
    expect(parseFreeAllowanceHeaders(headers({
      "x-free-remaining-tokens": "20000", "x-free-reset-utc": "2026-10-09T00:00:00.000Z", "x-free-allowance-warning": "You've used 80% of today's free allowance.",
    }))).toEqual({ remainingTokens: 20_000, resetsAt: "2026-10-09T00:00:00.000Z", warning: "You've used 80% of today's free allowance." });
  });

  it("is undefined without gateway headers (the user's own key)", () => {
    expect(parseFreeAllowanceHeaders(headers({ "content-type": "text/event-stream" }))).toBeUndefined();
    expect(parseFreeAllowanceHeaders(undefined)).toBeUndefined();
  });

  it("drops malformed values instead of reading them as zero, and strips control characters", () => {
    expect(parseFreeAllowanceHeaders(headers({ "x-free-remaining-tokens": "-5", "x-free-reset-utc": "tomorrow" }))).toBeUndefined();
    expect(parseFreeAllowanceHeaders(headers({ "x-free-remaining-tokens": "12abc", "x-free-allowance-warning": "low\u001b[31m" }))).toEqual({ warning: "low[31m" });
    expect(parseFreeAllowanceHeaders(headers({ "x-free-remaining-tokens": "0" }))).toEqual({ remainingTokens: 0 });
  });

  it("subtracts this call's measured total from the pre-request remaining, floored at zero", () => {
    const day = { date: "2026-10-08", usedTokens: 12_300 };
    expect(allowanceAfterCall(day, { remainingTokens: 90_000, resetsAt: "2026-10-09T00:00:00.000Z" }, 2_300))
      .toEqual({ date: "2026-10-08", usedTokens: 12_300, remainingTokens: 87_700, resetsAt: "2026-10-09T00:00:00.000Z" });
    expect(allowanceAfterCall(day, { remainingTokens: 1_000 }, 5_000).remainingTokens).toBe(0);
    expect(allowanceAfterCall(day, undefined, 5_000)).toEqual(day);
  });
});

describe("meter formatting", () => {
  it("abbreviates token counts at each boundary", () => {
    expect([0, 999, 1_000, 12_345, 87_700, 999_999, 1_000_000, 1_250_000].map(compactTokenCount))
      .toEqual(["0", "999", "1k", "12.3k", "87.7k", "1M", "1M", "1.3M"]);
    expect(compactTokenCount(-4)).toBe("0");
  });

  it("formats the reset as a UTC clock time", () => {
    expect(formatResetUtc("2026-10-09T00:00:00.000Z")).toBe("00:00 UTC");
    expect(formatResetUtc("not a time")).toBeUndefined();
    expect(formatResetUtc(undefined)).toBeUndefined();
  });

  it("renders the one-line meter with whatever the gateway said", () => {
    expect(formatModelAllowance({ date: "2026-10-08", usedTokens: 12_300, remainingTokens: 87_700, resetsAt: "2026-10-09T00:00:00.000Z" }, NOON))
      .toBe("today 12.3k tok · 87.7k left · resets 00:00 UTC");
    expect(formatModelAllowance({ date: "2026-10-08", usedTokens: 950 }, NOON)).toBe("today 950 tok");
  });

  it("shows yesterday's count as zero for today", () => {
    expect(formatModelAllowance({ date: "2026-10-07", usedTokens: 50_000 }, NOON)).toBe("today 0 tok");
  });
});

describe("daily usage store", () => {
  it("keys days by UTC date", () => {
    expect(utcDay(Date.UTC(2026, 9, 8, 23, 59, 59))).toBe("2026-10-08");
    expect(utcDay(Date.UTC(2026, 9, 9, 0, 0, 0))).toBe("2026-10-09");
  });

  it("keeps only well-formed days and the newest week", () => {
    expect(parseFreeUsageDays({ days: { "2026-10-08": 5, "bad": 3, "2026-10-07": -1, "2026-10-06": 1.5 } })).toEqual({ "2026-10-08": 5 });
    expect(parseFreeUsageDays(null)).toEqual({});
    expect(parseFreeUsageDays({ days: [1, 2] })).toEqual({});
    const days = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`2026-10-${String(index + 1).padStart(2, "0")}`, index]));
    expect(Object.keys(pruneFreeUsageDays(days))).toEqual(["2026-10-10", "2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06", "2026-10-05", "2026-10-04"]);
  });

  it("adds every call to today's total and starts over on a new UTC day", async () => {
    let now = NOON;
    const store = memoryStore({ "2026-10-08": 1_000 });
    const meter = new FreeUsageMeter(store, () => now);
    await expect(meter.record(500)).resolves.toEqual({ date: "2026-10-08", usedTokens: 1_500 });
    // Concurrent calls (tabs, delegated runs) are serialized, so neither is lost.
    await Promise.all([meter.record(100), meter.record(200)]);
    await expect(meter.today()).resolves.toEqual({ date: "2026-10-08", usedTokens: 1_800 });
    now = Date.UTC(2026, 9, 9, 0, 0, 1);
    await expect(meter.record(40)).resolves.toEqual({ date: "2026-10-09", usedTokens: 40 });
    expect(store.days()).toEqual({ "2026-10-08": 1_800, "2026-10-09": 40 });
  });

  it("never throws when the store fails, and ignores nonsense amounts", async () => {
    const meter = new FreeUsageMeter({ read: async () => { throw new Error("unreadable"); }, write: async () => { throw new Error("read-only"); } }, () => NOON);
    await expect(meter.record(300)).resolves.toEqual({ date: "2026-10-08", usedTokens: 300 });
    await expect(meter.record(Number.NaN)).resolves.toEqual({ date: "2026-10-08", usedTokens: 0 });
  });

  it("persists to a file in the config directory and reads a corrupt one as empty", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "free-usage-"));
    const file = freeUsageFile({ ARCHYMEDES_CONFIG_DIR: root });
    expect(file).toBe(path.join(path.resolve(root), "free-usage.json"));
    const store = fileFreeUsageStore(file);
    await expect(store.read()).resolves.toEqual({});
    await new FreeUsageMeter(store, () => NOON).record(2_500);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, days: { "2026-10-08": 2_500 } });
    await writeFile(file, "{not json");
    await expect(store.read()).resolves.toEqual({});
  });
});

describe("free request counts", () => {
  it("reads x-free-remaining-requests, tolerating its absence and rejecting junk", () => {
    expect(parseFreeAllowanceHeaders(headers({ "x-free-remaining-requests": "288" }))).toEqual({ remainingRequests: 288 });
    expect(parseFreeAllowanceHeaders(headers({ "x-free-remaining-tokens": "10", "x-free-remaining-requests": "-1" }))).toEqual({ remainingTokens: 10 });
    expect(parseFreeAllowanceHeaders(headers({ "x-free-remaining-requests": "lots" }))).toBeUndefined();
  });

  it("counts this request off the pre-request figure, and shows it in the meter", () => {
    const after = allowanceAfterCall({ date: "2026-10-08", usedTokens: 100 }, { remainingRequests: 288, remainingTokens: 5_000 }, 100);
    expect(after).toMatchObject({ remainingRequests: 287, remainingTokens: 4_900 });
    expect(allowanceAfterCall({ date: "2026-10-08", usedTokens: 0 }, { remainingRequests: 0 }, 1).remainingRequests).toBe(0);
    expect(formatModelAllowance({ ...after, resetsAt: "2026-10-09T00:00:00.000Z" }, NOON)).toBe("today 100 tok · 4.9k left · 287 req left · resets 00:00 UTC");
  });

  it("shows remaining out of the limit when the limit is known", () => {
    expect(formatRequestsLeft({ remainingRequests: 47, requestLimit: 50 })).toBe("47/50 req left");
    expect(formatRequestsLeft({ remainingRequests: 3 })).toBe("3 req left");
    expect(formatRequestsLeft({})).toBeUndefined();
  });
});
