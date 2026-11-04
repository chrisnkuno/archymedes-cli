import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateOutcomeBatch, validateOutcomeEvent as serverValidate } from "./outcome-protocol";
import { buildOutcomeEvent, normaliseModelId, validateOutcomeEvent } from "./outcomes";

/** The protocol's own source, present in a maintainer checkout (.private/ is never published). */
const SOURCE = path.resolve(__dirname, "../../../../.private/archymedes-protocol/src/outcomes.ts");
const context = { installId: "6f1c1f9e-6a43-4c55-9d0e-2b1b7d3f0a11", grantedAt: "2026-10-01T00:00:00.000Z", appVersion: "3.12.6", now: Date.parse("2026-11-01T12:00:00Z") };

describe("archymedes.outcome/v1 against the service's own validator", () => {
  it.skipIf(!existsSync(SOURCE))("the vendored validator has not drifted from @archymedes/protocol", () => {
    const vendored = readFileSync(path.join(__dirname, "outcome-protocol.ts"), "utf8");
    const body = vendored.slice(vendored.indexOf("\n", vendored.indexOf("// --- vendored verbatim below ---")) + 1);
    expect(body).toBe(readFileSync(SOURCE, "utf8"));
  });

  it("strips dates and hashes from model ids, and refuses ids, UUIDs and host names", () => {
    expect(normaliseModelId("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(normaliseModelId("anthropic/claude-3-5-haiku-20241022")).toBe("anthropic:claude-3-5-haiku");
    // A fine-tune names its owner; it is never reported, only the fact that it is custom.
    expect(normaliseModelId("ft:gpt-4o-mini:acme:9f86d081884c7d659a2f")).toBe("custom");
    expect(normaliseModelId("gpt-4o-2024-08-06")).toBe("gpt-4o-2024-08-06");
    for (const unsafe of ["6f1c1f9e-6a43-4c55-9d0e-2b1b7d3f0a11", "www.example.org", "api.my-company.com", "acme.ai", "12345678"]) {
      expect(normaliseModelId(unsafe), unsafe).toBe("custom");
    }
  });

  it("every event Friday builds is accepted by the service validator, and Friday's own check agrees", () => {
    const models = ["claude-sonnet-4-5-20250929", "gpt-4o", "ft:gpt-4o:acme:9f86d081884c7d659a2f", "www.foo.com", "/x/y.gguf", "llama3.1:8b", "openrouter/auto"];
    const events = models.map((model, index) => buildOutcomeEvent({
      engine: "archymedes", provider: "openrouter", model, effort: "high", status: index % 2 ? "failed" : "completed",
      toolCalls: 12, iterations: 5, repairs: 1, elapsedMs: 90_000, actualModelRwf: 800,
      routingReceipts: [{ chosen: { model }, considered: [], policy: {}, retries: 1, predictedOutcomeScore: 0.6, outcomeScore: 0.55 }],
    }, context));
    for (const event of events) {
      expect(serverValidate(event, { now: new Date(context.now) })).toEqual({ ok: true, value: event });
      expect(validateOutcomeEvent(event)).toEqual([]);
    }
    expect(validateOutcomeBatch({ events })).toMatchObject({ ok: true, errors: [], invalid: [] });
  });

  it("Friday's check rejects what the service rejects: unknown fields and identifier-shaped enums", () => {
    const event = buildOutcomeEvent({ status: "completed" }, context);
    expect(validateOutcomeEvent({ ...event, extra: 1 } as typeof event)).not.toEqual([]);
    expect(validateOutcomeEvent({ ...event, outcome: { label: "completed", note: "x" } } as typeof event)).not.toEqual([]);
    expect(validateOutcomeEvent({ ...event, features: { model: "claude-20250929" } })).not.toEqual([]);
    expect(validateOutcomeEvent({ ...event, appVersion: "3.12 beta" })).not.toEqual([]);
  });

  it("never builds an event with a malformed app version", () => {
    const event = buildOutcomeEvent({ status: "completed" }, { ...context, appVersion: "3.12 beta (local)" });
    expect(serverValidate(event).ok).toBe(true);
  });
});
