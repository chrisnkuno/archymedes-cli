/**
 * The free gateway as a Web-standard handler, so the same code runs under Bun, Node or an edge
 * runtime. It holds the only copy of the OpenRouter key: clients get verified free models and
 * streamed completions, never the key, the account's identity, or a way to change billing policy.
 */
import { FREE_BASE_URL, type FreeModel } from "@archymedes/core/providers/free-catalog";
import { DEFAULT_LIMITS, sanitizeChatRequest, type GatewayLimits } from "./policy";
import { INSTALL_HEADER, INSTALL_STATUS_HEADER, issueInstallToken, verifyInstallToken } from "./install-token";
import { consume, dailyRequestRules, gatewayIdentity, installRulesFrom, remainingRequests, installTokenRulesFrom, issueRulesFrom, tokenRulesFrom, type CounterStore, type Identities, type RateRule, type RateScope } from "./rate-limit";
import { guardIdle } from "./stream-guard";
import { chargeTokens, tokenAllowance, trackUsage, type TokenUsage } from "./usage";

/**
 * Anonymous install tokens (see `install-token.ts`). When configured, `POST /v1/install` issues
 * tokens and chat requests carrying a valid `x-archymedes-install` header are limited per install,
 * with relaxed per-address limits. Requests without a token keep the anonymous per-address limits.
 */
export type InstallConfig = {
  /** HMAC-SHA256 secret (`GATEWAY_TOKEN_SECRET`); at least 32 characters. */
  secret: string;
  /** Request rules for token holders. Default: `installRulesFrom({})`. */
  rules?: readonly RateRule[];
  /** Token-usage rules for token holders. Default: `installTokenRulesFrom({})`. */
  tokenRules?: readonly RateRule[];
  /** Rules charged per issued token. Default: `issueRulesFrom({})` (5 per address per day). */
  issueRules?: readonly RateRule[];
  /** Reject tokens older than this; unset means tokens do not expire. */
  maxAgeMs?: number;
};

export type GatewayConfig = {
  apiKey: string;
  store: CounterStore;
  rules: readonly RateRule[];
  /** Daily token allowance rules; charged from measured upstream usage. Defaults to the built-in 100k/day. */
  tokenRules?: readonly RateRule[];
  /** Verified eligible models; see `catalog.ts`. */
  catalog: () => Promise<ReadonlyMap<string, FreeModel>>;
  salt: string;
  limits?: GatewayLimits;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Sent as OpenRouter app attribution. */
  referer?: string;
  /**
   * How long the gateway waits for an upstream response before giving up.
   *
   * Without this, a hung upstream connection would hang the gateway indefinitely.
   * The client's abort signal is still honored — this is a ceiling, not a replacement.
   * Default: 120 seconds.
   */
  upstreamTimeoutMs?: number;
  /**
   * How long a flowing upstream body may go without sending a byte before the gateway aborts it
   * and ends the client stream with an SSE error event (or a JSON 504 for a non-streamed reply).
   * Default: 90 seconds.
   */
  upstreamIdleTimeoutMs?: number;
  /** Enables install tokens; omitted, `/v1/install` answers 503 and the header is ignored. */
  install?: InstallConfig;
};

export type GatewayHandler = (request: Request, clientIp: string | undefined) => Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

/**
 * Marks an error the gateway produced itself (a limit, an outage, exhausted capacity), as opposed to
 * one relayed from a specific model. Clients must not retry other models on it: every model sits
 * behind the same limit, so switching only spends more of it.
 */
const GATEWAY_ERROR_HEADER = "x-free-gateway-error";

function failure(status: number, message: string, retryAfterMs?: number, origin: "gateway" | "upstream" = "gateway", extra: Record<string, string> = {}, type?: string, details: Record<string, unknown> = {}): Response {
  return json(status, { error: { message, code: status, ...(type ? { type } : {}), ...details } }, {
    ...(retryAfterMs ? { "retry-after": String(retryAfterSeconds(retryAfterMs)) } : {}),
    ...(origin === "gateway" ? { [GATEWAY_ERROR_HEADER]: String(status) } : {}),
    ...extra,
  });
}

function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/** The instant a fixed window ends: for a day window, the next UTC midnight. */
function resetAtMs(windowMs: number, now: number): number {
  return (Math.floor(now / windowMs) + 1) * windowMs;
}

function iso(resetAt: number): string {
  return new Date(resetAt).toISOString();
}

