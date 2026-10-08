import { describe, expect, it, vi } from "vitest";
import { MemoryCounterStore, clientKey, consume, dailyRequestRules, gatewayIdentity, installRulesFrom, remainingRequests, rulesFrom, tokenRulesFrom, upstashCounterStore, type RateRule } from "./rate-limit";

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

  it("adds amounts atomically and reads counts without mutating them", async () => {
    const store = new MemoryCounterStore();
    expect(await store.get("k")).toBeUndefined();
    expect(await store.add("k", 100, 60_000)).toBe(100);
    expect(await store.add("k", 250, 60_000)).toBe(350);
    expect(await store.get("k")).toBe(350); // a read must not charge anything
    expect(await store.increment("k", 60_000)).toBe(351);
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

  it("charges amounts and reads counters over Upstash's REST API", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify([{ result: 100_000 }, { result: 1 }])));
    const store = upstashCounterStore("https://redis.test/", "token", fetchImpl as unknown as typeof fetch);
    expect(await store.add("tokens", 100_000, 86_400_000)).toBe(100_000);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]!.body))).toEqual([["INCRBY", "tokens", "100000"], ["PEXPIRE", "tokens", "86400000", "NX"]]);
    fetchImpl.mockClear();
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ result: 42 })));
    expect(await store.get("tokens")).toBe(42);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://redis.test/get/tokens");
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ result: null })));
    expect(await store.get("missing")).toBeUndefined();
  });

  it("derives one identity per address and salt, isolated for a stronger identifier later", () => {
    expect(clientKey("203.0.113.9", "salt")).not.toContain("203");
    expect(clientKey("203.0.113.9", "salt")).not.toBe(clientKey("203.0.113.9", "other"));
    expect(gatewayIdentity("203.0.113.9", "salt")).toBe(clientKey("203.0.113.9", "salt"));
    expect(gatewayIdentity(undefined, "salt")).toBe(clientKey(undefined, "salt"));
  });

  it("reads limits from the environment: 20 a minute, 300 a day, 100k tokens a day", () => {
    const rules = rulesFrom({});
    expect(rules.find((rule) => rule.name === "ip-minute")?.limit).toBe(20);
    expect(rules.find((rule) => rule.name === "ip-day")?.limit).toBe(300);
    const install = installRulesFrom({});
    expect(install.find((rule) => rule.name === "install-minute")?.limit).toBe(20);
    expect(install.find((rule) => rule.name === "install-day")?.limit).toBe(300);
    expect(install.find((rule) => rule.name === "ip-shared-day")?.limit).toBe(3_000);
    expect(installRulesFrom({ FREE_GATEWAY_INSTALL_PER_DAY: "40" }).find((rule) => rule.name === "install-day")?.limit).toBe(40);
    expect(rules.find((rule) => rule.name === "global-day")?.limit).toBe(1_000);
    const overridden = rulesFrom({ FREE_GATEWAY_IP_PER_MINUTE: "2", FREE_GATEWAY_IP_PER_DAY: "7", FREE_GATEWAY_GLOBAL_PER_DAY: "50" });
    expect(overridden.find((rule) => rule.name === "ip-minute")?.limit).toBe(2);
    expect(overridden.find((rule) => rule.name === "ip-day")?.limit).toBe(7);
    expect(overridden.find((rule) => rule.name === "global-day")?.limit).toBe(50);
    const tokens = tokenRulesFrom({});
    expect(tokens).toEqual([{ name: "ip-token-day", scope: "ip", windowMs: 24 * 60 * 60_000, limit: 100_000 }]);
    expect(tokenRulesFrom({ FREE_GATEWAY_IP_TOKENS_PER_DAY: "5000" })[0].limit).toBe(5000);
    // Nonsense values fail closed to the default, never to zero or unlimited.
    for (const bad of ["0", "-1", "abc", ""]) expect(tokenRulesFrom({ FREE_GATEWAY_IP_TOKENS_PER_DAY: bad })[0].limit).toBe(100_000);
  });

  it("refunds every counter a refused request charged, so a burst refusal costs no daily allowance", async () => {
    const minute: RateRule = { name: "ip-minute", scope: "ip", windowMs: 60_000, limit: 2 };
    const day: RateRule = { name: "ip-day", scope: "ip", windowMs: 86_400_000, limit: 300 };
    const store = new MemoryCounterStore();
    expect((await consume(store, [minute, day], "a", 0)).ok).toBe(true);
    expect((await consume(store, [minute, day], "a", 0)).ok).toBe(true);
    const refused = await consume(store, [minute, day], "a", 0);
    expect(refused).toMatchObject({ ok: false, rule: "ip-minute", scope: "ip", retryAfterMs: 60_000 });
    expect(await store.get("free:ip-day:ip:a:0")).toBe(2); // only the two served requests count
    expect(await store.get("free:ip-minute:ip:a:0")).toBe(2);
    const next = await consume(store, [minute, day], "a", 60_000); // the next minute
    expect(next.ok).toBe(true);
    expect(remainingRequests([minute, day], next.counts)).toBe(298); // before this request: 300 - 2
  });

  it("reports the tightest of the client's own daily request rules, never global ones", () => {
    const rules = installRulesFrom({});
    expect(dailyRequestRules(rules).map((rule) => rule.name)).toEqual(["install-day", "ip-shared-day"]);
    const byName = (name: string) => rules.find((rule) => rule.name === name)!;
    expect(remainingRequests(rules, [
      { rule: byName("install-minute"), count: 1 },
      { rule: byName("install-day"), count: 300 },
      { rule: byName("ip-shared-day"), count: 10 },
      { rule: byName("global-day"), count: 999 },
    ])).toBe(1);
    expect(remainingRequests(rules, [{ rule: byName("install-day"), count: 301 }])).toBe(0);
    expect(remainingRequests(rules, [{ rule: byName("install-minute"), count: 1 }])).toBeUndefined();
  });
});
