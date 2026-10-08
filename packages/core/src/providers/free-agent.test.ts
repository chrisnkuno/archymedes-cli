import { APIConnectionError } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeAgentTurnProvider, freeModelCapabilities, withFreeResetTime } from "./free-agent";
import { FreeUsageMeter } from "./free-usage";
import { FreeInstallToken, type StoredInstall } from "./free-install";
import { FreeHealthTracker, recordFreeOutcome, type FreeHealthRecords } from "./free-health";
import { OpenRouterKeyInfoCache } from "./openrouter-key-info";
import { RequestPacer } from "./request-pacer";
import { mergeFreeCatalog, parseFreeOpenRouterModels } from "./free-catalog";
import type { ChatResponse, ChatStreamChunk } from "./openai-compatible";
import { availableProviders, missingRequirements, resolveProvider } from "./agent-matrix";
import { freeAccess } from "./free-catalog";

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
  it("adds OpenRouter cache breakpoints only for models that need them", async () => {
    const google = { ...entry, id: "google/gemma-4-31b-it:free" };
    const both = () => Promise.resolve(mergeFreeCatalog(parseFreeOpenRouterModels({ data: [google, entry] }), [], Date.now()));
    const call = vi.fn(async () => response);
    await new FreeAgentTurnProvider({ apiKey: "k", model: google.id }, { call, catalog: both }).complete(request);
    await new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call, catalog: both }).complete(request);
    const bodies = (call.mock.calls as unknown as [{ messages: Array<{ role: string; content: unknown }> }][]).map(([body]) => body);
    expect(bodies[0].messages.at(-1)?.content).toEqual([{ type: "text", text: "Read the file", cache_control: expect.objectContaining({ type: "ephemeral" }) }]);
    expect(bodies[1].messages.at(-1)?.content).toBe("Read the file");
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
    it("paces requests after a 429, honouring the provider's retry-after, and relaxes on success", async () => {
      let now = 1_000_000;
      const slept: number[] = [];
      const pacer = new RequestPacer({ now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } });
      const limited = Object.assign(new Error("limited"), { status: 429, headers: new Headers({ "retry-after": "30" }) });
      const call = vi.fn(async (body: Record<string, unknown>) => { if (body.model === big.id) throw limited; return response; });
      const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: routed, now: () => now, pacer });
      expect(await provider.complete(request)).toMatchObject({ content: "Done" });
      expect(call.mock.calls.map(([body]) => body.model)).toEqual([big.id, entry.id]);
      // The switch to the next model waited out the 30s the provider asked for instead of firing
      // into the limiter again, and the success that followed relaxed the pace by one step.
      expect(slept).toEqual([30_000]);
      expect(pacer.paceMs).toBe(29_500);
    });
    it("starts unthrottled: a provider that never sees a 429 never waits", async () => {
      const slept: number[] = [];
      const pacer = new RequestPacer({ sleep: async (ms) => { slept.push(ms); } });
      const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call: async () => response, catalog: routed, pacer });
      await provider.complete(request);
      await provider.complete(request);
      expect(slept).toEqual([]);
      expect(pacer.paceMs).toBe(0);
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
  describe("deadlines and failover", () => {
    const big = { ...entry, id: "lab/gated:free", context_length: 1_000_000 };
    const routed = () => Promise.resolve(mergeFreeCatalog(parseFreeOpenRouterModels({ data: [big, entry] }), [], Date.now()));
    /** A request that never answers and ignores its signal: the deadline alone has to end it. */
    const hang = () => new Promise<never>(() => undefined);

    it("moves to the next candidate when one sends no first byte, with a deadline per candidate", async () => {
      vi.useFakeTimers();
      try {
        const signals: AbortSignal[] = [];
        const call = vi.fn(async (body: Record<string, unknown>, signal: AbortSignal) => {
          signals.push(signal);
          return body.model === big.id ? await hang() : response;
        });
        const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free", firstByteTimeoutMs: 1_000 }, { call, catalog: routed });
        const pending = provider.complete(request);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toMatchObject({ content: "Done" });
        expect(call.mock.calls.map(([body]) => body.model)).toEqual([big.id, entry.id]);
        // The silent candidate's request was aborted; the next one started with a fresh signal.
        expect(signals[0].aborted).toBe(true);
        expect(signals[1].aborted).toBe(false);
      } finally { vi.useRealTimers(); }
    });

    it("reports a timeout as a timeout when the last candidate is silent too", async () => {
      vi.useFakeTimers();
      try {
        const call = vi.fn(async () => await hang());
        const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free", firstByteTimeoutMs: 1_000 }, { call, catalog: routed });
        const pending = provider.complete(request).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(1_000);
        // The last candidate has no successor, so it gets the full first-byte allowance.
        await vi.advanceTimersByTimeAsync(299_999);
        expect(call).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toMatchObject({ name: "TimeoutError", phase: "first_byte" });
      } finally { vi.useRealTimers(); }
    });

    it("never fails over after output began, even on a stall", async () => {
      vi.useFakeTimers();
      try {
        async function* stalls(): AsyncIterable<ChatStreamChunk> {
          yield { id: "s", model: big.id, choices: [{ delta: { reasoning: "thinking" } }] };
          await hang();
        }
        const call = vi.fn(async () => stalls());
        const progress: string[] = [];
        const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free", timeoutMs: 2_000 }, { call, catalog: routed });
        const pending = provider.complete({ ...request, onOutputProgress: (kind) => progress.push(kind) }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(pending).resolves.toMatchObject({ name: "TimeoutError", phase: "idle" });
        expect(call).toHaveBeenCalledTimes(1);
        expect(progress).toEqual(["reasoning"]);
      } finally { vi.useRealTimers(); }
    });

    it("never fails over on the user's own abort", async () => {
      const controller = new AbortController();
      const call = vi.fn(async (_body: Record<string, unknown>, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" })), { once: true });
      }));
      const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: routed });
      const pending = provider.complete({ ...request, signal: controller.signal }).catch((error: unknown) => error);
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
      controller.abort(new Error("user cancelled"));
      await expect(pending).resolves.toMatchObject({ message: "user cancelled" });
      expect(call).toHaveBeenCalledTimes(1);
    });

    it("gives the catalog check its own deadline instead of spending the inference budget", async () => {
      const seen: AbortSignal[] = [];
      const call = vi.fn(async (_body: Record<string, unknown>, signal: AbortSignal) => { seen.push(signal); return response; });
      const catalogSignals: AbortSignal[] = [];
      const provider = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, {
        call, catalog: (signal) => { catalogSignals.push(signal); return catalog(); },
      });
      await provider.complete(request);
      expect(catalogSignals).toHaveLength(1);
      expect(seen[0]).not.toBe(catalogSignals[0]);
    });
  });

  describe("gateway access", () => {
    it("does not spend more of a gateway limit by switching models, but still moves past a gated model", async () => {
      const big = { ...entry, id: "lab/gated:free", context_length: 1_000_000 };
      const routed = () => Promise.resolve(mergeFreeCatalog(parseFreeOpenRouterModels({ data: [big, entry] }), [], Date.now()));
      const limited = vi.fn(async () => { throw Object.assign(new Error("limit"), { status: 429, headers: new Headers({ "x-free-gateway-error": "429" }) }); });
      await expect(new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: "openrouter/free" }, { call: limited, catalog: routed }).complete(request)).rejects.toMatchObject({ status: 429 });
      expect(limited).toHaveBeenCalledTimes(1);
      const gated = vi.fn(async (body: Record<string, unknown>) => {
        if (body.model === big.id) throw Object.assign(new Error("gated"), { status: 403, headers: new Headers() });
        return response;
      });
      expect(await new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: "openrouter/free" }, { call: gated, catalog: routed }).complete(request)).toMatchObject({ content: "Done" });
      expect(gated).toHaveBeenCalledTimes(2);
    });
    it("uses the user's key directly when present and never sends it to a gateway", () => {
      expect(freeAccess({ OPENROUTER_API_KEY: " k ", ARCHYMEDES_FREE_GATEWAY_URL: "https://gw.test" })).toEqual({ apiKey: "k" });
      expect(freeAccess({ ARCHYMEDES_FREE_GATEWAY_URL: "https://gw.test/" })).toEqual({ gatewayUrl: "https://gw.test" });
      expect(freeAccess({ ARCHYMEDES_FREE_GATEWAY_URL: "http://localhost:8787" })).toEqual({ gatewayUrl: "http://localhost:8787" });
      for (const unsafe of ["http://gw.test", "https://user:pw@gw.test", "ftp://gw.test", "nonsense"]) {
        expect(freeAccess({ ARCHYMEDES_FREE_GATEWAY_URL: unsafe })).toBeUndefined();
      }
    });
    it("counts a gateway as configured and starts in free mode by default when nothing else is set", () => {
      const environment = { ARCHYMEDES_FREE_GATEWAY_URL: "https://gw.test" };
      expect(missingRequirements("free", environment)).toEqual([]);
      expect(missingRequirements("free", {})).toEqual(["ARCHYMEDES_FREE_GATEWAY_URL (a self-hosted free gateway) or OPENROUTER_API_KEY"]);
      expect(availableProviders(environment).map((spec) => spec.id)).toContain("free");
      // Free mode is the keyless default: with only a gateway configured, no key is asked for.
      expect(resolveProvider(environment)).toMatchObject({ spec: { id: "free" } });
      expect(resolveProvider(environment, { provider: "free" })).toMatchObject({ spec: { id: "free" }, model: "openrouter/free" });
    });
    describe("through the real OpenAI client", () => {
      const big = { ...entry, id: "lab/gated:free", context_length: 1_000_000 };
      const routed = () => Promise.resolve(mergeFreeCatalog(parseFreeOpenRouterModels({ data: [big, entry] }), [], Date.now()));
      const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
      const answer = (model: string, status?: string) => {
        const response = sse(
          { id: "s", model, choices: [{ index: 0, delta: { content: "Done" } }] },
          { id: "s", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
          "[DONE]",
        );
        if (status) response.headers.set("x-archymedes-install-status", status);
        return response;
      };
      const memoryStore = () => {
        let saved: StoredInstall | undefined;
        return { read: async () => saved, write: async (value: StoredInstall) => { saved = value; }, clear: async () => { saved = undefined; }, saved: () => saved };
      };
      type Sent = { model: string; install: string | null };
      const original = globalThis.fetch;
      afterEach(() => { globalThis.fetch = original; });
      const serve = (reply: (sent: Sent, index: number) => Response) => {
        const sent: Sent[] = [];
        globalThis.fetch = (async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as { model: string };
          const item = { model: body.model, install: new Headers(init.headers).get("x-archymedes-install") };
          sent.push(item);
          return reply(item, sent.length - 1);
        }) as typeof fetch;
        return sent;
      };

      it("fails over when a gateway stream ends with a retryable error event before any output", async () => {
        const sent = serve(({ model }) => model === big.id
          ? sse({ error: { message: "The model stopped responding.", code: 504, type: "upstream_idle_timeout", retryable: true } })
          : answer(model));
        const provider = new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: "openrouter/free" }, { catalog: routed, install: null });
        expect(await provider.complete(request)).toMatchObject({ content: "Done", model: entry.id });
        expect(sent.map((item) => item.model)).toEqual([big.id, entry.id]);
      });

      it.each([
        [504, "upstream_timeout"], [502, "upstream_unreachable"],
      ])("fails over on a gateway %s %s before any output", async (status, type) => {
        const sent = serve(({ model }) => model === big.id
          ? new Response(JSON.stringify({ error: { message: "upstream", code: status, type } }), { status, headers: { "content-type": "application/json" } })
          : answer(model));
        const provider = new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: "openrouter/free" }, { catalog: routed, install: null });
        expect(await provider.complete(request)).toMatchObject({ content: "Done" });
        expect(sent).toHaveLength(2);
      });

      it("does not fail over when the error event arrives after output began", async () => {
        const sent = serve(({ model }) => sse(
          { id: "s", model, choices: [{ index: 0, delta: { content: "Hel" } }] },
          { error: { message: "broke", code: 502, type: "upstream_stream_failed", retryable: true } },
        ));
        const provider = new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: "openrouter/free" }, { catalog: routed, install: null });
        await expect(provider.complete({ ...request, onTextDelta: () => undefined })).rejects.toMatchObject({ status: 502, retryable: true });
        expect(sent).toHaveLength(1);
      });

      it("sends the install token, and replaces it once when the gateway calls it invalid", async () => {
        const store = memoryStore();
        let issued = 0;
        const installFetch = vi.fn(async () => {
          issued += 1;
          return new Response(JSON.stringify({ token: `v1.token${issued}.sig`, install_id: `id${issued}`, issued_at: "2026-10-07T12:00:00.000Z", header: "x-archymedes-install" }));
        });
        const install = new FreeInstallToken({ gatewayUrl: "https://gw.test", store, fetchImpl: installFetch });
        const sent = serve(({ install: token }) => answer(entry.id, token === "v1.token1.sig" ? "invalid" : "valid"));
        const provider = new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: entry.id }, { catalog, install });
        await provider.complete(request);
        expect(store.saved()).toBeUndefined(); // the rejected token was discarded
        await provider.complete(request);
        await provider.complete(request);
        expect(sent.map((item) => item.install)).toEqual(["v1.token1.sig", "v1.token2.sig", "v1.token2.sig"]);
        expect(installFetch).toHaveBeenCalledTimes(2);
        expect(store.saved()).toMatchObject({ gateway: "https://gw.test", token: "v1.token2.sig", install_id: "id2" });
      });

      it("continues without a token when issuance is refused, and never issues one for the user's own key", async () => {
        const installFetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "limit", code: 429 } }), { status: 429, headers: { "x-free-gateway-error": "429" } }));
        const sent = serve(() => answer(entry.id));
        const viaGateway = new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: entry.id }, {
          catalog, install: new FreeInstallToken({ gatewayUrl: "https://gw.test", fetchImpl: installFetch }),
        });
        await viaGateway.complete(request);
        await viaGateway.complete(request);
        expect(installFetch).toHaveBeenCalledTimes(1); // backed off after the refusal
        const direct = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, {
          catalog, install: new FreeInstallToken({ gatewayUrl: "https://gw.test", fetchImpl: installFetch }),
        });
        await direct.complete(request);
        expect(installFetch).toHaveBeenCalledTimes(1);
        expect(sent.map((item) => item.install)).toEqual([null, null, null]);
      });

      it("reports an unreachable gateway as a network failure, not a server error", async () => {
        globalThis.fetch = (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND gw.test"), { code: "ENOTFOUND" }) }); }) as typeof fetch;
        const inference = new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: entry.id }, { catalog, install: null });
        const error = await inference.complete(request).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ status: undefined, retryable: true });
        expect((error as Error).message).toContain("connectivity");
        expect((error as Error).cause).toBeInstanceOf(APIConnectionError);
        const listing = new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: entry.id }, { install: null });
        const catalogError = await listing.complete(request).catch((caught: unknown) => caught);
        expect(catalogError).toMatchObject({ status: undefined, retryable: true });
        expect(((catalogError as Error).cause as Error)).toBeInstanceOf(TypeError);
      });
    });

    it("reads the gateway's model listing and reports gateway limits without blaming a key", async () => {
      const loads: string[] = [];
      const provider = new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: entry.id }, {
        catalog: undefined,
        call: async () => { throw Object.assign(new Error("limited"), { status: 429, headers: new Headers({ "retry-after": "30" }) }); },
      });
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: string) => {
        loads.push(String(url));
        return new Response(JSON.stringify({ data: [entry] }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      try {
        const error = await provider.complete(request).catch((caught: Error) => caught);
        expect(loads).toEqual(["https://gw.test/v1/models"]);
        expect(error).toMatchObject({ status: 429, retryable: true, retryAfterMs: 30_000 });
        expect((error as Error).message).toContain("Free gateway limit");
        expect((error as Error).message).not.toContain("rejected the key");
      } finally { globalThis.fetch = original; }
    });
  });
});

