import { describe, expect, it, vi } from "vitest";
import { MemoryCounterStore, clientKey, rulesFrom, upstashCounterStore } from "./rate-limit";

describe("gateway counters", () => {
  it("expires windows and stays bounded", async () => {
    let now = 0;
    const store = new MemoryCounterStore(2, () => now);
    expect(await store.increment("a", 10)).toBe(1);
    expect(await store.increment("a", 10)).toBe(2);
    now = 11;
    expect(await store.increment("a", 10)).toBe(1);
    await store.increment("b", 100);
    await store.increment("c", 100);
    expect(await store.increment("a", 100)).toBe(1); // evicted to stay within two keys
  });

  it("uses one Upstash pipeline call and fails on a bad reply", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify([{ result: 3 }, { result: 1 }])));
    const store = upstashCounterStore("https://redis.test/", "token", fetchImpl as unknown as typeof fetch);
    expect(await store.increment("k", 60_000)).toBe(3);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://redis.test/pipeline");
    expect(JSON.parse(String(init!.body))).toEqual([["INCR", "k"], ["PEXPIRE", "k", "60000", "NX"]]);
    const broken = upstashCounterStore("https://redis.test", "t", (async () => new Response("no", { status: 500 })) as unknown as typeof fetch);
    await expect(broken.increment("k", 1)).rejects.toThrow("HTTP 500");
  });

  it("never stores a raw address and reads limits from the environment", () => {
    expect(clientKey("203.0.113.9", "salt")).not.toContain("203");
    expect(clientKey("203.0.113.9", "salt")).not.toBe(clientKey("203.0.113.9", "other"));
    const rules = rulesFrom({ FREE_GATEWAY_GLOBAL_PER_DAY: "50", FREE_GATEWAY_IP_PER_MINUTE: "-1" });
    expect(rules.find((rule) => rule.name === "global-day")?.limit).toBe(50);
    expect(rules.find((rule) => rule.name === "ip-minute")?.limit).toBe(10);
  });
});
