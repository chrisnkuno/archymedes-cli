import { describe, expect, it } from "vitest";
import { CONSERVATIVE_CAPABILITIES, DEFAULT_OUTPUT_CEILING, budgetsFor, capabilitiesFor } from "./model-capabilities";

describe("what a model can hold and produce", () => {
  it("gives the current models their real window instead of a 200K guess", () => {
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"]) {
      expect(capabilitiesFor(id).contextWindow, id).toBe(1_000_000);
    }
    expect(capabilitiesFor("claude-opus-5").maxOutputTokens).toBe(128_000);
    expect(capabilitiesFor("claude-sonnet-4-6").maxOutputTokens).toBe(64_000);
  });

  it("does not inflate a model that really is 200K", () => {
    expect(capabilitiesFor("claude-haiku-4-5")).toEqual({ contextWindow: 200_000, maxOutputTokens: 64_000, supportsEffort: false });
  });

  it("uses each OpenAI-compatible provider's published limits for its default model", () => {
    const gemini = capabilitiesFor("gemini-2.5-pro");
    expect(gemini).toEqual({ contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsEffort: true });
    expect(gemini).not.toBe(CONSERVATIVE_CAPABILITIES);
    expect(capabilitiesFor("grok-4")).toEqual({ contextWindow: 256_000, maxOutputTokens: 64_000, supportsEffort: false });
  });

  it("covers the DeepSeek, Mistral and Groq default models", () => {
    for (const id of ["deepseek-chat", "deepseek-reasoner", "mistral-large-latest", "mistral-small-latest", "llama-3.3-70b-versatile"]) {
      expect(capabilitiesFor(id).contextWindow, id).toBe(131_072);
      expect(capabilitiesFor(id), id).not.toBe(CONSERVATIVE_CAPABILITIES);
    }
  });

  it("treats an unknown model exactly as Archymedes did before this table existed", () => {
    // The dangerous failure is optimism: assuming a big window for an id nobody recognises turns a
    // local decision into a provider 400 halfway through the work.
    for (const id of ["gpt-9-turbo", "llama-4", "", "   ", undefined]) {
      expect(capabilitiesFor(id), String(id)).toEqual(CONSERVATIVE_CAPABILITIES);
    }
  });

  it("sees through platform routing prefixes and version suffixes", () => {
    for (const id of [
      "anthropic.claude-opus-5",
      "us.anthropic.claude-opus-5",
      "my-gateway/claude-opus-5",
      "CLAUDE-OPUS-5",
      "claude-opus-5-20260101",
      "claude-opus-4-6@20260101",
    ]) {
      expect(capabilitiesFor(id).contextWindow, id).toBe(1_000_000);
    }
  });

  it("resolves by the longest matching family, never a shorter one", () => {
    // `claude-haiku-4-5` and `claude-opus-4-8` share no prefix, but a future short row must never
    // win over a specific one — this is the property that keeps the table extensible.
    expect(capabilitiesFor("claude-opus-4-8-preview").maxOutputTokens).toBe(128_000);
    expect(capabilitiesFor("claude-haiku-4-5-fast").contextWindow).toBe(200_000);
  });
});

describe("models matched exactly rather than by family", () => {
  it("gives the verified OpenAI flagships their real window", () => {
    for (const id of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(capabilitiesFor(id), id).toEqual({ contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsEffort: true });
    }
  });

  it("keeps smaller siblings on their own published windows", () => {
    for (const id of ["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5", "gpt-5-mini", "gpt-5-nano"]) {
      expect(capabilitiesFor(id).contextWindow, id).toBe(400_000);
    }
    expect(capabilitiesFor("gpt-5.6-sol-preview")).toEqual(CONSERVATIVE_CAPABILITIES);
  });
});

describe("the budgets a session derives from its model", () => {
  it("uses the whole window for context and a bounded ceiling for output", () => {
    expect(budgetsFor("claude-opus-5")).toEqual({ contextLimit: 1_000_000, maxOutputTokens: DEFAULT_OUTPUT_CEILING });
  });

  it("never asks for more output than the model will produce", () => {
    // Haiku's 64K ceiling equals the CLI default and must not be raised beyond it.
    expect(budgetsFor("claude-haiku-4-5").maxOutputTokens).toBe(64_000);
    expect(budgetsFor("who-knows").maxOutputTokens).toBe(16_000);
  });

  it("keeps output well under the context it is reserved against", () => {
    for (const id of ["claude-opus-5", "claude-haiku-4-5", "unknown-model"]) {
      const { contextLimit, maxOutputTokens } = budgetsFor(id);
      expect(maxOutputTokens, id).toBeLessThan(contextLimit / 2);
    }
  });
});
