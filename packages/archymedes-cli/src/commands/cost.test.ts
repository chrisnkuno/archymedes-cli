import type { TurnCost } from "@archymedes/core/cli/cost";
import { describe, expect, it } from "vitest";
import { UNICODE_GLYPHS } from "../text/glyphs";
import { renderCostReport } from "./cost";

const same = (text: string) => text;
const turn = (turnNumber: number, micros: number, elapsedMs = 1_000): TurnCost => ({
  turnNumber, iterations: 1, toolCalls: 0, elapsedMs,
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } as TurnCost["usage"],
  cost: { currency: "USD", micros },
});

const context = (history: TurnCost[]) => ({
  report: "TOTALS", history, display: "USD" as const, rates: [],
  paint: { dim: same, cyan: same, green: same, yellow: same, bold: same },
  glyphs: UNICODE_GLYPHS, depth: "none" as const, width: 80,
});

describe("/cost", () => {
  it("shows only the totals for a single turn", () => {
    expect(renderCostReport(context([turn(1, 1_000)]))).toBe("TOTALS\n");
  });

  it("adds the turn table, spend bars limited to the last dozen, and throughput once there are enough turns", () => {
    const history = Array.from({ length: 14 }, (_, i) => turn(i + 1, (i + 1) * 1_000));
    const text = renderCostReport(context(history));
    expect(text.startsWith("TOTALS\n")).toBe(true);
    expect(text).toContain("spend per turn (last 12 of 14)");
    expect(text).toContain("turn 14");
    expect(text).not.toMatch(/turn 2\b/);
    expect(text).toContain("tokens/sec per turn");
  });
});
