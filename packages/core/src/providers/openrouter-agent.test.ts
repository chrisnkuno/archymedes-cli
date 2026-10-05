import { describe, expect, it } from "vitest";
import { OpenRouterAgentTurnProvider } from "./openrouter-agent";
import { resolveProvider } from "./agent-matrix";
import type { ChatResponse } from "./openai-compatible";

const request = {
  messages: [{ role: "user" as const, content: "What is the meaning of life?" }],
  tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
  maxOutputTokens: 4_096,
  safetyIdentifier: "archymedes_cli_test",
};

function chatResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    id: "gen-1",
    model: "openai/gpt-oss-120b",
    choices: [{
      finish_reason: "stop",
      message: { content: "42." },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

describe("OpenRouter direct provider", () => {
  it("requires its own key and a model", () => {
    expect(() => new OpenRouterAgentTurnProvider({ apiKey: "  ", model: "openrouter/auto" })).toThrow("OPENROUTER_API_KEY");
    expect(() => new OpenRouterAgentTurnProvider({ apiKey: "k", model: "  " })).toThrow("OPENROUTER_MODEL");
  });

  it("sends the model id as given, with tools and streaming, and reads the turn back", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenRouterAgentTurnProvider({ apiKey: "sk-or", model: "openai/gpt-oss-120b" }, async (value) => {
      body = value;
      return chatResponse();
    });
    const turn = await provider.complete(request);
    expect(body).toMatchObject({
      model: "openai/gpt-oss-120b",
      stream: true,
      tool_choice: "auto",
    });
    // Unlike free mode this path carries no zero-price cap: OpenRouter routes normally.
    expect(body).not.toHaveProperty("provider");
    expect(turn).toMatchObject({ finishReason: "stop", content: "42." });
    expect(turn.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("collects a streamed response the same way a buffered one is read", async () => {
    async function* stream() {
      yield { id: "gen-1", model: "openai/gpt-oss-120b", choices: [{ delta: { content: "42" } }] };
      yield { id: "gen-1", model: "openai/gpt-oss-120b", choices: [{ delta: { content: "." }, finish_reason: "stop" }] };
      yield { id: "gen-1", model: "openai/gpt-oss-120b", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    }
    const provider = new OpenRouterAgentTurnProvider({ apiKey: "sk-or", model: "openrouter/auto" }, async () => stream());
    const seen: string[] = [];
    const turn = await provider.complete({ ...request, tools: [], onTextDelta: (text) => seen.push(text) });
    expect(seen.join("")).toBe("42.");
    expect(turn).toMatchObject({ finishReason: "stop", content: "42." });
  });

  it("names an authentication failure instead of leaking the wire error", async () => {
    const denied = Object.assign(new Error("Unauthorized"), { status: 401 });
    const provider = new OpenRouterAgentTurnProvider({ apiKey: "bad", model: "openrouter/auto" }, async () => { throw denied; });
    await expect(provider.complete({ ...request, tools: [] })).rejects.toThrow("OPENROUTER_API_KEY");
  });

  it("resolves through the provider matrix with its own default, priced as unknown", () => {
    const resolved = resolveProvider({ OPENROUTER_API_KEY: "sk-or" }, { provider: "openrouter" });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) return;
    expect(resolved.spec.id).toBe("openrouter");
    expect(resolved.model).toBe("openrouter/auto");
    // OpenRouter serves hundreds of models at their own rates; no catalog rate is shipped.
    expect(resolved.prices).toBeUndefined();
  });

  it("accepts any model id — paid or :free — while free mode stays capped", () => {
    for (const model of ["openrouter/auto", "anthropic/claude-sonnet-4.5", "openai/gpt-oss-120b", "lab/code:free"]) {
      const resolved = resolveProvider({ OPENROUTER_API_KEY: "sk-or" }, { provider: "openrouter", model });
      expect("error" in resolved, model).toBe(false);
    }
    expect(resolveProvider({ OPENROUTER_API_KEY: "sk-or" }, { provider: "free", model: "openai/gpt-oss-120b" }))
      .toMatchObject({ error: expect.stringContaining("Paid models are not allowed") });
  });

  it("honours an explicit model override for the direct path", () => {
    const resolved = resolveProvider(
      { OPENROUTER_API_KEY: "sk-or", OPENROUTER_MODEL: "anthropic/claude-sonnet-4.5" },
      { provider: "openrouter" },
    );
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) return;
    expect(resolved.model).toBe("anthropic/claude-sonnet-4.5");
  });
});
