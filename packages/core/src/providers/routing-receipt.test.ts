import { describe, expect, it } from "vitest";
import { buildTaskProfile, parseRoutingReceipt, mergeRoutingReceipts } from "./routing-receipt";

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

  it("preserves utility scores, clamps outcome quality, and defaults invalid retries", () => {
    const receipt = parseRoutingReceipt({
      chosen: { model: "m" },
      considered: [{ model: "m", score: 5 }, { model: "n", score: -1 }, { bogus: true }],
      outcome_score: 9,
      retries: -3,
      latency_ms: -10,
    });
    expect(receipt?.considered).toEqual([
      { model: "m", eligible: true, reason: "", score: 5 },
      { model: "n", eligible: true, reason: "", score: -1 },
    ]);
    expect(receipt?.outcomeScore).toBe(1);
    expect(receipt?.retries).toBe(0);
    expect(receipt?.latencyMs).toBeUndefined();
  });
});


it("reads the private gateway protocol receipt including fallback evidence", () => {
  const receipt = parseRoutingReceipt({
    requestId: "cli_1", selectedProvider: "p", selectedModel: "m", policyId: "balanced", policyVersion: 2,
    considered: [{ provider: "p", model: "m", eligible: true, score: 25.4, reason: "best outcome" }],
    estimated: { currency: "USD", micros: 100 }, actual: { currency: "USD", micros: 80 },
    attempts: [
      { provider: "q", model: "n", outcome: "rate_limited", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z" },
      { provider: "p", model: "m", outcome: "succeeded", startedAt: "2026-01-01T00:00:01Z", completedAt: "2026-01-01T00:00:03Z" },
    ],
  });
  expect(receipt).toMatchObject({ taskId: "cli_1", chosen: { provider: "p", model: "m" }, policyId: "balanced", policyVersion: 2, currency: "USD", estimatedMicros: 100, actualMicros: 80, retries: 1, latencyMs: 3000 });
  expect(receipt?.considered[0].score).toBe(25.4);
  expect(receipt?.attempts?.map((attempt) => attempt.outcome)).toEqual(["rate_limited", "succeeded"]);
});

it("keeps hosted forecasts distinct from evaluated results and uses total latency", () => {
  const receipt = parseRoutingReceipt({ selectedProvider: "p", selectedModel: "m", expectedTotalMicros: 200, predictedOutcomeScore: 0.85,
    finalOutcomeScore: null, totalLatencyMs: 1500, factors: { retry_micros: 25, cache_saving_micros: 10, non_model_micros: -1 } });
  expect(receipt).toMatchObject({ expectedTotalMicros: 200, predictedOutcomeScore: 0.85, latencyMs: 1500, costFactors: { retryMicros: 25, cacheSavingMicros: 10 } });
  expect(receipt?.outcomeScore).toBeUndefined();
  expect(parseRoutingReceipt({ selectedModel: "m", finalOutcomeScore: 0.7 })?.outcomeScore).toBe(0.7);
});

describe("stored routing receipts", () => {
  const receipt = { taskId: "call_1", chosen: { model: "test" }, considered: [], policy: {}, currency: "USD", retries: 1, latencyMs: 42,
    attempts: [{ model: "test", outcome: "success", latencyMs: 42 }], costFactors: { retryMicros: 10 }, actualMicros: 100 };
  it("round-trips all normalized fields", () => {
    expect(parseRoutingReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });
  it("deduplicates identified calls and preserves settlement on partial replay", () => {
    expect(mergeRoutingReceipts([receipt], [{ ...receipt, actualMicros: undefined }])).toEqual([receipt]);
    expect(mergeRoutingReceipts([receipt], [{ ...receipt, actualMicros: 120 }])[0].actualMicros).toBe(120);
    expect(mergeRoutingReceipts([receipt], [{ ...receipt, currency: "EUR", actualMicros: undefined }])[0].actualMicros).toBeUndefined();
  });
  it("ignores malformed records without collapsing unidentified legacy calls", () => {
    const legacy = { ...receipt, taskId: undefined };
    expect(mergeRoutingReceipts(null, {}, [null, {}, { chosen: {} }, legacy, legacy])).toHaveLength(2);
  });
});