/**
 * Which kind of limit a 429 is, for clients to act on without parsing the message:
 * `per_minute` (a burst limit: wait `retry_after_seconds`, usually under a minute, and continue),
 * `daily_requests` or `daily_tokens` (the allowance is used up until `reset_utc`).
 */
export type LimitKind = "per_minute" | "daily_requests" | "daily_tokens";

const DAY_MS = 24 * 60 * 60_000;

/** What the client has left, reported on every limit response alongside the reason. */
type Remaining = { tokens?: number; requests?: number };

/**
 * A 429 that names the limit that was reached, when it resets, and how to get
 * more capacity. Request limits say which limit fired — a minute limit is not
 * an exhausted daily allowance, and pretending otherwise is a lie the user
 * plans around. The body carries the same facts machine-readably:
 * `{error: {message, code: 429, kind, rule, scope, limit, reset_utc, retry_after_seconds,
 * remaining_tokens?, remaining_requests?}}`.
 */
function limited(ruleName: string, scope: RateScope, limit: number, windowMs: number, retryAfterMs: number, now: number, remaining: Remaining = {}, tokenRule = false): Response {
  const reset = resetAtMs(windowMs, now);
  const resetHeaders: Record<string, string> = {
    "x-free-reset-utc": iso(reset),
    ...(remaining.tokens !== undefined ? { "x-free-remaining-tokens": String(remaining.tokens) } : {}),
    ...(remaining.requests !== undefined ? { "x-free-remaining-requests": String(remaining.requests) } : {}),
  };
  const kind: LimitKind = tokenRule ? "daily_tokens" : windowMs < DAY_MS ? "per_minute" : "daily_requests";
  const details = {
    kind, rule: ruleName, scope, limit,
    reset_utc: iso(reset),
    retry_after_seconds: retryAfterSeconds(retryAfterMs),
    ...(remaining.tokens !== undefined ? { remaining_tokens: remaining.tokens } : {}),
    ...(remaining.requests !== undefined ? { remaining_requests: remaining.requests } : {}),
  };
  const send = (message: string) => failure(429, message, retryAfterMs, "gateway", resetHeaders, undefined, details);
  if (ruleName === "install-minute") {
    return send(`Free request limit reached for this install: ${limit} requests per minute. Retry in ${retryAfterSeconds(retryAfterMs)}s; your daily allowance is separate.`);
  }
  if (ruleName === "ip-day" || ruleName === "install-day") {
    return send(`You've reached today's free request limit (${limit} requests). Your allowance resets at ${iso(reset)}. Type /upgrade to use your own OpenRouter API key.`);
  }
  if (tokenRule && (ruleName === "ip-token-day" || ruleName === "install-token-day")) {
    return send(`You've reached today's free usage limit (${limit.toLocaleString("en-US")} tokens). Your allowance resets at ${iso(reset)}. Type /upgrade to use your own OpenRouter API key.`);
  }
  if (ruleName.startsWith("ip-shared")) {
    return send(`Free capacity for your network is ${kind === "per_minute" ? "busy" : "used up for today"}. Retry later, or use your own OPENROUTER_API_KEY.`);
  }
  if (ruleName.startsWith("issue-")) {
    return send(`Too many free installs ${ruleName === "issue-global-day" ? "today" : "from this network today"}. Retry after ${iso(reset)}; requests without an install token still work.`);
  }
  if (ruleName === "ip-minute") {
    return send(`Free request limit reached for this address: ${limit} requests per minute. Retry in ${retryAfterSeconds(retryAfterMs)}s; your daily allowance is separate.`);
  }
  const whose = ruleName.startsWith("global")
    ? (kind === "per_minute" ? "Shared free capacity is busy" : "Shared free capacity is exhausted")
    : "Free request limit reached for this address";
  return send(`${whose}. Retry later, or use your own OPENROUTER_API_KEY.`);
}

/** OpenRouter's listing shape, so the CLI's existing parser verifies gateway models the same way. */
function listing(model: FreeModel) {
  return {
    id: model.id, name: model.name, context_length: model.context_window,
    top_provider: { context_length: model.context_window, max_completion_tokens: model.max_output },
    pricing: { prompt: "0", completion: "0" },
    architecture: { input_modalities: model.modalities, output_modalities: ["text"] },
    supported_parameters: ["tools"],
  };
}

async function readBounded(request: Request, maxBytes: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length")) > maxBytes) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return text + decoder.decode();
    size += next.value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); return undefined; }
    text += decoder.decode(next.value, { stream: true });
  }
}