describe("free token saver and allowance meter", () => {
  const NOW = Date.UTC(2026, 9, 8, 21, 30);
  const day = () => {
    let days: Record<string, number> = { "2026-10-08": 10_000 };
    return new FreeUsageMeter({ read: async () => ({ ...days }), write: async (next) => { days = { ...next }; } }, () => NOW);
  };

  it("declares token saver unless told otherwise, and wires the environment switch", () => {
    expect(new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call: vi.fn(), catalog }).tokenSaver).toBe(true);
    expect(new FreeAgentTurnProvider({ apiKey: "k", model: entry.id, tokenSaver: false }, { call: vi.fn(), catalog }).tokenSaver).toBe(false);
    const on = resolveProvider({ OPENROUTER_API_KEY: "k" }, { provider: "free" });
    const off = resolveProvider({ OPENROUTER_API_KEY: "k", ARCHYMEDES_TOKEN_SAVER: "off" }, { provider: "free" });
    expect("provider" in on && on.provider.tokenSaver).toBe(true);
    expect("provider" in off && off.provider.tokenSaver).toBe(false);
  });

  it("narrows capabilities to a concrete model's smaller limits once the catalog is known", async () => {
    const router = { contextWindow: 32_768, maxOutputTokens: 4_096, supportsEffort: false };
    expect(freeModelCapabilities(router, { context_window: 8_192, max_output: 1_024 })).toEqual({ ...router, contextWindow: 8_192, maxOutputTokens: 1_024 });
    expect(freeModelCapabilities(router, { context_window: 1_000_000, max_output: null })).toEqual(router);
    expect(freeModelCapabilities(router, undefined)).toEqual(router);
    const small = { ...entry, context_length: 8_192 };
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call: vi.fn(async () => response), catalog: () => Promise.resolve(mergeFreeCatalog(parseFreeOpenRouterModels({ data: [small] }), [], Date.now())) });
    expect(provider.capabilities).toEqual(router);
    await provider.complete(request);
    expect(provider.capabilities).toMatchObject({ contextWindow: 8_192, maxOutputTokens: 1_024 });
    // The router itself keeps the router's figures.
    expect(new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call: vi.fn(), catalog }).capabilities).toEqual(router);
  });

  it("reports the day's allowance after a gateway call, net of this call's tokens", async () => {
    const call = vi.fn(async (_body: Record<string, unknown>, _signal: AbortSignal, _headers: Record<string, string>, onHeaders: (headers: Headers) => void) => {
      onHeaders(new Headers({ "x-free-remaining-tokens": "20000", "x-free-reset-utc": "2026-10-09T00:00:00.000Z", "x-free-allowance-warning": "You've used 80% of today's free allowance." }));
      return response;
    });
    const provider = new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: entry.id }, { call, catalog, install: null, usage: day(), now: () => NOW });
    expect((await provider.complete(request)).allowance).toEqual({
      date: "2026-10-08", usedTokens: 10_030, remainingTokens: 19_970, resetsAt: "2026-10-09T00:00:00.000Z", warning: "You've used 80% of today's free allowance.",
    });
  });

  it("counts locally with the user's own key, where there are no gateway headers", async () => {
    const call = vi.fn(async (_body: Record<string, unknown>, _signal: AbortSignal, _headers: Record<string, string>, onHeaders: (headers: Headers) => void) => {
      onHeaders(new Headers({ "x-free-remaining-tokens": "5" }));
      return response;
    });
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call, catalog, usage: day(), now: () => NOW });
    expect((await provider.complete(request)).allowance).toEqual({ date: "2026-10-08", usedTokens: 10_030 });
    // Without a meter and without a gateway there is nothing to report.
    expect((await new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call, catalog }).complete(request)).allowance).toBeUndefined();
  });

  it("adds the reset time to a gateway 429 that does not already say it", async () => {
    expect(withFreeResetTime("Free capacity for your network is busy. Retry later.", { resetsAt: "2026-10-09T00:00:00.000Z" }, NOW))
      .toBe("Free capacity for your network is busy. Retry later. Allowance resets at 00:00 UTC (in 2h 30m).");
    expect(withFreeResetTime("Limit reached", { resetsAt: "2026-10-09T00:00:00.000Z" }, Date.UTC(2026, 9, 8, 23, 20))).toBe("Limit reached. Allowance resets at 00:00 UTC (in 40m).");
    const named = "You've reached today's free usage limit. Your allowance resets at 2026-10-09T00:00:00.000Z.";
    expect(withFreeResetTime(named, { resetsAt: "2026-10-09T00:00:00.000Z" }, NOW)).toBe(named);
    expect(withFreeResetTime("Limit reached.", undefined, NOW)).toBe("Limit reached.");
    const limited = vi.fn(async () => {
      throw Object.assign(new Error("Free capacity for your network is busy. Retry later."), {
        status: 429, headers: new Headers({ "x-free-gateway-error": "429", "x-free-remaining-tokens": "0", "x-free-reset-utc": "2026-10-09T00:00:00.000Z" }),
      });
    });
    const provider = new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: entry.id }, { call: limited, catalog, install: null, now: () => NOW });
    await expect(provider.complete(request)).rejects.toThrow("Allowance resets at 00:00 UTC");
  });

  it("does not retry a spent daily allowance, but still retries a brief per-minute limit", async () => {
    const refusal = (headers: Record<string, string>) => vi.fn(async () => {
      throw Object.assign(new Error("limit"), { status: 429, headers: new Headers({ "x-free-gateway-error": "429", ...headers }) });
    });
    const run = (call: ReturnType<typeof refusal>) =>
      new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: entry.id }, { call, catalog, install: null, now: () => NOW }).complete(request);
    await expect(run(refusal({ "x-free-remaining-tokens": "0" }))).rejects.toMatchObject({ status: 429, retryable: false });
    await expect(run(refusal({ "retry-after": "9000" }))).rejects.toMatchObject({ status: 429, retryable: false });
    await expect(run(refusal({ "retry-after": "20" }))).rejects.toMatchObject({ status: 429, retryable: true, retryAfterMs: 20_000 });
  });
});

