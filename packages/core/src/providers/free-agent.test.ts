import { describe, expect, it, vi } from "vitest";
import { FreeAgentTurnProvider } from "./free-agent";
import { mergeFreeCatalog, parseFreeOpenRouterModels } from "./free-catalog";
import type { ChatResponse, ChatStreamChunk } from "./openai-compatible";
import { resolveProvider } from "./agent-matrix";

const entry = { id: "lab/code:free", context_length: 65536, top_provider: { max_completion_tokens: 1024 },
  pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"] };
const catalog = () => Promise.resolve(mergeFreeCatalog(parseFreeOpenRouterModels({ data: [entry] }), [], Date.now()));
const request = { messages: [{ role: "user" as const, content: "Read the file" }],
  tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }], maxOutputTokens: 4096, safetyIdentifier: "test" };
const response: ChatResponse = { id: "test", model: entry.id, choices: [{ finish_reason: "stop", message: { content: "Done" } }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };

describe("free-only model adapter", () => {
  it("enforces zero prices and supported tool fields for a verified model", async () => {
    const call = vi.fn(async () => response);
    const provider = new FreeAgentTurnProvider({ apiKey: "secret", model: "openrouter/free" }, { call, catalog });
    expect(await provider.complete(request)).toMatchObject({ model: entry.id, content: "Done", usage: { totalTokens: 30 } });
    expect(call.mock.calls[0]).toBeDefined();
    const body = (call.mock.calls as unknown as [Record<string, unknown>, AbortSignal][])[0][0];
    expect(body).toMatchObject({ model: entry.id, max_tokens: 1024, provider: { max_price: { prompt: 0, completion: 0 }, require_parameters: true, allow_fallbacks: false }, stream: true });
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body).not.toHaveProperty("plugins");
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
  it("requires its own key, refuses paid models and ignores paid price overrides", () => {
    expect(() => new FreeAgentTurnProvider({ apiKey: "", model: entry.id })).toThrow("OPENROUTER_API_KEY");
    expect(() => new FreeAgentTurnProvider({ apiKey: "secret", model: "lab/paid" })).toThrow("paid models");
    expect(resolveProvider({ OPENAI_API_KEY: "paid" }, { provider: "free" })).toHaveProperty("error");
    expect(resolveProvider({ ARCHYMEDES_PROVIDER: "free", OPENAI_API_KEY: "paid" })).toHaveProperty("error");
    const resolved = resolveProvider({ OPENROUTER_API_KEY: "secret", MODEL_INPUT_PER_MILLION: "9", MODEL_OUTPUT_PER_MILLION: "9" }, { provider: "free" });
    expect(resolved).toMatchObject({ spec: { id: "free" }, prices: { inputPerMillion: 0, outputPerMillion: 0 } });
  });
  it("never calls inference for an unavailable model or excessive context", async () => {
    const call = vi.fn(async () => response);
    const unknown = new FreeAgentTurnProvider({ apiKey: "k", model: "lab/missing:free" }, { call, catalog });
    await expect(unknown.complete(request)).rejects.toThrow("No eligible");
    const oversized = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call, catalog });
    await expect(oversized.complete({ ...request, messages: [{ role: "user", content: "x".repeat(100000) }] })).rejects.toThrow("context");
    expect(call).not.toHaveBeenCalled();
  });
  it("uses bounded metadata caching and revalidates expiry", async () => {
    let now = 100;
    const load = vi.fn(async () => ({ ...await catalog(), fetchedAt: now }));
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call: async () => response, catalog: load, now: () => now });
    await provider.complete(request); await provider.complete(request);
    expect(load).toHaveBeenCalledTimes(1);
    now += 7 * 60 * 60 * 1000;
    await provider.complete(request);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("parses streamed tools and preserves usage", async () => {
    async function* stream(): AsyncIterable<ChatStreamChunk> {
      yield { id: "s", model: entry.id, choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "read_file", arguments: '{"path":' } }] } }] };
      yield { choices: [{ finish_reason: "tool_calls", delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }], usage: response.usage };
    }
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call: async () => stream(), catalog });
    expect(await provider.complete(request)).toMatchObject({ finishReason: "tool_calls", toolCalls: [{ name: "read_file", arguments: { path: "a.ts" } }] });
  });
  it.each([401, 402, 403, 404, 429, 503])("reports HTTP %s without leaking upstream error text", async (status) => {
    const provider = new FreeAgentTurnProvider({ apiKey: "secret", model: entry.id }, { catalog, call: async () => {
      throw Object.assign(new Error("secret from upstream"), { status, headers: new Headers({ "retry-after": "3" }) });
    } });
    const error = await provider.complete(request).catch((error: Error & { retryable: boolean }) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret");
    expect(error).toMatchObject({ status, retryable: status === 429 || status >= 500, retryAfterMs: 3000 });
  });
  it("does not count a zero-usage budget message as successful inference", async () => {
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { catalog, call: async () => ({ ...response, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) });
    await expect(provider.complete(request)).rejects.toThrow("not confirmed");
  });
  it("stops on unexpected billed usage before returning tools", async () => {
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { catalog, call: async () => ({ ...response, usage: { ...response.usage!, cost: 1 } }) });
    await expect(provider.complete(request)).rejects.toThrow("cost");
  });
  it("propagates caller cancellation before any request", async () => {
    const call = vi.fn(async () => response);
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call, catalog });
    const abort = new AbortController(); abort.abort();
    await expect(provider.complete({ ...request, signal: abort.signal })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
  describe("the free router", () => {
    const big = { ...entry, id: "lab/gated:free", context_length: 1_000_000 };
    const routed = () => Promise.resolve(mergeFreeCatalog(parseFreeOpenRouterModels({ data: [big, entry] }), [], Date.now()));
    const refuse = (status: number) => Object.assign(new Error("gated"), { status });

    it("moves past a gated model to the next verified one and stops asking the gated one", async () => {
      const call = vi.fn(async (body: Record<string, unknown>) => { if (body.model === big.id) throw refuse(403); return response; });
      const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: routed });
      expect(await provider.complete(request)).toMatchObject({ content: "Done" });
      await provider.complete(request);
      expect(call.mock.calls.map(([body]) => body.model)).toEqual([big.id, entry.id, entry.id]);
    });
    it("treats an empty HTTP 200 (upstream overload) as a refusal and tries the next model", async () => {
      const empty = { ...response, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      const call = vi.fn(async (body: Record<string, unknown>) => body.model === big.id ? empty : response);
      const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: routed });
      expect(await provider.complete(request)).toMatchObject({ content: "Done" });
      expect(call).toHaveBeenCalledTimes(2);
    });
    it("never switches models after text has streamed, or for an explicitly chosen model", async () => {
      async function* partial(): AsyncIterable<ChatStreamChunk> {
        yield { id: "s", model: big.id, choices: [{ delta: { content: "Hel" } }] };
        throw refuse(503);
      }
      const call = vi.fn(async () => partial());
      const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: routed });
      await expect(provider.complete({ ...request, onTextDelta: () => undefined })).rejects.toMatchObject({ status: 503 });
      expect(call).toHaveBeenCalledTimes(1);
      const pinned = vi.fn(async () => { throw refuse(429); });
      const explicit = new FreeAgentTurnProvider({ apiKey: "k", model: big.id }, { call: pinned, catalog: routed });
      await expect(explicit.complete(request)).rejects.toMatchObject({ status: 429 });
      expect(pinned).toHaveBeenCalledTimes(1);
    });
  });
});
