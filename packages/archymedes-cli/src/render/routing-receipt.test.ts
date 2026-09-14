import { describe, expect, it } from "vitest";
import type { RoutingReceipt } from "@archymedes/core/providers/routing-receipt";
import { formatMicros, renderRoutingReceipt, renderRoutingSummary } from "./routing-receipt";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../text/glyphs";
import { visibleWidth } from "../text/text-width";
import { buildPalette, builtinThemes, findBuiltinTheme } from "../theme/theme";
import type { SectionStyle } from "./sections";

const style: SectionStyle = { width: 84, depth: "none" };

const receipt: RoutingReceipt = {
  taskId: "cli_7",
  chosen: { model: "claude-sonnet-5", provider: "anthropic" },
  considered: [
    { model: "claude-sonnet-5", provider: "anthropic", eligible: true, reason: "best score within budget", estimatedMicros: 12_000, score: 0.86 },
    { model: "gpt-5.6-terra", provider: "openai", eligible: true, reason: "cheaper, below quality margin", estimatedMicros: 9_000, score: 0.81 },
    { model: "gemini-2.5-pro", provider: "google", eligible: false, reason: "region policy: not in us" },
  ],
  policy: { dataPolicy: "zero-retention", region: "us", qualityFloor: 0.8, maximumMicros: 5_000_000 },
  currency: "USD",
  estimatedMicros: 12_000,
  actualMicros: 9_800,
  retries: 1,
  latencyMs: 1_420,
  outcomeScore: 0.9,
};

describe("formatMicros", () => {
  it("renders micros as a trimmed currency amount", () => {
    expect(formatMicros(9_800, "USD")).toBe("USD 0.0098");
    expect(formatMicros(5_000_000, "USD")).toBe("USD 5");
    expect(formatMicros(0, "EUR")).toBe("EUR 0");
    expect(formatMicros(undefined)).toBe("—");
  });
});

describe("renderRoutingReceipt", () => {
  it("shows the chosen route, the policy it was held to, cost vs estimate, and every route weighed", () => {
    const rendered = renderRoutingReceipt(receipt, style);
    expect(rendered).toContain("routing");
    expect(rendered).toContain("outcome 0.90");
    expect(rendered).toContain("anthropic/claude-sonnet-5");
    expect(rendered).toContain("zero-retention · region us · floor 0.80 · cap USD 5");
    expect(rendered).toContain("est USD 0.012 · actual USD 0.0098 · 1 retry · 1.4s");
    expect(rendered).toContain("considered");
    expect(rendered).toContain("openai/gpt-5.6-terra");
    expect(rendered).toContain("cheaper, below quality margin");
    expect(rendered).toContain("region policy: not in us");
  });

  it("flags an actual charge above the estimate", () => {
    const palette = buildPalette(findBuiltinTheme("archymedes")!, "truecolor");
    const over = renderRoutingReceipt({ ...receipt, estimatedMicros: 5_000, actualMicros: 9_800 }, { ...style, depth: "truecolor", palette });
    expect(over).toContain(palette.warning);
  });

  it("omits sections it has no data for", () => {
    const thin = renderRoutingReceipt({ chosen: { model: "auto-1" }, considered: [], policy: {}, retries: 0 }, style);
    expect(thin).toContain("auto-1");
    expect(thin).not.toContain("policy");
    expect(thin).not.toContain("considered");
    expect(thin).not.toContain("outcome");
  });

  it("stays within the width across themes, depths, glyph sets and narrow terminals", () => {
    for (const width of [24, 40, 60, 84, 120]) {
      for (const theme of builtinThemes()) {
        for (const depth of ["none", "ansi256", "truecolor"] as const) {
          for (const glyphs of [ASCII_GLYPHS, UNICODE_GLYPHS]) {
            const wide: RoutingReceipt = {
              ...receipt,
              chosen: { model: "m".repeat(120), provider: "p".repeat(40) },
              considered: receipt.considered.map((route) => ({ ...route, reason: route.reason.repeat(12), model: route.model.repeat(8) })),
            };
            const rendered = renderRoutingReceipt(wide, { width, depth, glyphs, palette: buildPalette(theme, depth) });
            for (const line of rendered.split("\n")) {
              expect(visibleWidth(line), `${width}/${theme.name}/${depth} too wide`).toBeLessThanOrEqual(width);
            }
            if (depth === "none") expect(rendered).not.toContain("\x1b");
          }
        }
      }
    }
  });
});


it("summarizes currencies independently and discloses missing settlements", () => {
  const rendered = renderRoutingSummary([receipt, { ...receipt, currency: "EUR", actualMicros: 200 }, { ...receipt, actualMicros: undefined, chosen: { provider: "other", model: "m" } }], style);
  expect(rendered).toContain("3 calls · 3 retries · 1 route switches");
  expect(rendered).toContain("actual USD 0.0098 (1 settled)");
  expect(rendered).toContain("actual EUR 0.0002 (1 settled)");
  expect(rendered).toContain("1 calls without settlement data");
  for (const line of renderRoutingSummary([receipt], { ...style, width: 24 }).split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
});

it("marks only the selected provider when multiple providers host the same model", () => {
  const rendered = renderRoutingReceipt({ ...receipt, chosen: { provider: "a", model: "shared" }, considered: [
    { provider: "a", model: "shared", eligible: true, reason: "" },
    { provider: "b", model: "shared", eligible: true, reason: "" },
  ], attempts: [{ provider: "b", model: "shared", outcome: "rate_limited", latencyMs: 500 }] }, style);
  expect(rendered).toContain("✓ a/shared");
  expect(rendered).not.toContain("✓ b/shared");
  expect(rendered).toContain("rate_limited");
});

it("labels cost and quality forecasts without inventing a measured outcome", () => {
  const rendered = renderRoutingReceipt({ chosen: { model: "m" }, policy: {}, considered: [], retries: 0,
    expectedTotalMicros: 200, predictedOutcomeScore: 0.85, costFactors: { retryMicros: 25, cacheSavingMicros: 10 } }, style);
  expect(rendered).toContain("expected task cost USD 0.0002");
  expect(rendered).toContain("predicted quality 0.85");
  expect(rendered).toContain("cache savings USD 0.00001");
  expect(rendered).not.toContain("outcome 0.85");
});
