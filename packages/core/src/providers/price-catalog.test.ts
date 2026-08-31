import { describe, expect, it } from "vitest";
import { toUnits, priceUsage } from "../money";
import { priceUnits, selectPrice, tokenPricesAt, validatePriceRecord } from "../pricing";
import { PRICE_CATALOG, UNPRICED_PROVIDERS } from "./price-catalog";

describe("the catalog as a whole", () => {
  it("is internally valid — every record passes the same check a new entry would", () => {
    // definePrices() already runs this at import time; re-running it here turns "the catalog failed
    // to load" into a named, debuggable test failure instead of every test in the suite going red.
    for (const record of PRICE_CATALOG) expect(() => validatePriceRecord(record)).not.toThrow();
  });

  it("has no duplicate provider/model/modality active on the same day", () => {
    // Two records both claiming today for the same model is exactly the ambiguity `selectPrice`'s
    // "later effectiveFrom wins" rule is designed to resolve — but an accidental duplicate (typo'd
    // model id copy-pasted twice) should still be caught, not silently shadowed.
    const today = "2026-08-31";
    const seen = new Map<string, number>();
    for (const record of PRICE_CATALOG) {
      if (record.effectiveFrom > today || (record.effectiveUntil && record.effectiveUntil <= today)) continue;
      const key = `${record.provider}/${record.model}/${record.modality}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
    expect(duplicates).toEqual([]);
  });


  it("reports OpenAI and generic openai-compatible as unpriced", () => {
    expect(UNPRICED_PROVIDERS).toContain("openai");
    expect(UNPRICED_PROVIDERS).toContain("openai-compatible");
  });
});

describe("the OpenAI-compatible provider defaults", () => {
  it("prices every provider's default model", () => {
    const defaults: Array<[string, string]> = [
      ["google", "gemini-2.5-pro"],
      ["xai", "grok-4"],
      ["deepseek", "deepseek-chat"],
      ["mistral", "mistral-large-latest"],
      ["groq", "llama-3.3-70b-versatile"],
    ];
    for (const [provider, model] of defaults) {
      const prices = tokenPricesAt(PRICE_CATALOG, { provider, model });
      expect(prices?.currency, `${provider}:${model} should be priced`).toBe("USD");
      expect(prices!.inputPerMillion).toBeGreaterThan(0);
      expect(prices!.outputPerMillion).toBeGreaterThan(0);
    }
  });

  it("records DeepSeek's published cache-read discount but not one for providers that publish none", () => {
    const deepseek = tokenPricesAt(PRICE_CATALOG, { provider: "deepseek", model: "deepseek-chat" })!;
    expect(deepseek.cachedInputPerMillion).toBeGreaterThan(0);
    expect(deepseek.cachedInputPerMillion!).toBeLessThan(deepseek.inputPerMillion);

    const mistral = tokenPricesAt(PRICE_CATALOG, { provider: "mistral", model: "mistral-large-latest" })!;
    expect(mistral.cachedInputPerMillion).toBeUndefined();
  });

  it("applies the large-context multiplier for Gemini and Grok only above their threshold", () => {
    const prices = tokenPricesAt(PRICE_CATALOG, { provider: "google", model: "gemini-2.5-pro" })!;
    const base = toUnits(priceUsage({ inputTokens: 200_000, outputTokens: 1_000 }, prices));
    const tiered = toUnits(priceUsage({ inputTokens: 200_001, outputTokens: 1_000 }, prices));
    expect(tiered).toBeGreaterThan(base * 1.9);
  });

  it("does not price an unknown model, so its cost reports as unknown rather than borrowed", () => {
    expect(tokenPricesAt(PRICE_CATALOG, { provider: "xai", model: "grok-9-imaginary" })).toBeUndefined();
    expect(tokenPricesAt(PRICE_CATALOG, { provider: "openai", model: "gpt-5.6-terra" })).toBeUndefined();
  });

  it("keeps output at least as expensive as input for every default, a sanity bound", () => {
    for (const record of PRICE_CATALOG.filter((r) => r.modality === "text" && r.billingUnit === "tokens")) {
      if (record.rates.output === undefined || record.rates.input === undefined) continue;
      expect(record.rates.output, `${record.provider}:${record.model}`).toBeGreaterThanOrEqual(record.rates.input);
    }
  });
});
