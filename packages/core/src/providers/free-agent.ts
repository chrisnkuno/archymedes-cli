/**
 * Free mode's turn provider. With the user's own key every request goes to the fixed OpenRouter
 * host; without one it goes to a free gateway that holds a key server-side and never receives the
 * user's. Either way requests carry a zero price cap and fallbacks disabled, after re-checking the live catalog, because a stale cache must never
 * authorize paid inference. Failures are reported as they are; there is no silent paid fallback.
 */
import OpenAI, { APIConnectionError } from "openai";
import type { AgentModelRequest, AgentModelTurn, AgentOutputKind, AgentTurnProvider } from "../agent-runtime";
import { providerRetryAfterMs } from "../agent-runtime";
import { RequestPacer } from "./request-pacer";
import { approximateInputTokens } from "../model-cost";
import { FREE_BASE_URL, FREE_CATALOG_TTL_MS, FREE_ROUTER, FREE_ROUTER_PREFERENCE, isFreeModelId, type FreeCatalog, type FreeModel } from "./free-catalog";
import { fetchFreeCatalog } from "./free-catalog-fetch";
import { fileFreeInstallStore, FREE_INSTALL_HEADER, FREE_INSTALL_STATUS_HEADER, freeInstallFile, FreeInstallToken } from "./free-install";
import { describeFreeFailure, isOpenRouterDailyLimit, parseFreeLimitBody } from "./free-errors";
import { fileFreeHealthStore, freeHealthFile, FreeHealthTracker, orderByFreeHealth } from "./free-health";
import { allowanceAfterCall, fileFreeUsageStore, FreeUsageMeter, freeUsageFile, parseFreeAllowanceHeaders, utcDay, type FreeAllowanceHeaders } from "./free-usage";
import { nextUtcMidnight, OpenRouterKeyInfoCache } from "./openrouter-key-info";
import { repairToolCalls } from "./tool-call-repair";
import { capabilitiesFor, type ModelCapabilities } from "./model-capabilities";
import { collectChatStream, toWireMessages, turnFromChatResponse, withOpenRouterCacheControl, type ChatResponse, type ChatStreamChunk } from "./openai-compatible";
import { createStreamDeadline, streamTimeoutsFor, StreamTimeoutError, type StreamDeadline } from "./stream-deadline";

export { withFreeResetTime } from "./free-errors";

type HeaderBag = { get?(name: string): string | null } | undefined;
/**
 * One chat request. `headers` are extra request headers (the gateway install token); `onHeaders`
 * receives the response headers once they are known, so the token's status can be checked.
 */
type ChatCall = (body: Record<string, unknown>, signal: AbortSignal, headers: Record<string, string>, onHeaders: (headers: HeaderBag) => void) => Promise<unknown>;

/** Gateway failure types that mean "this model failed, another may not" (packages/free-gateway README). */
const RETRYABLE_UPSTREAM_TYPES = new Set(["upstream_timeout", "upstream_idle_timeout", "upstream_unreachable", "upstream_stream_failed"]);

/**
 * The HTTP status of a failure, including the gateway's in-stream error event. A stalled or broken
 * upstream stream ends with `data: {"error":{"code":504|502,"type":"upstream_…","retryable":true}}`;
 * the OpenAI SDK raises that as an `APIError` with no `status` but with the event's `error` object
 * (and its `code`/`type` copied onto the error), so the code is read from there.
 */
export function freeFailureStatus(error: unknown): number | undefined {
  const record = error as { status?: unknown; error?: unknown } | undefined;
  if (typeof record?.status === "number") return record.status;
  const body = (record?.error && typeof record.error === "object" ? record.error : record) as { code?: unknown; type?: unknown; retryable?: unknown } | undefined;
  if (!body || !(body.retryable === true || (typeof body.type === "string" && RETRYABLE_UPSTREAM_TYPES.has(body.type)))) return undefined;
  const code = typeof body.code === "number" ? body.code : Number(body.code);
  return Number.isInteger(code) && code >= 500 && code < 600 ? code : 502;
}

