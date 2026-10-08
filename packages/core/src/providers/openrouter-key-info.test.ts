import { describe, expect, it, vi } from "vitest";
import { checkOpenRouterKey, describeKeyCheckFailure, nextUtcMidnight, OPENROUTER_KEY_URL, OpenRouterKeyInfoCache, parseOpenRouterKeyInfo, type KeyInfoFetch } from "./openrouter-key-info";

const documented = {
  data: {
    label: "my-key", limit: 10, limit_reset: null, limit_remaining: 7.5, include_byok_in_limit: false,
    usage: 2.5, usage_daily: 0.4, usage_weekly: 1.2, usage_monthly: 2.5, is_free_tier: false,
    free_model_daily_requests: { used: 3, limit: 50, remaining: 47 }, rate_limit: { requests: -1, interval: "10s" },
  },
};

const respond = (status: number, body: unknown): KeyInfoFetch => vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));

describe("OpenRouter key info", () => {
  it("reads the documented GET /api/v1/key body", () => {
    expect(parseOpenRouterKeyInfo(documented)).toEqual({
      label: "my-key", limit: 10, limitRemaining: 7.5, usage: 2.5, isFreeTier: false, freeDailyRequests: { used: 3, limit: 50, remaining: 47 },
    });
  });

  it("drops malformed fields, derives remaining from used/limit, and rejects a body without data", () => {
    expect(parseOpenRouterKeyInfo({ data: { limit: null, limit_remaining: "7", is_free_tier: "yes", free_model_daily_requests: { used: 10, limit: 50 } } }))
      .toEqual({ freeDailyRequests: { used: 10, limit: 50, remaining: 40 } });
    expect(parseOpenRouterKeyInfo({ data: { label: "a\u0007b" } })).toEqual({ label: "ab" });
    expect(parseOpenRouterKeyInfo({})).toBeUndefined();
    expect(parseOpenRouterKeyInfo(null)).toBeUndefined();
  });

  it("sends the key only as a bearer header to the fixed host, without following redirects", async () => {
    const fetchImpl = respond(200, documented);
    const check = await checkOpenRouterKey(" sk-or-v1-abc ", { fetchImpl });
    expect(check).toMatchObject({ ok: true, info: { freeDailyRequests: { remaining: 47 } } });
    expect(fetchImpl).toHaveBeenCalledWith(OPENROUTER_KEY_URL, expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ authorization: "Bearer sk-or-v1-abc" }) }));
    expect(OPENROUTER_KEY_URL).toBe("https://openrouter.ai/api/v1/key");
  });

  it("classifies failures without echoing the key", async () => {
    expect(await checkOpenRouterKey("bad", { fetchImpl: respond(401, {}) })).toEqual({ ok: false, reason: "invalid", status: 401 });
    expect(await checkOpenRouterKey("", { fetchImpl: respond(200, documented) })).toEqual({ ok: false, reason: "invalid" });
    expect(await checkOpenRouterKey("k", { fetchImpl: respond(500, {}) })).toEqual({ ok: false, reason: "error", status: 500 });
    const offline: KeyInfoFetch = async () => { throw new TypeError("fetch failed for sk-or-secret"); };
    const network = await checkOpenRouterKey("sk-or-secret", { fetchImpl: offline });
    expect(network).toEqual({ ok: false, reason: "network" });
    for (const failure of [{ ok: false as const, reason: "invalid" as const }, { ok: false as const, reason: "network" as const }, { ok: false as const, reason: "error" as const, status: 503 }]) {
      expect(describeKeyCheckFailure(failure)).not.toContain("secret");
    }
    expect(describeKeyCheckFailure({ ok: false, reason: "invalid" })).toContain("https://openrouter.ai/keys");
  });

  it("caches for a minute, shares one request, keeps the last good figure and counts requests locally", async () => {
    let now = 1_000;
    const fetchImpl = respond(200, documented);
    const cache = new OpenRouterKeyInfoCache("k", { fetchImpl, now: () => now });
    expect(cache.peek()).toBeUndefined();
    await Promise.all([cache.get(), cache.get()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    cache.noteRequest();
    expect(cache.peek()?.freeDailyRequests).toEqual({ used: 4, limit: 50, remaining: 46 });
    now += 30_000;
    await cache.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 31_000;
    (fetchImpl as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    expect((await cache.get())?.freeDailyRequests?.remaining).toBe(46);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("names the next UTC midnight", () => {
    expect(nextUtcMidnight(Date.UTC(2026, 9, 8, 21, 30))).toBe("2026-10-09T00:00:00.000Z");
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 0, 0))).toBe("2027-01-01T00:00:00.000Z");
  });
});
