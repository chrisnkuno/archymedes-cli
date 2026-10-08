import { describe, expect, it, vi } from "vitest";
import { OpenAIAgentTurnProvider } from "./openai-agent";
import type { ChatResponse, ChatStreamChunk } from "./openai-compatible";

const usage = {
  prompt_tokens: 800,
  completion_tokens: 120,
  total_tokens: 920,
  prompt_tokens_details: { cached_tokens: 600 },
  completion_tokens_details: { reasoning_tokens: 40 },
};

const request = {
  messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }],
  tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
  maxOutputTokens: 4_096,
  safetyIdentifier: "archymedes_cli_test",
};

function respond(overrides: Partial<ChatResponse["choices"][number]> = {}): ChatResponse {
  return {
    id: "chatcmpl_1",
    model: "gpt-5.6-terra",
    choices: [{ finish_reason: "stop", message: { content: "Done." }, ...overrides }],
    usage,
  };
}

describe("OpenAI agent adapter", () => {
  it("combines caller cancellation with the provider timeout", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async (_body, signal) => {
      received = signal;
      return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const pending = provider.complete({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(received?.aborted).toBe(true);
  });

  it("reports a stream deadline as a timeout rather than the SDK's abort error", async () => {
    vi.useFakeTimers();
    try {
      const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async (_body, signal) =>
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" })), { once: true })));
      const pending = provider.complete(request).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(300_000);
      await expect(pending).resolves.toMatchObject({ name: "TimeoutError", code: "ETIMEDOUT", phase: "first_byte" });
    } finally { vi.useRealTimers(); }
  });

  it("does not cut off a long stream that keeps producing output", async () => {
    vi.useFakeTimers();
    try {
      async function* slow(): AsyncIterable<ChatStreamChunk> {
        // Ten minutes in total, far past the old 180s wall clock, never silent for more than 60s.
        for (let index = 0; index < 10; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          yield { id: "s", model: "gpt-5.6-terra", choices: [{ delta: index % 2 ? { content: "x" } : { tool_calls: [{ index: 0, id: "c", function: { name: "read_file", arguments: "" } }] } }] };
        }
        yield { choices: [{ finish_reason: "stop", delta: {} }], usage };
      }
      const progress: string[] = [];
      const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () => slow());
      const pending = provider.complete({ ...request, onOutputProgress: (kind) => progress.push(kind) });
      await vi.advanceTimersByTimeAsync(600_000);
      await expect(pending).resolves.toMatchObject({ content: "xxxxx" });
      expect(progress).toContain("tool_call");
      expect(progress).toContain("text");
    } finally { vi.useRealTimers(); }
  });

  it("sends tools in the function-calling schema and identifies the caller", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async (value) => {
      body = value;
      return respond();
    });

    const turn = await provider.complete(request);
    expect(body).toMatchObject({ model: "gpt-5.6-terra", tool_choice: "auto", parallel_tool_calls: true, safety_identifier: "archymedes_cli_test" });
    expect(body!.tools).toEqual([{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } }]);
    // The system prompt stays a message here, unlike Anthropic's top-level `system`.
    expect(body!.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    expect(turn).toMatchObject({ finishReason: "stop", content: "Done.", model: "gpt-5.6-terra" });
  });

  it("uses Inkling's narrower OpenRouter tool contract", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAIAgentTurnProvider(
      { apiKey: "sk-test", model: "thinkingmachines/inkling:free", baseURL: "https://openrouter.ai/api/v1" },
      async (value) => {
        body = value;
        return respond();
      },
    );

    await provider.complete(request);
    expect(body).toMatchObject({ model: "thinkingmachines/inkling:free", max_tokens: 4_096 });
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("omits the entire tool contract for a tool-free chat profile", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async (value) => {
      body = value;
      return respond();
    });
    await provider.complete({ ...request, tools: [] });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  it("reads usage including cached input, so a cached session is priced correctly", async () => {
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () => respond());
    const turn = await provider.complete(request);
    expect(turn.usage).toMatchObject({ inputTokens: 800, outputTokens: 120, cachedInputTokens: 600, reasoningTokens: 40 });
  });

  it("parses tool calls back out of the response", async () => {
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () =>
      respond({
        finish_reason: "tool_calls",
        message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
      }));
    const turn = await provider.complete(request);
    expect(turn.finishReason).toBe("tool_calls");
    expect(turn.toolCalls).toEqual([{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }]);
  });

  it("keeps malformed tool arguments as a string rather than throwing away the turn", async () => {
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () =>
      respond({
        finish_reason: "tool_calls",
        message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{not json" } }] },
      }));
    const turn = await provider.complete(request);
    // The runtime rejects non-object arguments with a clear message; losing the whole turn here
    // would hide which tool call was malformed.
    expect(turn.toolCalls[0].arguments).toBe("{not json");
  });

  it("surfaces a refusal instead of an empty answer", async () => {
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () =>
      respond({ finish_reason: "stop", message: { content: null, refusal: "Cannot assist." } }));
    const turn = await provider.complete(request);
    expect(turn).toMatchObject({ finishReason: "refusal", refusal: "Cannot assist." });
  });

  it("reports a truncated turn as unfinished, and fails closed on an unknown reason or missing accounting", async () => {
    const truncated = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () =>
      respond({ finish_reason: "length", message: { content: "partial" } }));
    expect(await truncated.complete(request)).toMatchObject({ finishReason: "length", content: "partial" });

    const unknown = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () => respond({ finish_reason: "banana" }));
    await expect(unknown.complete(request)).rejects.toThrow(/finish reason/);

    const noUsage = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () => ({ ...respond(), usage: null }));
    await expect(noUsage.complete(request)).rejects.toThrow(/usage accounting/);
  });

  it("refuses to construct without credentials", () => {
    expect(() => new OpenAIAgentTurnProvider({ apiKey: "", model: "gpt-5.6-terra" })).toThrow("OPENAI_API_KEY");
    expect(() => new OpenAIAgentTurnProvider({ apiKey: "sk", model: "" })).toThrow("OPENAI_MODEL");
  });

  it("requires a safety identifier before spending anything", async () => {
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () => respond());
    await expect(provider.complete({ ...request, safetyIdentifier: "  " })).rejects.toThrow("safetyIdentifier");
  });

  it("builds a real client when no call is injected, without making a network request", () => {
    // Constructing the SDK client is local (no I/O); only invoking it would reach the network,
    // which the test never does. This just proves the real, non-test construction path works.
    expect(() => new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" })).not.toThrow();
    expect(() => new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra", baseURL: "https://example.com/v1" })).not.toThrow();
  });

  it("streams through the SDK's own transport and the byte-level timeouts together", async () => {
    // No `call` injected: the OpenAI SDK performs the request through `fetchImpl`, wrapped by
    // the TTFB/idle/total timeouts. A healthy stream must pass through untouched — the wrapper
    // may only abort dead connections, never slow ones.
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "chatcmpl_1", model: "gpt-5.6-terra", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const body = [
      chunk({ content: "Hel" }),
      chunk({ content: "lo." }, "stop"),
      `data: ${JSON.stringify({ id: "chatcmpl_1", model: "gpt-5.6-terra", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const fetchImpl = (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra", fetchImpl });
    const seen: string[] = [];
    const turn = await provider.complete({ ...request, onTextDelta: (text) => seen.push(text) });
    expect(seen).toEqual(["Hel", "lo."]);
    expect(turn).toMatchObject({ finishReason: "stop", content: "Hello.", usage: { totalTokens: 15 } });
  });

  it("turns a byte-level timeout through the real SDK into a retryable timeout", async () => {
    // The SDK wraps transport failures in its own error shape and drops the cause; what must
    // survive is the retry contract — retryable, kind timeout — or a stalled provider silently
    // stops being retried after an SDK upgrade.
    const hanging = ((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
    const provider = new OpenAIAgentTurnProvider({
      apiKey: "sk-test", model: "gpt-5.6-terra", fetchImpl: hanging, streamTimeouts: { ttfbMs: 30, idleMs: 50, totalMs: 200 },
    });
    const error = await provider.complete(request).then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(isRetryableProviderError(error)).toBe(true);
    expect(providerFailureKind(error)).toBe("timeout");
  });

  it("collects a streamed response the same way the buffered one is read", async () => {
    async function* stream() {
      yield { id: "chatcmpl_1", model: "gpt-5.6-terra", choices: [{ delta: { content: "Hel" } }] };
      yield { choices: [{ delta: { content: "lo." }, finish_reason: "stop" }] };
      yield { choices: [], usage };
    }
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () => stream());
    const seen: string[] = [];
    const turn = await provider.complete({ ...request, onTextDelta: (text) => seen.push(text) });
    expect(seen).toEqual(["Hel", "lo."]);
    expect(turn).toMatchObject({ finishReason: "stop", content: "Hello." });
  });
});

describe("OpenAI agent adapter prompt caching", () => {
  const capture = () => {
    const bodies: Array<Record<string, unknown>> = [];
    const call = async (body: Record<string, unknown>) => { bodies.push(body); return respond(); };
    return { bodies, call };
  };

  it("adds cache_control breakpoints for anthropic/ models through OpenRouter", async () => {
    const { bodies, call } = capture();
    await new OpenAIAgentTurnProvider({ apiKey: "sk", model: "anthropic/claude-sonnet-4.6", baseURL: "https://openrouter.ai/api/v1" }, call).complete(request);
    const messages = bodies[0].messages as Array<{ content: unknown }>;
    expect(messages[0].content).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
    expect(messages[1].content).toEqual([{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }]);
  });

  it("sends no breakpoints to OpenAI itself, and keeps the request prefix byte-stable across turns", async () => {
    const { bodies, call } = capture();
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk", model: "gpt-5.6-terra" }, call);
    await provider.complete(request);
    await provider.complete({ ...request, messages: [...request.messages, { role: "assistant" as const, content: "x" }, { role: "user" as const, content: "more" }] });
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
    expect(bodies[0].prompt_cache_key).toBe(bodies[1].prompt_cache_key);
    expect(JSON.stringify(bodies[0].tools)).toBe(JSON.stringify(bodies[1].tools));
    expect((bodies[1].messages as unknown[]).slice(0, 2)).toEqual(bodies[0].messages);
  });

  it("reads cached prompt tokens into usage", async () => {
    const { call } = capture();
    const turn = await new OpenAIAgentTurnProvider({ apiKey: "sk", model: "gpt-5.6-terra" }, call).complete(request);
    expect(turn.usage.cachedInputTokens).toBe(600);
  });
});