/** No HTTP response at all (DNS, refused, reset, TLS): a network fault, not a server error. */
function isTransportFailure(error: unknown): boolean {
  if (freeFailureStatus(error) !== undefined) return false;
  const name = (error as { name?: unknown })?.name;
  return error instanceof APIConnectionError || name === "APIConnectionError" || name === "APIConnectionTimeoutError" || error instanceof TypeError
    || Boolean((error as { cause?: unknown })?.cause);
}

/** Bounded so a router turn never fans out across the whole free list. */
const MAX_ROUTER_ATTEMPTS = 4;

/** The catalog check is a small metadata read with its own deadline, outside the inference budget. */
const CATALOG_TIMEOUT_MS = 15_000;

/**
 * How long a router candidate may stay silent before its first chunk when another candidate could
 * take over. Free endpoints that are overloaded tend to hang rather than refuse; waiting the full
 * reasoning-model first-byte allowance on each would spend minutes before failing over.
 */
export const FREE_CANDIDATE_FIRST_BYTE_TIMEOUT_MS = 45_000;

function rank(id: string): number {
  const index = FREE_ROUTER_PREFERENCE.indexOf(id);
  return index === -1 ? FREE_ROUTER_PREFERENCE.length : index;
}

/**
 * What a free session should budget against: the router's safe offline figures, narrowed to a
 * concrete model's own published context and output limits once the live listing names them.
 *
 * Only ever narrowed. The router's 32K/4K is what every free request is sized for, and a model that
 * claims more still answers through the same rationed gateway; one that holds less (an 8K model)
 * must be budgeted as one, or the session compacts too late and the request is refused for size.
 */
export function freeModelCapabilities(router: ModelCapabilities, model: Pick<FreeModel, "context_window" | "max_output"> | undefined): ModelCapabilities {
  if (!model) return router;
  return {
    ...router,
    contextWindow: model.context_window ? Math.min(router.contextWindow, model.context_window) : router.contextWindow,
    maxOutputTokens: model.max_output ? Math.min(router.maxOutputTokens, model.max_output) : router.maxOutputTokens,
  };
}

class FreeAccessError extends Error {
  /** Undefined for a network failure, so it is reported as one rather than as an HTTP error. */
  readonly status: number | undefined;
  constructor(message: string, status: number | null = 400, readonly retryable = false, readonly retryAfterMs?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.status = status ?? undefined;
  }
}

/** Direct or gateway access, with the free-only constraint enforced on every request. */
export class FreeAgentTurnProvider implements AgentTurnProvider {
  readonly selection: { provider: string; model: string };
  /**
   * Whether sessions on this provider run lean (see `AgentTurnProvider.tokenSaver`). On unless the
   * caller turns it off (`ARCHYMEDES_TOKEN_SAVER=off`): free requests are rationed, not billed.
   */
  readonly tokenSaver: boolean;
  /** Today's local token count; absent in tests that inject `call` without one. */
  private readonly usage?: FreeUsageMeter;
  private readonly call: ChatCall;
  private catalog?: FreeCatalog;
  /** Models OpenRouter refused (403/404) for this key; skipped by the router for this process. */
  private readonly refused = new Set<string>();

  private readonly baseUrl: string;
  private readonly viaGateway: boolean;
  /** The gateway install token; never used with the user's own key. */
  private readonly install?: FreeInstallToken;
  /** Recent per-model outcomes, which order the router's candidates; absent in tests. */
  private readonly health?: FreeHealthTracker;
  /** OpenRouter's own figures for the user's key (daily free requests, credits); never with the gateway. */
  private readonly keyInfo?: OpenRouterKeyInfoCache;
  /**
   * Learned request pacing for the free tier's per-key rate limit. Lives as long as the provider, so
   * a session that hit the limiter keeps spacing its requests across turns instead of re-forming the
   * burst that tripped it (the router trying models back-to-back, the runtime retrying on top).
   */
  private readonly pacer: RequestPacer;

