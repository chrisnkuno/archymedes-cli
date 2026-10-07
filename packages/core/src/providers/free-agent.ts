/**
 * Free mode's turn provider. With the user's own key every request goes to the fixed OpenRouter
 * host; without one it goes to a free gateway that holds a key server-side and never receives the
 * user's. Either way requests carry a zero price cap and fallbacks disabled, after re-checking the live catalog, because a stale cache must never
 * authorize paid inference. Failures are reported as they are; there is no silent paid fallback.
 */
import OpenAI from "openai";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { approximateInputTokens } from "../model-cost";
import { FREE_BASE_URL, FREE_CATALOG_TTL_MS, FREE_ROUTER, FREE_ROUTER_PREFERENCE, isFreeModelId, type FreeCatalog } from "./free-catalog";
import { fetchFreeCatalog } from "./free-catalog-fetch";
import { capabilitiesFor } from "./model-capabilities";
import { fetchWithStreamTimeouts, DEFAULT_STREAM_TIMEOUTS } from "./stream-fetch";
import { providerRetryAfterMs } from "../agent-runtime";
import { RequestPacer } from "./request-pacer";
import { collectChatStream, toWireMessages, turnFromChatResponse, type ChatResponse, type ChatStreamChunk } from "./openai-compatible";

type ChatCall = (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/** Bounded so a router turn never fans out across the whole free list. */
const MAX_ROUTER_ATTEMPTS = 4;

function rank(id: string): number {
  const index = FREE_ROUTER_PREFERENCE.indexOf(id);
  return index === -1 ? FREE_ROUTER_PREFERENCE.length : index;
}

/** A model that failed with 429/5xx stays deprioritized this long, so retries try a different model instead of reconnecting to the one that just failed. */
const MODEL_COOLDOWN_MS = 60_000;

class FreeAccessError extends Error {
  constructor(message: string, readonly status = 400, readonly retryable = false, readonly retryAfterMs?: number) { super(message); }
}

/** Direct or gateway access, with the free-only constraint enforced on every request. */
export class FreeAgentTurnProvider implements AgentTurnProvider {
  readonly selection: { provider: string; model: string };
  // Safe offline budgets until live metadata is available; never inherit an unknown model's 200K.
  readonly capabilities = capabilitiesFor(FREE_ROUTER);
  private readonly call: ChatCall;
  private catalog?: FreeCatalog;
  /** Models OpenRouter refused (403/404) for this key; skipped by the router for this process. */
  private readonly refused = new Set<string>();
  /** Models that failed with 429/5xx, with the epoch-ms when they may be tried again. Unlike `refused` this expires: the outage, not the model, is the problem. */
  private readonly cooling = new Map<string, number>();

  /** Learned request pacing for the free tier: survives across turns so a session that hit the limiter keeps spacing its requests. */
  private readonly pacer: RequestPacer;

  private readonly baseUrl: string;
  private readonly viaGateway: boolean;

  constructor(private readonly options: { apiKey?: string; gatewayUrl?: string; model: string; timeoutMs?: number }, private readonly dependencies: {
    call?: ChatCall; catalog?: (signal: AbortSignal) => Promise<FreeCatalog>; now?: () => number; pacer?: RequestPacer;
  } = {}) {
    this.selection = { provider: "free", model: options.model };
    this.pacer = dependencies.pacer ?? new RequestPacer();
    const apiKey = options.apiKey?.trim();
    this.viaGateway = !apiKey && Boolean(options.gatewayUrl);
    if (!apiKey && !this.viaGateway) throw new FreeAccessError("Free mode needs OPENROUTER_API_KEY, or a free gateway in ARCHYMEDES_FREE_GATEWAY_URL. Configure the key in archymedes settings.");
    if (!isFreeModelId(options.model)) throw new FreeAccessError("Free mode accepts openrouter/free or an exact publisher/model:free ID; paid models are not allowed.");
    this.baseUrl = this.viaGateway ? `${options.gatewayUrl}/v1` : FREE_BASE_URL;
    // Timeouts are byte-level (first byte, silence between chunks, total) rather than one
    // wall-clock timer, so a slow-but-alive free-tier stream is never killed mid-sentence.
    // `timeoutMs` remains the total cap. Redirects stay refused: a 3xx from either endpoint is
    // a configuration or interception signal, not a detour to follow with a credential.
    const streamFetch = fetchWithStreamTimeouts(
      ((input, init) => globalThis.fetch(input, { ...init, redirect: "error" })) as typeof fetch,
      { ...(this.options.timeoutMs !== undefined ? { totalMs: this.options.timeoutMs } : {}) },
    );
    const client = dependencies.call ? undefined : new OpenAI({
      // The gateway ignores Authorization; the placeholder only satisfies the SDK.
      apiKey: apiKey ?? "archymedes-free-gateway", baseURL: this.baseUrl, maxRetries: 0,
      // A minute past the byte-level total so the descriptive timeout always wins the race.
      timeout: (this.options.timeoutMs ?? DEFAULT_STREAM_TIMEOUTS.totalMs) + 60_000,
      fetch: streamFetch,
    });
    this.call = dependencies.call ?? (async (body, signal) => await client!.chat.completions.create(body as never, { signal }));
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    // Cancellation comes from the caller alone here; liveness (first byte, stall, total) is
    // enforced byte-by-byte in the fetch wrapper, which can tell a slow stream from a stuck one.
    const signal = request.signal ?? AbortSignal.any([]);
    try {
      signal.throwIfAborted();
      if (!request.safetyIdentifier.trim()) throw new FreeAccessError("safetyIdentifier is required");
      const now = (this.dependencies.now ?? Date.now)();
      if (!this.catalog || this.catalog.fetchedAt > now || now - this.catalog.fetchedAt >= FREE_CATALOG_TTL_MS) {
        this.catalog = await (this.dependencies.catalog ?? ((abort) => fetchFreeCatalog({ signal: abort, discovery: false, modelsUrl: `${this.baseUrl}/models` })))(signal).catch(() => {
          throw new FreeAccessError("Could not verify the free model catalog. Check connectivity and retry; no inference was attempted.", 503, true);
        });
      }
      const eligible = this.catalog.models.filter((model) => model.eligible && isFreeModelId(model.id));
      const selected = eligible.find((model) => model.id === this.options.model);
      // The virtual router may omit tool metadata; its concrete candidates must still qualify.
      const candidates = this.options.model === FREE_ROUTER ? eligible.filter((model) => model.id !== FREE_ROUTER) : selected ? [selected] : [];
      if (!candidates.length) throw new FreeAccessError("No eligible free tool model is available. Run /models refresh or try again later.");
      const messages = toWireMessages(request.messages);
      const input = approximateInputTokens([JSON.stringify(messages), JSON.stringify(request.tools)]).maximumInputTokens;
      const output = Math.min(request.maxOutputTokens, this.capabilities.maxOutputTokens, ...candidates.map((model) => model.max_output ?? 4096));
      if (!Number.isSafeInteger(output) || output < 1) throw new FreeAccessError("Free mode requires a positive output token limit");
      const fitting = candidates.filter((model) => model.context_window !== null && input + output <= model.context_window);
      if (!fitting.length) throw new FreeAccessError("The conversation exceeds the available free model context. Start a new session or select a larger free model.");
      // The virtual router tries verified candidates itself, in FREE_ROUTER_PREFERENCE order, rather than letting
      // OpenRouter pick an unverified model. Some zero-priced models are gated to listed apps (403) or
      // briefly rate-limited upstream (429), so a refusal moves to the next candidate — only before
      // any text has streamed, and never to anything outside the verified free list.
      // A model that just failed with 429/5xx sorts last while its cooldown runs, so the next
      // attempt — the runtime's retry of this same turn, or the user's next turn — tries a model
      // that has not just failed instead of reconnecting to the outage. When every candidate is
      // cooling the router still tries them, earliest-recovered first: a slow chance beats none.
      const coolUntil = (id: string): number => {
        const until = this.cooling.get(id);
        if (until === undefined) return 0;
        if (until <= now) { this.cooling.delete(id); return 0; }
        return until;
      };
      const ordered = this.options.model === FREE_ROUTER
        ? fitting.filter((model) => !this.refused.has(model.id)).sort((a, b) => (coolUntil(a.id) ? 1 : 0) - (coolUntil(b.id) ? 1 : 0) || coolUntil(a.id) - coolUntil(b.id) || rank(a.id) - rank(b.id) || (b.context_window ?? 0) - (a.context_window ?? 0) || a.id.localeCompare(b.id))
        : fitting;
      if (!ordered.length) throw new FreeAccessError("Every free model refused this key. Choose a specific model with /model or try again later.", 403);
      let streamed = false;
      const onTextDelta = request.onTextDelta && ((text: string) => { streamed = true; request.onTextDelta!(text); });
      for (const [attempt, candidate] of ordered.slice(0, MAX_ROUTER_ATTEMPTS).entries()) {
        // Space upstream requests by the learned pace: firing four candidates back-to-back is
        // exactly the burst shape that trips the free tier's limiter.
        await this.pacer.wait(signal);
        try {
          const turn = await this.attempt(candidate.id, messages, output, request, onTextDelta, signal);
          this.pacer.reportSuccess();
          return turn;
        } catch (error) {
          const status = (error as { status?: unknown })?.status;
          // A 429 teaches the pacer: the next request waits out the limiter instead of racing it.
          if (status === 429) this.pacer.reportRateLimited(providerRetryAfterMs(error));
          // A gateway's own limit or outage applies to every model behind it; switching would only spend more of it.
          const gatewayOwned = this.viaGateway && Boolean((error as { headers?: Headers })?.headers?.get?.("x-free-gateway-error"));
          const switchable = this.options.model === FREE_ROUTER && !streamed && !signal.aborted && !gatewayOwned && (!(error instanceof FreeAccessError) || status === 502)
            && (status === 403 || status === 404 || status === 429 || (typeof status === "number" && status >= 500));
          if (this.options.model === FREE_ROUTER && !streamed) {
            if (status === 403 || status === 404) this.refused.add(candidate.id);
            // Remember rate limits and server errors briefly: without this the runtime's
            // retry of the same turn reconnects to the model that just failed.
            else if (status === 429 || (typeof status === "number" && status >= 500)) this.cooling.set(candidate.id, now + MODEL_COOLDOWN_MS);
          }
          if (!switchable || attempt === Math.min(ordered.length, MAX_ROUTER_ATTEMPTS) - 1) throw error;
        }
      }
      throw new FreeAccessError("No free model accepted the request.", 503, true);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof FreeAccessError) throw error;
      const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 503;
      const hint = this.viaGateway ? (
        status === 429 ? "Free gateway limit reached. Wait before retrying, or set your own OPENROUTER_API_KEY."
        : status === 413 ? "The conversation is too large for the free gateway. Start a new session."
        : status === 403 ? "This free model refused the request. Choose another with /model."
        : "The free gateway could not complete the request. Try again later, or set your own OPENROUTER_API_KEY; no paid fallback was attempted.")
        : status === 401 ? "OpenRouter rejected the key. Update OPENROUTER_API_KEY in archymedes settings."
        : status === 403 ? "OpenRouter refused this free model for this key; some are limited to listed apps. Choose another with /model."
        : status === 402 ? "OpenRouter account quota or key budget is exhausted. Check the key limits."
        : status === 429 ? "OpenRouter free-model rate limit reached. Wait before retrying."
        : status === 404 ? "This free model is unavailable. Run /models refresh."
        : "Free model request failed. Check OpenRouter availability or refresh /models; no paid fallback was attempted.";
      const retryAfterMs = providerRetryAfterMs(error);
      throw new FreeAccessError(hint, status, status === 429 || status >= 500, retryAfterMs);
    }
  }

  private async attempt(model: string, messages: ReturnType<typeof toWireMessages>, output: number, request: AgentModelRequest,
    onTextDelta: AgentModelRequest["onTextDelta"], signal: AbortSignal): Promise<AgentModelTurn> {
    const response = await this.call({
      model, messages, max_tokens: output,
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
      provider: { require_parameters: true, max_price: { prompt: 0, completion: 0 }, allow_fallbacks: false },
      stream: true, stream_options: { include_usage: true },
    }, signal);
    const body = Symbol.asyncIterator in Object(response)
      ? await collectChatStream(response as AsyncIterable<ChatStreamChunk>, onTextDelta) : response as ChatResponse;
    const turn = turnFromChatResponse(body);
    const cost = (body.usage as { cost?: unknown } | null)?.cost;
    if (cost !== undefined && cost !== null && (typeof cost !== "number" || cost !== 0)) {
      throw new FreeAccessError("OpenRouter reported a nonzero or invalid cost for a free request. Stopping before executing any tools.");
    }
    if (!turn.usage.totalTokens) throw new FreeAccessError("OpenRouter returned no measured token usage; free inference was not confirmed.", 502, true);
    return turn;
  }
}
