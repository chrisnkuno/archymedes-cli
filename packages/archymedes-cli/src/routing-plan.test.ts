import { describe, expect, it } from "vitest";
import type { RoutingPlan } from "@archymedes/core/providers/routing-plan";
import { renderRoutingPlan } from "./routing-plan";
import { ASCII_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";
import type { SectionStyle } from "./sections";

const style: SectionStyle = { width: 84, depth: "none" };

const plan: RoutingPlan = {
  policyId: "outcome-per-dollar",
  policyVersion: 3,
  currency: "USD",
  ranked: [
    { provider: "anthropic", model: "claude-sonnet-5", eligible: true, reason: "highest predicted outcome within budget", score: 0.86, estimatedMicros: 12_000, expectedTotalMicros: 31_000, expectedAttempts: 1.1, expectedLatencyMs: 4_200, completedQuality: 0.88, outcomePerDollar: 28.4, fundingSource: "platform" },
    { provider: "openai", model: "gpt-5.6-terra", eligible: true, reason: "cheaper, below the quality floor", score: 0.81, expectedTotalMicros: 21_000, completedQuality: 0.79 },
  ],
  excluded: [],
};

describe("renderRoutingPlan", () => {
  it("shows what would run, what it would cost for the whole task, and that it is a forecast", () => {
    const rendered = renderRoutingPlan(plan, style);
    expect(rendered).toContain("routing plan");
    expect(rendered).toContain("outcome-per-dollar v3");
    // The panel must say once, plainly, that nothing here has been spent.
    expect(rendered).toContain("forecast only — nothing reserved, no model called");
    expect(rendered).toContain("anthropic/claude-sonnet-5");
    expect(rendered).toContain("~USD 0.031 task");
    expect(rendered).toContain("quality 0.88");
    expect(rendered).toContain("4.2s");
    expect(rendered).toContain("highest predicted outcome within budget");
  });

  it("marks a predicted charge as approximate, never as a settled amount", () => {
    // A bare "USD 0.031" beside a real charge is the confusion this whole panel exists to avoid.
    expect(renderRoutingPlan(plan, style)).not.toMatch(/(?<!~)USD 0\.031/);
  });

  it("renders no capacity as an explicit warning, not as an empty success", () => {
    const rendered = renderRoutingPlan({
      ...plan,
      ranked: [],
      excluded: [{ provider: "groq", model: "llama-3.3-70b-versatile", eligible: false, reason: "provider credential is unavailable" }],
    }, style);
    expect(rendered).toContain("no route available");
    expect(rendered).toContain("unavailable");
    expect(rendered).toContain("groq/llama-3.3-70b-versatile");
    expect(rendered).toContain("provider credential is unavailable");
    expect(rendered).not.toContain("would use");
  });

  it("says so when the exchange offers neither a route nor a reason", () => {
    const rendered = renderRoutingPlan({ currency: "USD", ranked: [], excluded: [] }, style);
    expect(rendered).toContain("no route available");
    expect(rendered).toContain("gave no reason");
  });

  it("keeps an unavailable provider out of the ranking it never competed in", () => {
    const rendered = renderRoutingPlan({ ...plan, excluded: [{ provider: "groq", model: "m", eligible: false, reason: "provider credential is unavailable" }] }, style);
    const wouldUse = rendered.indexOf("would use");
    const unavailable = rendered.indexOf("unavailable");
    expect(wouldUse).toBeGreaterThanOrEqual(0);
    expect(unavailable).toBeGreaterThan(wouldUse);
    expect(rendered.slice(wouldUse, unavailable)).not.toContain("groq");
  });

  it("names the funding source when a route would be paid with the user's own key", () => {
    const byok = { ...plan, ranked: [{ ...plan.ranked[0]!, fundingSource: "byok" as const }] };
    expect(renderRoutingPlan(byok, style)).toContain("your key");
  });

  it("stays inside a narrow terminal and survives an ascii-only one", () => {
    for (const width of [24, 32, 48, 84]) {
      const narrow: SectionStyle = { width, depth: "none", glyphs: ASCII_GLYPHS };
      for (const line of renderRoutingPlan(plan, narrow).split("\n")) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