  /**
   * `timeoutMs` is the stream's idle timeout (see `streamTimeoutsFor`); `firstByteTimeoutMs` is the
   * per-candidate first-byte deadline used while the router still has another candidate to try.
   */
  constructor(private readonly options: { apiKey?: string; gatewayUrl?: string; model: string; timeoutMs?: number; firstByteTimeoutMs?: number; tokenSaver?: boolean }, private readonly dependencies: {
    call?: ChatCall; catalog?: (signal: AbortSignal) => Promise<FreeCatalog>; now?: () => number;
    /**
     * Install-token source for gateway requests. Defaults to one stored in the config directory,
     * except when `call` is injected (tests), where it defaults to none; `null` disables it.
     */
    install?: FreeInstallToken | null;
    /**
     * The daily token meter. Defaults to a file in the config directory, except when `call` or
     * `catalog` is injected (tests), where it defaults to none; `null` disables it.
     */
    usage?: FreeUsageMeter | null;
    /** Per-model health ranking. Same defaulting as `usage`: a file, except in tests. */
    health?: FreeHealthTracker | null;
    /** OpenRouter key info for the user's own key. Same defaulting as `usage`; never used via the gateway. */
    keyInfo?: OpenRouterKeyInfoCache | null;
    /** Request pacing; a fresh, unthrottled pacer by default. */
    pacer?: RequestPacer;
  } = {}) {
    this.selection = { provider: "free", model: options.model };
    this.pacer = dependencies.pacer ?? new RequestPacer();
    this.tokenSaver = options.tokenSaver ?? true;
    // Only a fully real provider writes the user's config directory: one with an injected call or
    // catalog is a test, and must not add to anyone's daily count.
    const usage = dependencies.usage === undefined
      ? (dependencies.call || dependencies.catalog ? undefined : new FreeUsageMeter(fileFreeUsageStore(freeUsageFile(process.env)), dependencies.now))
      : dependencies.usage ?? undefined;
    if (usage) this.usage = usage;
    const injected = Boolean(dependencies.call || dependencies.catalog);
    const health = dependencies.health === undefined
      ? (injected ? undefined : new FreeHealthTracker(fileFreeHealthStore(freeHealthFile(process.env)), dependencies.now))
      : dependencies.health ?? undefined;
    if (health) this.health = health;
    const apiKey = options.apiKey?.trim();
    this.viaGateway = !apiKey && Boolean(options.gatewayUrl);
    if (!apiKey && !this.viaGateway) throw new FreeAccessError("Free mode is not configured: point ARCHYMEDES_FREE_GATEWAY_URL at a free gateway, or save your own OPENROUTER_API_KEY (archymedes settings). Free mode never falls back to a paid provider.");
    if (!isFreeModelId(options.model)) throw new FreeAccessError("Free mode accepts openrouter/free or an exact publisher/model:free ID; paid models are not allowed.");
    this.baseUrl = this.viaGateway ? `${options.gatewayUrl}/v1` : FREE_BASE_URL;
    const client = dependencies.call ? undefined : new OpenAI({
      // The gateway ignores Authorization; the placeholder only satisfies the SDK.
      apiKey: apiKey ?? "archymedes-free-gateway", baseURL: this.baseUrl, maxRetries: 0,
      fetch: (input, init) => globalThis.fetch(input, { ...init, redirect: "error" }),
    });
    if (apiKey) {
      const keyInfo = dependencies.keyInfo === undefined
        ? (injected ? undefined : new OpenRouterKeyInfoCache(apiKey, dependencies.now ? { now: dependencies.now } : {}))
        : dependencies.keyInfo ?? undefined;
      if (keyInfo) this.keyInfo = keyInfo;
    }
    if (this.viaGateway) {
      const install = dependencies.install === undefined
        ? (dependencies.call ? undefined : new FreeInstallToken({ gatewayUrl: options.gatewayUrl!, store: fileFreeInstallStore(freeInstallFile(process.env)) }))
        : dependencies.install ?? undefined;
      if (install) this.install = install;
    }
    this.call = dependencies.call ?? (async (body, signal, headers, onHeaders) => {
      // `withResponse` exposes the response headers (the install-token status) alongside the stream.
      const { data, response } = await client!.chat.completions.create(body as never, { signal, headers }).withResponse();
      onHeaders(response.headers);
      return data;
    });
  }