describe("free mode reliability and own-key figures", () => {
  const second = { ...entry, id: "lab/second:free" };
  const both = () => Promise.resolve(mergeFreeCatalog(parseFreeOpenRouterModels({ data: [entry, second] }), [], Date.now()));
  const memoryHealth = (initial: FreeHealthRecords = {}) => {
    let records = { ...initial };
    return new FreeHealthTracker({ read: async () => ({ ...records }), write: async (next) => { records = { ...next }; } });
  };

  it("tries the model that has been answering lately first, and records outcomes", async () => {
    const health = memoryHealth(recordFreeOutcome({}, second.id, { ok: true }, Date.now()));
    const call = vi.fn(async () => response);
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: both, health });
    await provider.complete(request);
    expect((call.mock.calls[0] as unknown[])[0]).toMatchObject({ model: second.id });
    expect((await health.records())[second.id]).toMatchObject({ successes: 2 });
  });

  it("records a refusal against the model, then still uses the next one", async () => {
    const health = memoryHealth();
    const call = vi.fn(async (body: Record<string, unknown>) => { if (body.model === entry.id) throw Object.assign(new Error("busy"), { status: 503 }); return response; });
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: both, health });
    expect(await provider.complete(request)).toMatchObject({ content: "Done" });
    expect(await health.records()).toMatchObject({ [entry.id]: { failures: 1, lastFailure: "HTTP 503" }, [second.id]: { successes: 1 } });
  });

  it("does not switch models when OpenRouter's daily free cap for the account is spent", async () => {
    const call = vi.fn(async () => {
      throw Object.assign(new Error("Rate limit exceeded"), { status: 429, headers: new Headers({ "x-ratelimit-limit": "50", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Date.now() + 3 * 60 * 60 * 1000) }) });
    });
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: both, health: null });
    const error = await provider.complete(request).catch((caught: Error) => caught);
    expect(call).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ status: 429, retryable: false });
    expect((error as Error).message).toContain("daily free-model limit");
  });

  it("points a data-policy refusal at the OpenRouter privacy settings", async () => {
    const call = vi.fn(async () => { throw Object.assign(new Error("404 No endpoints found matching your data policy (Free model training)"), { status: 404 }); });
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call, catalog });
    await expect(provider.complete(request)).rejects.toThrow("https://openrouter.ai/settings/privacy");
  });

  it("acts on the gateway's 429 kind", async () => {
    const limited = (kind: string) => vi.fn(async () => {
      throw Object.assign(new Error("Shared free capacity is busy."), { status: 429, error: { message: "Shared free capacity is busy.", code: 429, kind, retry_after_seconds: 15 }, headers: new Headers({ "x-free-gateway-error": "429" }) });
    });
    const run = (kind: string) => new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: entry.id }, { call: limited(kind), catalog, install: null }).complete(request);
    await expect(run("per_minute")).rejects.toMatchObject({ status: 429, retryable: true, retryAfterMs: 15_000 });
    await expect(run("daily_requests")).rejects.toMatchObject({ status: 429, retryable: false });
  });

  it("repairs almost-JSON tool arguments from a free model", async () => {
    async function* stream(): AsyncIterable<ChatStreamChunk> {
      yield { id: "s", model: entry.id, choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "read_file", arguments: "```json\n{'path': 'a.ts',}\n```" } }] } }] };
      yield { choices: [{ finish_reason: "tool_calls", delta: {} }], usage: response.usage };
    }
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call: async () => stream(), catalog });
    expect(await provider.complete(request)).toMatchObject({ toolCalls: [{ name: "read_file", arguments: { path: "a.ts" } }] });
  });

  it("reports OpenRouter's own remaining free requests and credit with the user's key", async () => {
    const NOW = Date.UTC(2026, 9, 8, 21, 30);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { limit_remaining: 4.5, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } }) }));
    const keyInfo = new OpenRouterKeyInfoCache("k", { fetchImpl, now: () => NOW });
    await keyInfo.get();
    const usage = new FreeUsageMeter({ read: async () => ({}), write: async () => undefined }, () => NOW);
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: entry.id }, { call: async () => response, catalog, usage, keyInfo, now: () => NOW });
    expect((await provider.complete(request)).allowance).toEqual({
      date: "2026-10-08", usedTokens: 30, remainingRequests: 46, requestLimit: 50, creditsRemaining: 4.5, resetsAt: "2026-10-09T00:00:00.000Z",
    });
  });

  it("shows the gateway's remaining requests net of this one", async () => {
    const call = vi.fn(async (_body: Record<string, unknown>, _signal: AbortSignal, _headers: Record<string, string>, onHeaders: (headers: Headers) => void) => {
      onHeaders(new Headers({ "x-free-remaining-requests": "288" }));
      return response;
    });
    const provider = new FreeAgentTurnProvider({ gatewayUrl: "https://gw.test", model: entry.id }, { call, catalog, install: null });
    expect((await provider.complete(request)).allowance).toMatchObject({ remainingRequests: 287 });
  });
});
