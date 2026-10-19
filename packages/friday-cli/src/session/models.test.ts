import { describe, expect, it } from "vitest";
import { describePrice, modelsForProvider } from "./models";

describe("the model catalog", () => {

  it("puts each provider's default first, since it is what doing nothing gives you", () => {
    const models = modelsForProvider("anthropic");
    expect(models[0]).toBe("claude-sonnet-5");
    expect(models).toContain("claude-opus-5");
    expect(new Set(models).size).toBe(models.length); // no duplicates
  });
});

describe("pricing a model for display", () => {
  const prices = { currency: "RWF" as const, inputPerMillion: 1_610_000_000, outputPerMillion: 9_660_000_000 };

  it("falls back to the provider's own currency when no rate can convert it", () => {
    // The bug this closes: the fallback used `fromUnits`, which multiplies by a million — but these
    // are already micros. A 1,610 RWF rate rendered as "RWF 1,610,000,000", wrong by six orders of
    // magnitude, on the one path that only appears when an exchange rate is missing.
    const rendered = describePrice(prices, "USD", () => undefined);
    expect(rendered).toContain("1,610");
    expect(rendered).not.toContain("1,610,000,000");
    expect(rendered).toContain("per Mtok");
  });

  it("uses the converted amount when a rate is available", () => {
    const rendered = describePrice(prices, "USD", (value) => ({ currency: "USD", micros: value.micros / 1_320 }));
    expect(rendered).toContain("$");
  });

  it("says so plainly when there is no price at all", () => {
    expect(describePrice(undefined, "USD", () => undefined)).toBe("unpriced");
  });
});