  /**
   * Safe offline budgets until live metadata is available; never inherit an unknown model's 200K.
   * A concrete `:free` model's own smaller limits apply once the catalog has been read (the session
   * re-reads this at every turn, so the first turn runs on the router's figures).
   */
  get capabilities(): ModelCapabilities {
    const router = capabilitiesFor(FREE_ROUTER);
    if (this.options.model === FREE_ROUTER) return router;
    return freeModelCapabilities(router, this.catalog?.models.find((model) => model.id === this.options.model && model.eligible));
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    // Only the caller's signal spans the whole call. The catalog check and every candidate attempt
    // get deadlines of their own, so one slow step can no longer use up the budget that failover
    // to the next candidate depends on.
    const userSignal = request.signal;
    try {
      userSignal?.throwIfAborted();
      if (!request.safetyIdentifier.trim()) throw new FreeAccessError("safetyIdentifier is required");
      // Fetched alongside the catalog check; never throws and never waits more than a few seconds.
      const installing = this.install?.get(userSignal);
      // Refreshed in the background (cached for a minute, short timeout); the meter reads whatever
      // is known when the call finishes and never waits for it.
      void this.keyInfo?.get();
      const now = (this.dependencies.now ?? Date.now)();
      if (!this.catalog || this.catalog.fetchedAt > now || now - this.catalog.fetchedAt >= FREE_CATALOG_TTL_MS) {
        const catalogSignal = AbortSignal.any([AbortSignal.timeout(CATALOG_TIMEOUT_MS), ...(userSignal ? [userSignal] : [])]);
        this.catalog = await (this.dependencies.catalog ?? ((abort) => fetchFreeCatalog({ signal: abort, discovery: false, modelsUrl: `${this.baseUrl}/models` })))(catalogSignal).catch((cause: unknown) => {
          // The cause is kept and no HTTP status is invented: an unreachable gateway is a network
          // fault (DNS, refused, timeout), while a listing that answered with an error keeps its own
          // status on the cause (see `fetchFreeCatalog`).
          throw new FreeAccessError("Could not verify the free model catalog. Check connectivity and retry; no inference was attempted.", null, true, undefined, cause);
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
      const preferred = this.options.model === FREE_ROUTER
        ? fitting.filter((model) => !this.refused.has(model.id)).sort((a, b) => rank(a.id) - rank(b.id) || (b.context_window ?? 0) - (a.context_window ?? 0) || a.id.localeCompare(b.id))
        : fitting;
      // Models that have been answering lately go first; the static preference breaks ties.
      const ordered = this.options.model === FREE_ROUTER && this.health
        ? orderByFreeHealth(preferred, await this.health.records(), now)
        : preferred;
      if (!ordered.length) throw new FreeAccessError("Every free model refused this key. Choose a specific model with /model or try again later.", 403);
      // Any output at all (text, reasoning or a tool-call fragment) ends failover: the turn has
      // started, and moving to another model would bill and stream a second, different answer.
      let streamed = false;
      const onTextDelta = request.onTextDelta && ((text: string) => { streamed = true; request.onTextDelta!(text); });
      const onOutputProgress = (kind: AgentOutputKind) => { streamed = true; request.onOutputProgress?.(kind); };
      const router = this.options.model === FREE_ROUTER;
      await installing;
      const attempts = ordered.slice(0, MAX_ROUTER_ATTEMPTS);
      const timeouts = streamTimeoutsFor(this.options.timeoutMs);
      for (const [attempt, candidate] of attempts.entries()) {
        const last = attempt === attempts.length - 1;
        // Paced before the deadline starts, so time spent waiting out the limiter is never counted
        // against the stream. A pacer that has never seen a 429 returns at once.
        await this.pacer.wait(userSignal);
        // A short first-byte deadline only where another candidate can take over; the last (or an
        // explicitly chosen) model gets the full allowance, since giving up early gains nothing.
        const deadline = createStreamDeadline({
          ...timeouts,
          ...(router && !last ? { firstByteMs: this.options.firstByteTimeoutMs ?? FREE_CANDIDATE_FIRST_BYTE_TIMEOUT_MS } : {}),
          signal: userSignal,
        });
        try {
          const turn = await this.attempt(candidate.id, messages, output, request, onTextDelta, onOutputProgress, deadline);
          void this.health?.record(candidate.id, { ok: true });
          this.pacer.reportSuccess();
          return turn;
        } catch (caught) {
          // The SDK reports a deadline abort as its own abort error; the deadline is the real cause.
          const error = deadline.timedOut ?? caught;
          // Includes the gateway's retryable in-stream error event (504/502), which has no HTTP status.
          const status = freeFailureStatus(error);
          // A gateway's own limit or outage applies to every model behind it; switching would only spend more of it.
          const gatewayOwned = this.viaGateway && Boolean((error as { headers?: Headers })?.headers?.get?.("x-free-gateway-error"));
          // A candidate that timed out before producing any output (usually the first-byte deadline)
          // is as good as a refusal; one that stalled after output began is not (see `streamed`).
          // A user abort is never switchable.
          const silent = error instanceof StreamTimeoutError;
          const refusedStatus = (!(error instanceof FreeAccessError) || status === 502)
            && (status === 403 || status === 404 || status === 429 || (typeof status === "number" && status >= 500));
          // OpenRouter's daily free cap is per account: every other free model would refuse too.
          const accountDaily = !this.viaGateway && status === 429
            && (isOpenRouterDailyLimit((error as { headers?: HeaderBag })?.headers, now) || this.keyInfo?.peek()?.freeDailyRequests?.remaining === 0);
          // A per-minute 429 teaches the pacer, so the next request waits out the limiter instead of
          // racing it. The daily cap is not taught: no spacing within today gets past it.
          if (status === 429 && !accountDaily && !gatewayOwned) this.pacer.reportRateLimited(providerRetryAfterMs(error));
          const switchable = router && !streamed && !userSignal?.aborted && !gatewayOwned && !accountDaily && (silent || refusedStatus);
          // A model's own failure counts against it; a user abort or an account/gateway limit does not.
          if (!userSignal?.aborted && !gatewayOwned && !accountDaily && (silent || refusedStatus || error instanceof FreeAccessError)) {
            void this.health?.record(candidate.id, { ok: false, reason: silent ? "timeout" : status !== undefined ? `HTTP ${status}` : "invalid response" });
          }
          if (router && !streamed && (status === 403 || status === 404)) this.refused.add(candidate.id);
          if (!switchable || last) throw error;
        } finally {
          deadline.dispose();
        }
      }
      throw new FreeAccessError("No free model accepted the request.", 503, true);
    } catch (error) {
      if (userSignal?.aborted) throw userSignal.reason;
      // A deadline is reported as itself, so the runtime classifies it as a timeout.
      if (error instanceof FreeAccessError || error instanceof StreamTimeoutError) throw error;
      // No response at all (DNS, refused, reset): report the network failure it is, with the
      // transport error as the cause, rather than an invented 503 "server error".
      if (isTransportFailure(error)) {
        throw new FreeAccessError(this.viaGateway
          ? "Could not reach the free gateway. Check connectivity and retry, or set your own OPENROUTER_API_KEY; no paid fallback was attempted."
          : "Could not reach OpenRouter. Check connectivity and retry; no paid fallback was attempted.", null, true, undefined, error);
      }
      const status = freeFailureStatus(error) ?? 503;
      // The gateway's own errors — marked x-free-gateway-error and sanitized server-side — name the
      // limit reached, when it resets, and how to get more capacity, so they are relayed rather
      // than replaced. Upstream text is only matched (for the data-policy refusal), never shown.
      const headers = (error as { headers?: HeaderBag })?.headers;
      const gatewayOwned = this.viaGateway && Boolean(headers?.get?.("x-free-gateway-error"));
      const message = typeof (error as { message?: unknown })?.message === "string" ? (error as { message: string }).message : undefined;
      const daily = this.keyInfo?.peek()?.freeDailyRequests;
      const failure = describeFreeFailure({
        status, viaGateway: this.viaGateway, gatewayOwned, ...(message ? { message } : {}), headers, body: parseFreeLimitBody(error),
        now: (this.dependencies.now ?? Date.now)(),
        ...(daily?.limit !== undefined ? { requestLimit: daily.limit } : {}),
        ...(daily?.remaining !== undefined ? { requestsLeft: daily.remaining } : {}),
      });
      throw new FreeAccessError(failure.message, status, failure.retryable, failure.retryAfterMs);
    }
  }

  private async attempt(model: string, messages: ReturnType<typeof toWireMessages>, output: number, request: AgentModelRequest,
    onTextDelta: AgentModelRequest["onTextDelta"], onOutputProgress: AgentModelRequest["onOutputProgress"], deadline: StreamDeadline): Promise<AgentModelTurn> {
    // Read per attempt: a token an earlier attempt had rejected is not sent again.
    const token = this.install?.current();
    // The allowance headers describe the day before this request; only a gateway sends them.
    let allowance: FreeAllowanceHeaders | undefined;
    const observe = (headers: HeaderBag) => {
      this.install?.observe(headers?.get?.(FREE_INSTALL_STATUS_HEADER), token);
      if (this.viaGateway) allowance = parseFreeAllowanceHeaders(headers) ?? allowance;
    };
    let response: unknown;
    try {
      response = await deadline.race(this.call({
        model, messages: withOpenRouterCacheControl(messages, model), max_tokens: output,
        ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
        provider: { require_parameters: true, max_price: { prompt: 0, completion: 0 }, allow_fallbacks: false },
        stream: true, stream_options: { include_usage: true },
      }, deadline.signal, token ? { [FREE_INSTALL_HEADER]: token } : {}, observe));
    } catch (error) {
      // Error responses carry the status header too.
      observe((error as { headers?: HeaderBag })?.headers);
      throw error;
    }
    const body = Symbol.asyncIterator in Object(response)
      ? await collectChatStream(deadline.wrap(response as AsyncIterable<ChatStreamChunk>), onTextDelta, onOutputProgress) : response as ChatResponse;
    const parsed = turnFromChatResponse(body);
    // Free models often send almost-JSON arguments; unambiguous ones are repaired here, and the
    // rest reach the runtime unchanged, which asks the model to resend them.
    const turn = parsed.toolCalls.length ? { ...parsed, toolCalls: repairToolCalls(parsed.toolCalls) } : parsed;
    const cost = (body.usage as { cost?: unknown } | null)?.cost;
    if (cost !== undefined && cost !== null && (typeof cost !== "number" || cost !== 0)) {
      throw new FreeAccessError("OpenRouter reported a nonzero or invalid cost for a free request. Stopping before executing any tools.");
    }
    if (!turn.usage.totalTokens) throw new FreeAccessError("OpenRouter returned no measured token usage; free inference was not confirmed.", 502, true);
    // Counted only once the call is confirmed free and measured; the meter never throws.
    const day = await this.usage?.record(turn.usage.totalTokens);
    // The user's own key: OpenRouter's figures from its key endpoint, net of this request.
    this.keyInfo?.noteRequest();
    const info = this.keyInfo?.peek();
    const requests = info?.freeDailyRequests;
    if (!day && !allowance && !info) return turn;
    const now = (this.dependencies.now ?? Date.now)();
    const today = day ?? { date: utcDay(now), usedTokens: 0 };
    return { ...turn, allowance: {
      ...allowanceAfterCall(today, allowance, turn.usage.totalTokens),
      ...(requests?.remaining !== undefined ? { remainingRequests: requests.remaining, resetsAt: nextUtcMidnight(now) } : {}),
      ...(requests?.limit !== undefined ? { requestLimit: requests.limit } : {}),
      ...(info?.limitRemaining !== undefined ? { creditsRemaining: info.limitRemaining } : {}),
    } };
  }
}
