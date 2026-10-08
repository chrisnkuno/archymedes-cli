import { describe, expect, it } from "vitest";
import { describeFreeFailure, isDataPolicyRefusal, isOpenRouterDailyLimit, parseFreeLimitBody, withFreeResetTime } from "./free-errors";

const NOW = Date.UTC(2026, 9, 8, 21, 30);
const headers = (values: Record<string, string>) => new Headers(values);

describe("free failure descriptions", () => {
  it("reads the gateway's JSON 429 body from an SDK error or a raw body", () => {
    const body = { message: "Daily tokens used.", code: 429, kind: "daily_tokens", reset_utc: "2026-10-09T00:00:00Z", retry_after_seconds: 9000 };
    expect(parseFreeLimitBody({ error: body })).toEqual({ message: "Daily tokens used.", kind: "daily_tokens", resetUtc: "2026-10-09T00:00:00.000Z", retryAfterSeconds: 9000 });
    expect(parseFreeLimitBody({ error: { error: body } })).toMatchObject({ kind: "daily_tokens" });
    expect(parseFreeLimitBody({ error: { kind: "weekly", reset_utc: "soon", retry_after_seconds: -1 } })).toEqual({});
    expect(parseFreeLimitBody(undefined)).toEqual({});
  });

  it("recognizes OpenRouter's data-policy refusal", () => {
    expect(isDataPolicyRefusal("404 No endpoints found matching your data policy (Free model training)")).toBe(true);
    expect(isDataPolicyRefusal("No endpoints found that support tool use")).toBe(false);
    expect(isDataPolicyRefusal(undefined)).toBe(false);
  });

  it("points a data-policy refusal at the privacy settings, without relaying upstream text", () => {
    const failure = describeFreeFailure({ status: 404, viaGateway: false, gatewayOwned: false, message: "No endpoints found matching your data policy secret-prompt", now: NOW });
    expect(failure.message).toContain("https://openrouter.ai/settings/privacy");
    expect(failure.message).not.toContain("secret-prompt");
    expect(failure.retryable).toBe(false);
    // A plain 404 is an unavailable model.
    expect(describeFreeFailure({ status: 404, viaGateway: false, gatewayOwned: false, message: "model gone", now: NOW }).message).toContain("/models refresh");
  });

  it("tells OpenRouter's per-minute limit from its daily cap", () => {
    expect(isOpenRouterDailyLimit(headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW + 2 * 60 * 60 * 1000), "x-ratelimit-limit": "50" }), NOW)).toBe(true);
    expect(isOpenRouterDailyLimit(headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW + 30_000), "x-ratelimit-limit": "20" }), NOW)).toBe(false);
    expect(isOpenRouterDailyLimit(headers({ "x-ratelimit-remaining": "0", "x-ratelimit-limit": "1000" }), NOW)).toBe(true);
    expect(isOpenRouterDailyLimit(headers({ "retry-after": "3" }), NOW)).toBe(false);
    const daily = describeFreeFailure({ status: 429, viaGateway: false, gatewayOwned: false, now: NOW, requestLimit: 50, requestsLeft: 0 });
    expect(daily).toMatchObject({ retryable: false });
    expect(daily.message).toContain("50 requests a day");
    expect(daily.message).toContain("1000 free requests a day");
    const minute = describeFreeFailure({ status: 429, viaGateway: false, gatewayOwned: false, headers: headers({ "retry-after": "3" }), now: NOW });
    expect(minute).toMatchObject({ retryable: true, retryAfterMs: 3000 });
    expect(minute.message).toContain("20 requests a minute");
  });

  it("explains 401 and 402 with where to fix them", () => {
    expect(describeFreeFailure({ status: 401, viaGateway: false, gatewayOwned: false, now: NOW }).message).toContain("https://openrouter.ai/keys");
    const credits = describeFreeFailure({ status: 402, viaGateway: false, gatewayOwned: false, now: NOW });
    expect(credits.message).toContain("https://openrouter.ai/settings/credits");
    expect(credits.retryable).toBe(false);
  });

  it("uses the gateway 429 kind to decide between waiting and stopping for the day", () => {
    const minute = describeFreeFailure({ status: 429, viaGateway: true, gatewayOwned: true, message: "", body: { kind: "per_minute", retryAfterSeconds: 20 }, now: NOW });
    expect(minute).toMatchObject({ retryable: true, retryAfterMs: 20_000 });
    expect(minute.message).toContain("per-minute");
    const tokens = describeFreeFailure({ status: 429, viaGateway: true, gatewayOwned: true, body: { kind: "daily_tokens", resetUtc: "2026-10-09T00:00:00.000Z" }, now: NOW });
    expect(tokens.retryable).toBe(false);
    expect(tokens.message).toContain("Today's free token allowance is used up");
    expect(tokens.message).toContain("Allowance resets at 00:00 UTC (in 2h 30m)");
    const requests = describeFreeFailure({ status: 429, viaGateway: true, gatewayOwned: true, message: "Shared free capacity is exhausted.", body: { kind: "daily_requests" }, now: NOW });
    expect(requests).toMatchObject({ message: "Shared free capacity is exhausted.", retryable: false });
    // Without a body, the old signals still decide.
    expect(describeFreeFailure({ status: 429, viaGateway: true, gatewayOwned: true, headers: headers({ "x-free-remaining-requests": "0" }), now: NOW }).retryable).toBe(false);
    expect(describeFreeFailure({ status: 429, viaGateway: true, gatewayOwned: true, headers: headers({ "retry-after": "20" }), now: NOW }).retryable).toBe(true);
  });

  it("keeps the reset-time helper's wording", () => {
    expect(withFreeResetTime("Limit reached", { resetsAt: "2026-10-09T00:00:00.000Z" }, Date.UTC(2026, 9, 8, 23, 20))).toBe("Limit reached. Allowance resets at 00:00 UTC (in 40m).");
  });
});
