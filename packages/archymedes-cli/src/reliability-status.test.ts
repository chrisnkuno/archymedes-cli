import { describe, expect, it } from "vitest";
import { renderReliabilityStatus } from "./reliability-status";

const snapshot = {
  score: 97.6,
  grade: "excellent",
  generatedAt: "2026-08-23T02:00:00.000Z",
};

describe("the startup reliability signal", () => {
  it("labels bundled measurements without an unsupported improvement claim", () => {
    expect(renderReliabilityStatus(100, "·", snapshot)).toBe(
      "bundled benchmark 98/100 · measured 2026-08-23",
    );
  });

  it("keeps the useful signal in a narrow terminal", () => {
    const rendered = renderReliabilityStatus(40, ".", snapshot);
    expect(rendered).toBe("benchmark 98/100 . 2026-08-23");
    expect(rendered.length).toBeLessThanOrEqual(40);
  });

  it("bounds corrupt scores instead of printing nonsense", () => {
    expect(
      renderReliabilityStatus(40, "·", { ...snapshot, score: 900 }),
    ).toContain("100/100");
    expect(
      renderReliabilityStatus(40, "·", { ...snapshot, score: -2 }),
    ).toContain("0/100");
    expect(renderReliabilityStatus(80, "·", { ...snapshot, score: NaN })).toContain("unavailable");
  });
});