/** Upstream errors lose their metadata (it names the operator's account); status and a short message remain. */
async function upstreamFailure(response: Response): Promise<Response> {
  const retryAfter = Number(response.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  if (response.status === 401 || response.status === 402) {
    return failure(503, "Free capacity is unavailable right now. Try again later, or use your own OPENROUTER_API_KEY.", retryAfterMs);
  }
  const body = await response.json().catch(() => undefined) as { error?: { message?: unknown } } | undefined;
  const message = typeof body?.error?.message === "string" ? body.error.message.slice(0, 300) : "Upstream model request failed.";
  return failure(response.status, message, retryAfterMs, "upstream");
}

export function createFreeGateway(config: GatewayConfig): GatewayHandler {
  const limits = config.limits ?? DEFAULT_LIMITS;
  const anonymousTokenRules = config.tokenRules ?? tokenRulesFrom({});
  const install = config.install;
  const installRules = install?.rules ?? installRulesFrom({});
  const installTokenRules = install?.tokenRules ?? installTokenRulesFrom({});
  const issueRules = install?.issueRules ?? issueRulesFrom({});
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const firstByteMs = config.upstreamTimeoutMs ?? 120_000;
  const idleMs = config.upstreamIdleTimeoutMs ?? 90_000;

  const issue = async (clientIp: string | undefined): Promise<Response> => {
    if (!install) return failure(503, "Install tokens are not enabled on this gateway; send requests without one.");
    const ip = gatewayIdentity(clientIp, config.salt);
    const decision = await consume(config.store, issueRules, { ip }, now()).catch(() => undefined);
    if (!decision) return failure(503, "Rate limiter unavailable; no install was issued.");
    if (!decision.ok) return limited(decision.rule, decision.scope, decision.limit, decision.windowMs, decision.retryAfterMs, now());
    const { token, claims } = issueInstallToken(install.secret, now());
    return json(200, { token, install_id: claims.id, issued_at: new Date(claims.issuedAtMs).toISOString(), header: INSTALL_HEADER });
  };

  const chat = async (request: Request, clientIp: string | undefined): Promise<Response> => {
    const ip = gatewayIdentity(clientIp, config.salt);
    // A valid token adds a per-install identity and switches to the install rules; an invalid one
    // (forged, from another deployment, or signed with a rotated secret) is ignored and the request
    // is limited like any anonymous one, with a status header telling the client to re-register.
    const presented = request.headers.get(INSTALL_HEADER)?.trim();
    const claims = presented && install ? verifyInstallToken(presented, install.secret, now(), install.maxAgeMs) : undefined;
    const installStatus = presented && install ? (claims ? "valid" : "invalid") : undefined;
    const identity: Identities = claims ? { ip, install: claims.id } : { ip };
    const rules = claims ? installRules : config.rules;
    const tokenRules = claims ? installTokenRules : anonymousTokenRules;
    const tag = (response: Response): Response => {
      if (installStatus) response.headers.set(INSTALL_STATUS_HEADER, installStatus);
      return response;
    };

    // The token allowance is read before anything is sent. A request's usage is
    // only known once the model answers, so the count so far is the gate, and
    // this response's measured usage is charged as its stream is forwarded.
    const allowance = await tokenAllowance(config.store, tokenRules, identity, now()).catch(() => undefined);
    if (allowance === undefined && tokenRules.length > 0) {
      return tag(failure(503, "Rate limiter unavailable; no request was sent."));
    }
    if (allowance?.exhausted) {
      // Nothing is charged for a refused request, so the request allowance is read, not consumed.
      const requests = await tokenAllowance(config.store, dailyRequestRules(rules), identity, now()).catch(() => undefined);
      return tag(limited(allowance.rule.name, allowance.rule.scope, allowance.rule.limit, allowance.rule.windowMs, allowance.resetAtMs - now(), now(),
        { tokens: 0, requests: requests?.remaining }, true));
    }
    const decision = await consume(config.store, rules, identity, now()).catch(() => undefined);
    if (!decision) return tag(failure(503, "Rate limiter unavailable; no request was sent."));
    const requestsLeft = remainingRequests(rules, decision.counts);
    if (!decision.ok) {
      return tag(limited(decision.rule, decision.scope, decision.limit, decision.windowMs, decision.retryAfterMs, now(),
        { tokens: allowance?.remaining, requests: requestsLeft }));
    }

    const text = await readBounded(request, limits.maxBodyBytes);
    if (text === undefined) return tag(failure(413, "Request is too large for the free gateway. Start a new session."));
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return tag(failure(400, "Request body is not valid JSON.")); }
    const eligible = await config.catalog().catch(() => undefined);
    if (!eligible) return tag(failure(503, "Free model catalog unavailable. Try again shortly."));
    const policy = sanitizeChatRequest(parsed, eligible, limits);
    if ("status" in policy) return tag(failure(policy.status, policy.message));

    let upstream: Response;
    // One controller aborts the upstream for every reason the gateway gives up: no first byte in
    // time, or a flowing body that went idle. The client's own abort is honored alongside it.
    // The gateway sends each request to exactly one model, so the first-byte deadline is per
    // candidate by construction; clients iterate candidates and fail over on the errors below.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), firstByteMs);
    try {
      const signal = AbortSignal.any([request.signal, deadline.signal]);
      // The runtime's fetch pools and reuses keep-alive connections to OpenRouter across requests.
      upstream = await fetchImpl(`${FREE_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          ...(config.referer ? { "http-referer": config.referer } : {}),
          "x-title": "Archymedes",
        },
        body: JSON.stringify(policy.body),
        signal,
        redirect: "error",
      });
    } catch {
      if (request.signal.aborted) return tag(failure(499, "Client closed the request."));
      if (deadline.signal.aborted) {
        return tag(failure(504, "The model service did not answer in time. Try another free model.", undefined, "upstream", {}, "upstream_timeout"));
      }
      return tag(failure(502, "Could not reach the model service.", undefined, "upstream", {}, "upstream_unreachable"));
    } finally {
      clearTimeout(timer);
    }
    const sse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    if (upstream.body) {
      upstream = new Response(guardIdle(upstream.body, { idleMs, sse, onIdle: () => deadline.abort() }), {
        status: upstream.status, statusText: upstream.statusText, headers: upstream.headers,
      });
    }
    if (!upstream.ok) return tag(await upstreamFailure(upstream));
    // Allowance headers describe the state at the start of this request; the
    // usage this response reports is charged while its stream is forwarded,
    // and shows on the next request's headers.
    const freeHeaders: Record<string, string> = {};
    if (allowance) {
      freeHeaders["x-free-remaining-tokens"] = String(allowance.remaining);
      freeHeaders["x-free-reset-utc"] = iso(allowance.resetAtMs);
      if (allowance.warning) freeHeaders["x-free-allowance-warning"] = "You've used 80% of today's free allowance.";
    }
    if (requestsLeft !== undefined) freeHeaders["x-free-remaining-requests"] = String(requestsLeft);
    if (installStatus) freeHeaders[INSTALL_STATUS_HEADER] = installStatus;
    let tracked: Response;
    try {
      tracked = await trackUsage(upstream, (usage: TokenUsage) => {
        // Charged exactly once per response, from the usage the upstream
        // reported. A store failure here under-counts rather than failing a
        // response the user has already received.
        void chargeTokens(config.store, tokenRules, identity, now(), usage).catch(() => undefined);
      });
    } catch {
      // Only a non-streamed reply is read here; it stalled or broke before it was complete.
      if (request.signal.aborted) return tag(failure(499, "Client closed the request."));
      return tag(deadline.signal.aborted
        ? failure(504, "The model service stopped responding. Try another free model.", undefined, "upstream", {}, "upstream_idle_timeout")
        : failure(502, "The model service connection failed mid-response.", undefined, "upstream", {}, "upstream_stream_failed"));
    }
    // Streamed replies are forwarded chunk by chunk as they arrive; nothing is buffered.
    return new Response(tracked.body, {
      status: 200,
      headers: {
        "content-type": tracked.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        ...(sse ? { "x-accel-buffering": "no" } : {}),
        ...freeHeaders,
      },
    });
  };

  return async (request, clientIp) => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return json(200, { ok: true });

    if (request.method === "GET" && pathname === "/v1/models") {
      const eligible = await config.catalog().catch(() => undefined);
      if (!eligible) return failure(503, "Free model catalog unavailable. Try again shortly.");
      return json(200, { data: [...eligible.values()].map(listing) }, { "cache-control": "public, max-age=300" });
    }

    if (pathname === "/v1/install") {
      if (request.method !== "POST") return failure(405, "Use POST.");
      return issue(clientIp);
    }

    if (pathname !== "/v1/chat/completions") return failure(404, "Not found.");
    if (request.method !== "POST") return failure(405, "Use POST.");
    return chat(request, clientIp);
  };
}
