import { describe, expect, it } from "vitest";
import {
  buildOutcomeEvent,
  costBucket,
  durationBucket,
  FEATURE_STRING,
  normaliseModelId,
  OUTCOME_FEATURE_KEYS,
  OUTCOME_SCHEMA,
  taskFeatures,
  taskOutcomeInput,
  validateOutcomeEvent,
  type TaskOutcomeInput,
} from "./outcomes";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const context = { installId: "6f1c1f9e-6a43-4c55-9d0e-2b1b7d3f0a11", grantedAt: "2026-10-01T00:00:00.000Z", appVersion: "3.12.6", now: Date.parse("2026-11-01T12:00:00Z") };

/** A small deterministic PRNG (mulberry32), so a failing property case is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("outcome event builder", () => {
  it("builds a valid archymedes.outcome/v1 task event", () => {
    const event = buildOutcomeEvent({
      engine: "archymedes", provider: "anthropic", model: "anthropic/claude-sonnet-4.5", effort: "high",
      status: "completed", toolCalls: 7, iterations: 4, repairs: 1, elapsedMs: 42_000, actualModelRwf: 350,
      routingReceipts: [{ chosen: { model: "x" }, considered: [], policy: {}, retries: 2, predictedOutcomeScore: 0.82, outcomeScore: 0.74 }],
    }, context);
    expect(event).toMatchObject({
      schema: OUTCOME_SCHEMA, product: "friday", kind: "task", installId: context.installId, appVersion: "3.12.6",
      occurredAt: "2026-11-01T12:00:00.000Z", consent: { scope: "outcomes", grantedAt: context.grantedAt },
      prediction: { label: "completed", p: 0.82 }, outcome: { label: "completed", value: 1 },
    });
    expect(event.id).toMatch(UUID_V4);
    expect(event.features).toEqual({
      engine: "archymedes", route: "exchange", provider: "anthropic", model: "anthropic:claude-sonnet-4.5", effort: "high",
      tool_calls: 7, repairs: 1, turns: 4, duration_bucket: "lt_1m", cost_bucket_rwf: "lt_1k", reliability_bucket: 0.7, exit_status: "completed",
    });
    expect(validateOutcomeEvent(event)).toEqual([]);
  });

  it("omits prediction when no route predicted one, and scores a failed task 0", () => {
    const event = buildOutcomeEvent({ engine: "claude", status: "failed" }, context);
    expect(event.prediction).toBeUndefined();
    expect(event.outcome).toEqual({ label: "failed", value: 0 });
    expect(event.features).toMatchObject({ engine: "claude", route: "direct", exit_status: "failed", tool_calls: 0, turns: 0, repairs: 0 });
  });

  it("normalises model ids to the feature alphabet and refuses anything path- or prose-shaped", () => {
    expect(normaliseModelId("anthropic/claude-sonnet-4.5")).toBe("anthropic:claude-sonnet-4.5");
    expect(normaliseModelId("GPT-4o")).toBe("gpt-4o");
    expect(normaliseModelId("llama3.1:8b")).toBe("llama3.1:8b");
    expect(normaliseModelId("models/gemini-2.5-pro@001")).toBe("models:gemini-2.5-pro-001");
    for (const unsafe of ["/home/me/models/llama.gguf", "~/m.bin", "C:\\models\\x", "./local", "a/b/c", "weights/model.safetensors", "fix the bug", "", "x".repeat(200)]) {
      expect(normaliseModelId(unsafe)).toBe("custom");
    }
  });

  it("reports public models by family and collapses anything that could name a customer to custom", () => {
    for (const publicId of ["gpt-4o", "gpt-4o-mini", "o3-mini", "claude-sonnet-4-5-20250929", "gemini-2.5-pro", "deepseek-chat", "mistral-large-latest", "qwen2.5-coder-32b-instruct", "meta-llama/llama-3.3-70b-instruct:free", "openai/gpt-4o", "llama3.1:8b", "grok-4", "mixtral-8x7b-instruct"]) {
      expect(normaliseModelId(publicId), publicId).not.toBe("custom");
    }
    const sensitive = [
      "ft:gpt-4o:contoso-legal", "ft:gpt-4o-mini:acme:9f86d081884c7d659a2feaa0c55ad015", "ft:gpt-4o-mini-2024-07-18:acme-corp::AbC123xY",
      "ollama:acme-payroll-v2", "gpt-4o-acme-prod", "gpt-4-contoso-hr-bot", "claude-sonnet-4-5-globex-claims", "llama3.1-8b-initech-support",
      "azure/contoso-deployment-1", "my-company-llm", "acme-assistant", "internal-finance-7b", "projectx", "customer-1234-gpt", "legal-gpt",
    ];
    for (const id of sensitive) expect(normaliseModelId(id), id).toBe("custom");
  });

  it("never lets a sensitive model id reach an event, the queue's serialised form, or a batch body", () => {
    const secret = "ft:gpt-4o:contoso-legal";
    const event = buildOutcomeEvent(
      { engine: "archymedes", provider: "openai", model: secret, status: "completed", toolCalls: 1, iterations: 1, elapsedMs: 1, routingReceipts: [{ chosen: { model: secret }, considered: [{ model: secret, eligible: true, reason: secret }], policy: {}, retries: 0, predictedOutcomeScore: 0.5, outcomeScore: 0.5 }] },
      { installId: "00000000-0000-4000-8000-000000000000", grantedAt: "2026-11-01T00:00:00.000Z", appVersion: "3.12.8", now: Date.parse("2026-11-01T12:00:00Z") },
    );
    expect(event.features.model).toBe("custom");
    expect(JSON.stringify({ events: [event] })).not.toMatch(/contoso|legal/i);
  });

  it("buckets duration and cost instead of sending exact values", () => {
    expect([5_000, 30_000, 120_000, 600_000, 3_600_000].map(durationBucket)).toEqual(["lt_10s", "lt_1m", "lt_5m", "lt_30m", "gte_30m"]);
    expect([0, 5, 50, 500, 5_000, 50_000].map(costBucket)).toEqual(["0", "lt_10", "lt_100", "lt_1k", "lt_10k", "gte_10k"]);
  });

  it("never leaks free text: random prompts, paths, repo names and errors stay out of every event", () => {
    const random = rng(20261101);
    const word = () => `zq${Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join("")}`;
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const prose = () => Array.from({ length: 2 + Math.floor(random() * 6) }, word).join(pick([" ", "  ", "\n", " - ", ", "]));
    const filePath = () => pick([
      () => `/home/${word()}/${word()}/${word()}.ts`,
      () => `${word()}/${word()}/${word()}.go`,
      () => `${word()}/${word()}.py`,
      () => `C:\\Users\\${word()}\\${word()}.rs`,
      () => `~/${word()}/.env`,
      () => `./${word()}`,
    ])();
    const freeText = () => (random() < 0.5 ? prose() : filePath());

    for (let run = 0; run < 500; run += 1) {
      const secrets: string[] = [];
      const leak = () => { const text = freeText(); secrets.push(...text.match(/zq[a-z]{8}/g)!); return text; };
      const input = {
        engine: random() < 0.3 ? leak() : pick(["archymedes", "claude", "codex", "terminal"]),
        provider: random() < 0.3 ? leak() : pick(["anthropic", "openai", "free", "claude"]),
        model: random() < 0.5 ? leak() : pick(["gpt-4o", "anthropic/claude-opus-4"]),
        effort: random() < 0.3 ? leak() : pick(["low", "high"]),
        status: random() < 0.3 ? leak() : pick(["completed", "failed", "cancelled"]),
        toolCalls: Math.floor(random() * 50), iterations: Math.floor(random() * 20), repairs: Math.floor(random() * 3),
        elapsedMs: Math.floor(random() * 4_000_000), actualModelRwf: random() * 20_000,
        // Fields a caller might pass along by accident — the builder must not read them.
        summary: leak(), prompt: leak(), root: leak(), files: [leak(), leak()], error: new Error(leak()),
        messages: [{ role: "user", content: leak() }, { role: "assistant", content: leak() }],
        routingReceipts: [{ chosen: { model: leak(), provider: leak() }, considered: [{ model: leak(), eligible: true, reason: leak() }], policy: { region: leak() }, retries: 1, taskId: leak() }],
      } as TaskOutcomeInput & Record<string, unknown>;
      const event = buildOutcomeEvent(input, context);
      const wire = JSON.stringify(event);
      for (const secret of secrets) expect(wire, `run ${run} leaked ${secret}`).not.toContain(secret);
      expect(validateOutcomeEvent(event), `run ${run}`).toEqual([]);
      const features = taskFeatures(input);
      expect(Object.keys(features).length).toBeLessThanOrEqual(64);
      for (const [key, value] of Object.entries(features)) {
        expect(OUTCOME_FEATURE_KEYS).toContain(key);
        if (typeof value === "string") expect(value).toMatch(FEATURE_STRING);
        else expect(["number", "boolean"]).toContain(typeof value);
      }
      expect(event.prediction?.label ?? "completed").toMatch(FEATURE_STRING);
      expect(event.outcome.label).toMatch(FEATURE_STRING);
    }
  });

  it("rejects events that break the contract", () => {
    const event = buildOutcomeEvent({ status: "completed" }, context);
    expect(validateOutcomeEvent({ ...event, features: { prompt: "fix the bug" } })).not.toEqual([]);
    expect(validateOutcomeEvent({ ...event, id: "not-a-uuid" })).not.toEqual([]);
    expect(validateOutcomeEvent({ ...event, features: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 1])) })).not.toEqual([]);
  });

  it("reads a runtime result into an outcome input, taking only counts, status and routing", () => {
    const result = {
      status: "completed", summary: "Edited /home/me/repo/src/main.ts", messages: [{ role: "user", content: "secret prompt" }],
      usage: {}, actualModelRwf: 12, iterations: 3, toolCallsExecuted: 5, routingReceipts: [],
    };
    expect(taskOutcomeInput(result, { engine: "archymedes", provider: "openai", model: "gpt-4o", effort: "low", elapsedMs: 1_000 })).toEqual({
      engine: "archymedes", provider: "openai", model: "gpt-4o", effort: "low", status: "completed",
      toolCalls: 5, iterations: 3, actualModelRwf: 12, routingReceipts: [], elapsedMs: 1_000,
    });
    expect(taskOutcomeInput({ status: "failed", summary: "boom" }, { engine: "claude" })).toEqual({ engine: "claude", status: "failed" });
  });
});
