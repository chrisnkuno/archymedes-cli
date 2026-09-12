import { describe, expect, it } from "vitest";
import { parseRoutingPlan } from "./routing-plan";

/** The shape `/v1/routes/plan` actually returns, trimmed to the fields the client reads. */
function wirePlan(overrides: Record<string, unknown> = {}) {
  return {
    object: "routing_plan",
    policy: { id: "outcome-per-dollar", version: 3 },
    ranked: [{
      candidate: { provider: "anthropic", model: "claude-sonnet-5" },
      eligible: true, reason: "highest predicted outcome within budget", score: 0.86,
      estimated_charged: { currency: "USD", micros: 12_000 },
      expected_total_micros: 31_000, expected_attempts: 1.1, expected_latency_ms: 4_200,
      completed_quality: 0.88, outcome_per_dollar: 28.4, funding_source: "platform",
    }],
    excluded: [],
    ...overrides,
  };
}

describe("routing plan parsing", () => {
  it("reads a ranked route's forecasts and the policy it was ranked under", () => {
    const plan = parseRoutingPlan(wirePlan());
    expect(plan).toMatchObject({ policyId: "outcome-per-dollar", policyVersion: 3, currency: "USD" });
    expect(plan?.ranked[0]).toEqual({
      provider: "anthropic", model: "claude-sonnet-5", eligible: true,
      reason: "highest predicted outcome within budget", score: 0.86,
      estimatedMicros: 12_000, expectedTotalMicros: 31_000, expectedAttempts: 1.1,
      expectedLatencyMs: 4_200, completedQuality: 0.88, outcomePerDollar: 28.4, fundingSource: "platform",
    });
  });

  it("keeps an empty ranking as an answer rather than treating it as malformed", () => {
    const plan = parseRoutingPlan(wirePlan({
      ranked: [],
      excluded: [{ provider: "groq", model: "llama-3.3-70b-versatile", eligible: false, reason: "provider credential is unavailable" }],
    }));
    expect(plan).not.toBeNull();
    expect(plan?.ranked).toEqual([]);
    expect(plan?.excluded).toEqual([{ provider: "groq", model: "llama-3.3-70b-versatile", eligible: false, reason: "provider credential is unavailable" }]);
  });

  it("never lets a removed route claim eligibility, whatever the service said", () => {
    const plan = parseRoutingPlan(wirePlan({ excluded: [{ provider: "groq", model: "m", eligible: true, reason: "removed" }] }));
    expect(plan?.excluded[0]?.eligible).toBe(false);
  });

  it("drops a route with no model instead of failing the whole plan", () => {
    const plan = parseRoutingPlan(wirePlan({ ranked: [{ candidate: { provider: "openai" }, eligible: true }, ...wirePlan().ranked] }));
    expect(plan?.ranked).toHaveLength(1);
    expect(plan?.ranked[0]?.model).toBe("claude-sonnet-5");
  });

  it("returns null for anything that is not a plan", () => {
    for (const value of [null, undefined, 7, "plan", {}, { object: "routing_plan" }]) {
      expect(parseRoutingPlan(value)).toBeNull();
    }
  });

  it("quotes forecasts in the currency the routes state, defaulting to USD", () => {
    const rwf = wirePlan();
    rwf.ranked[0]!.estimated_charged = { currency: "RWF", micros: 900 };
    expect(parseRoutingPlan(rwf)?.currency).toBe("RWF");
    expect(parseRoutingPlan({ ranked: [], excluded: [] })?.currency).toBe("USD");
  });
});
