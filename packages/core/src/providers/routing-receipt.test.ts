import { describe, expect, it } from "vitest";
import { buildTaskProfile, parseRoutingReceipt } from "./routing-receipt";

describe("buildTaskProfile", () => {
  it("emits only the fields that carry a decision", () => {
    expect(buildTaskProfile({ kind: "coding" })).toEqual({ kind: "coding" });
    expect(buildTaskProfile({
      kind: "security",
      requiredCapabilities: ["tools", "  ", "reasoning"],
      dataPolicy: "zero-retention",
      region: "  eu ",
      qualityFloor: 0.8,
    })).toEqual({
      kind: "security",
      requiredCapabilities: ["tools", "reasoning"],
      dataPolicy: "zero-retention",
      region: "eu",
      qualityFloor: 0.8,
    });
  });

  it("drops a standard data policy, a zero quality floor and an empty capability list", () => {
    expect(buildTaskProfile({ kind: "research", dataPolicy: "standard", qualityFloor: 0, requiredCapabilities: [] }))
      .toEqual({ kind: "research" });
  });

  it("clamps the quality floor into 0..1", () => {
    expect(buildTaskProfile({ kind: "design", qualityFloor: 2 }).qualityFloor).toBe(1);
  });
});

describe("parseRoutingReceipt", () => {
  it("reads a full receipt", () => {
    const receipt = parseRoutingReceipt({
      task_id: "cli_7",
      chosen: { model: "claude-sonnet-5", provider: "anthropic" },
      considered: [
        { model: "claude-sonnet-5", provider: "anthropic", eligible: true, reason: "best score within budget", estimatedMicros: 12000, score: 0.86 },
        { model: "gpt-5.6-terra", provider: "openai", eligible: true, reason: "cheaper, below quality margin", estimated_micros: 9000, score: 0.81 },
        { model: "gemini-2.5-pro", provider: "google", eligible: false, reason: "region policy" },
      ],
      policy: { data_policy: "zero-retention", region: "us", quality_floor: 0.8, maximum_micros: 5000000 },
      currency: "usd",
      estimated_micros: 12000,
      actual_micros: 9800,
      retries: 1,
      latency_ms: 1420,
      outcome_score: 0.9,
    });
    expect(receipt).toEqual({
      taskId: "cli_7",
      chosen: { model: "claude-sonnet-5", provider: "anthropic" },
      considered: [
        { model: "claude-sonnet-5", provider: "anthropic", eligible: true, reason: "best score within budget", estimatedMicros: 12000, score: 0.86 },
        { model: "gpt-5.6-terra", provider: "openai", eligible: true, reason: "cheaper, below quality margin", estimatedMicros: 9000, score: 0.81 },
        { model: "gemini-2.5-pro", provider: "google", eligible: false, reason: "region policy" },
      ],
      policy: { dataPolicy: "zero-retention", region: "us", qualityFloor: 0.8, maximumMicros: 5000000 },
      currency: "USD",
      estimatedMicros: 12000,
      actualMicros: 9800,
      retries: 1,
      latencyMs: 1420,
      outcomeScore: 0.9,
    });
  });

  it("accepts a thin receipt with only a chosen model", () => {
    expect(parseRoutingReceipt({ chosen: { model: "auto-1" } })).toEqual({
      chosen: { model: "auto-1" },
      considered: [],
      policy: {},
      retries: 0,
    });
  });

  it("returns null for anything that is not a receipt", () => {
    expect(parseRoutingReceipt(undefined)).toBeNull();
    expect(parseRoutingReceipt({})).toBeNull();
    expect(parseRoutingReceipt({ chosen: {} })).toBeNull();
    expect(parseRoutingReceipt("nope")).toBeNull();
    expect(parseRoutingReceipt({ chosen: { model: "  " } })).toBeNull();
  });

  it("clamps scores, floors negatives, and defaults a missing retry count to zero", () => {
    const receipt = parseRoutingReceipt({
      chosen: { model: "m" },
      considered: [{ model: "m", score: 5 }, { model: "n", score: -1 }, { bogus: true }],
      outcome_score: 9,
      retries: -3,
      latency_ms: -10,
    });
    expect(receipt?.considered).toEqual([
      { model: "m", eligible: true, reason: "", score: 1 },
      { model: "n", eligible: true, reason: "", score: 0 },
    ]);
    expect(receipt?.outcomeScore).toBe(1);
    expect(receipt?.retries).toBe(0);
    expect(receipt?.latencyMs).toBeUndefined();
  });
});
