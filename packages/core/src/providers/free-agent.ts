/**
 * Free mode's turn provider. Every request goes to the fixed OpenRouter host with a zero price cap
 * and fallbacks disabled, after re-checking the live catalog, because a stale cache must never
 * authorize paid inference. Failures are reported as they are; there is no silent paid fallback.
 */
import OpenAI from "openai";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { approximateInputTokens } from "../model-cost";
import { FREE_BASE_URL, FREE_CATALOG_TTL_MS, FREE_ROUTER, FREE_ROUTER_PREFERENCE, isFreeModelId, type FreeCatalog } from "./free-catalog";
import { fetchFreeCatalog } from "./free-catalog-fetch";
import { capabilitiesFor } from "./model-capabilities";
import { collectChatStream, toWireMessages, turnFromChatResponse, type ChatResponse, type ChatStreamChunk } from "./openai-compatible";

type ChatCall = (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/** Bounded so a router turn never fans out across the whole free list. */
const MAX_ROUTER_ATTEMPTS = 4;

function rank(id: string): number {
  const index = FREE_ROUTER_PREFERENCE.indexOf(id);
  return index === -1 ? FREE_ROUTER_PREFERENCE.length : index;
}

class FreeAccessError extends Error {
  constructor(message: string, readonly status = 400, readonly retryable = false, readonly retryAfterMs?: number) { super(message); }
}

/** Fixed-host direct access, with the free-only constraint enforced on every request. */
export class FreeAgentTurnProvider implements AgentTurnProvider {
  readonly selection: { provider: string; model: string };
  // Safe offline budgets until live metadata is available; never inherit an unknown model's 200K.
  readonly capabilities = capabilitiesFor(FREE_ROUTER);
  private readonly call: ChatCall;
  private catalog?: FreeCatalog;
  /** Models OpenRouter refused (403/404) for this key; skipped by the router for this process. */
  private readonly refused = new Set<string>();

  constructor(private readonly options: { apiKey: string; model: string; timeoutMs?: number }, private readonly dependencies: {
    call?: ChatCall; catalog?: (signal: AbortSignal) => Promise<FreeCatalog>; now?: () => number;
  } = {}) {
    this.selection = { provider: "free", model: options.model };
    if (!options.apiKey.trim()) throw new FreeAccessError("Free mode needs OPENROUTER_API_KEY. Configure it in archymedes settings.");
    if (!isFreeModelId(options.model)) throw new FreeAccessError("Free mode accepts openrouter/free or an exact publisher/model:free ID; paid models are not allowed.");
    const client = dependencies.call ? undefined : new OpenAI({
      apiKey: options.apiKey, baseURL: FREE_BASE_URL, maxRetries: 0,
      fetch: (input, init) => globalThis.fetch(input, { ...init, redirect: "error" }),
    });
    this.call = dependencies.call ?? (async (body, signal) => await client!.chat.completions.create(body as never, { signal }));
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    const signal = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? 180_000), ...(request.signal ? [request.signal] : [])]);
    try {
      signal.throwIfAborted();
      if (!request.safetyIdentifier.trim()) throw new FreeAccessError("safetyIdentifier is required");
      const now = (this.dependencies.now ?? Date.now)();
      if (!this.catalog || this.catalog.fetchedAt > now || now - this.catalog.fetchedAt >= FREE_CATALOG_TTL_MS) {
        this.catalog = await (this.dependencies.catalog ?? ((abort) => fetchFreeCatalog({ signal: abort, discovery: false })))(signal).catch(() => {
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
      const ordered = this.options.model === FREE_ROUTER
        ? fitting.filter((model) => !this.refused.has(model.id)).sort((a, b) => rank(a.id) - rank(b.id) || (b.context_window ?? 0) - (a.context_window ?? 0) || a.id.localeCompare(b.id))
        : fitting;
      if (!ordered.length) throw new FreeAccessError("Every free model refused this key. Choose a specific model with /model or try again later.", 403);
      let streamed = false;
      const onTextDelta = request.onTextDelta && ((text: string) => { streamed = true; request.onTextDelta!(text); });
      for (const [attempt, candidate] of ordered.slice(0, MAX_ROUTER_ATTEMPTS).entries()) {
        try {
          return await this.attempt(candidate.id, messages, output, request, onTextDelta, signal);
        } catch (error) {
          const status = (error as { status?: unknown })?.status;
          const switchable = this.options.model === FREE_ROUTER && !streamed && !signal.aborted && (!(error instanceof FreeAccessError) || status === 502)
            && (status === 403 || status === 404 || status === 429 || (typeof status === "number" && status >= 500));
          if (this.options.model === FREE_ROUTER && !streamed && (status === 403 || status === 404)) this.refused.add(candidate.id);
          if (!switchable || attempt === Math.min(ordered.length, MAX_ROUTER_ATTEMPTS) - 1) throw error;
        }
      }
      throw new FreeAccessError("No free model accepted the request.", 503, true);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof FreeAccessError) throw error;
      const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 503;
      const hint = status === 401 ? "OpenRouter rejected the key. Update OPENROUTER_API_KEY in archymedes settings."
        : status === 403 ? "OpenRouter refused this free model for this key; some are limited to listed apps. Choose another with /model."
        : status === 402 ? "OpenRouter account quota or key budget is exhausted. Check the key limits."
        : status === 429 ? "OpenRouter free-model rate limit reached. Wait before retrying."
        : status === 404 ? "This free model is unavailable. Run /models refresh."
        : "Free model request failed. Check OpenRouter availability or refresh /models; no paid fallback was attempted.";
      const retryAfter = Number((error as { headers?: Headers })?.headers?.get?.("retry-after"));
      throw new FreeAccessError(hint, status, status === 429 || status >= 500, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
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
