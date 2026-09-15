/**
 * The free gateway as a Web-standard handler, so the same code runs under Bun, Node or an edge
 * runtime. It holds the only copy of the OpenRouter key: clients get verified free models and
 * streamed completions, never the key, the account's identity, or a way to change billing policy.
 */
import { FREE_BASE_URL, type FreeModel } from "@archymedes/core/providers/free-catalog";
import { DEFAULT_LIMITS, sanitizeChatRequest, type GatewayLimits } from "./policy";
import { clientKey, consume, type CounterStore, type RateRule } from "./rate-limit";

export type GatewayConfig = {
  apiKey: string;
  store: CounterStore;
  rules: readonly RateRule[];
  /** Verified eligible models; see `catalog.ts`. */
  catalog: () => Promise<ReadonlyMap<string, FreeModel>>;
  salt: string;
  limits?: GatewayLimits;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Sent as OpenRouter app attribution. */
  referer?: string;
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

function failure(status: number, message: string, retryAfterMs?: number, origin: "gateway" | "upstream" = "gateway"): Response {
  return json(status, { error: { message, code: status } }, {
    ...(retryAfterMs ? { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } : {}),
    ...(origin === "gateway" ? { [GATEWAY_ERROR_HEADER]: String(status) } : {}),
  });
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
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;

  return async (request, clientIp) => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return json(200, { ok: true });

    if (request.method === "GET" && pathname === "/v1/models") {
      const eligible = await config.catalog().catch(() => undefined);
      if (!eligible) return failure(503, "Free model catalog unavailable. Try again shortly.");
      return json(200, { data: [...eligible.values()].map(listing) }, { "cache-control": "public, max-age=300" });
    }

    if (pathname !== "/v1/chat/completions") return failure(404, "Not found.");
    if (request.method !== "POST") return failure(405, "Use POST.");

    const decision = await consume(config.store, config.rules, clientKey(clientIp, config.salt), now()).catch(() => undefined);
    if (!decision) return failure(503, "Rate limiter unavailable; no request was sent.");
    if (!decision.ok) {
      const whose = decision.rule.startsWith("global") ? "Shared free capacity is busy" : "Free request limit reached for this address";
      return failure(429, `${whose}. Retry later, or use your own OPENROUTER_API_KEY.`, decision.retryAfterMs);
    }

    const text = await readBounded(request, limits.maxBodyBytes);
    if (text === undefined) return failure(413, "Request is too large for the free gateway. Start a new session.");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return failure(400, "Request body is not valid JSON."); }
    const eligible = await config.catalog().catch(() => undefined);
    if (!eligible) return failure(503, "Free model catalog unavailable. Try again shortly.");
    const policy = sanitizeChatRequest(parsed, eligible, limits);
    if ("status" in policy) return failure(policy.status, policy.message);

    let upstream: Response;
    try {
      upstream = await fetchImpl(`${FREE_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          ...(config.referer ? { "http-referer": config.referer } : {}),
          "x-title": "Archymedes",
        },
        body: JSON.stringify(policy.body),
        signal: request.signal,
        redirect: "error",
      });
    } catch {
      if (request.signal.aborted) return failure(499, "Client closed the request.");
      return failure(502, "Could not reach the model service.");
    }
    if (!upstream.ok) return upstreamFailure(upstream);
    return new Response(upstream.body, {
      status: 200,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
    });
  };
}
