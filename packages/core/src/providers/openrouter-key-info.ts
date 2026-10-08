/**
 * What OpenRouter itself says about the user's own key: `GET https://openrouter.ai/api/v1/key`.
 *
 * Free mode with the user's key has no gateway to report an allowance, and OpenRouter sends no
 * `X-RateLimit-*` headers on successful inference — so the only true "how much is left today" is
 * this endpoint's `free_model_daily_requests` ({used, limit, remaining} for the current UTC day)
 * and the key's credit figures. Documented at https://openrouter.ai/docs/api-reference/limits.
 *
 * Read defensively: every field is optional and validated on its own, an unknown shape reads as
 * "nothing known", and the key is only ever sent as the bearer header to the fixed OpenRouter
 * host — never logged, never put in an error message, never followed through a redirect.
 */
import { FREE_BASE_URL } from "./free-catalog";

export const OPENROUTER_KEY_URL = `${FREE_BASE_URL}/key`;
/** Fresh enough for a status line; the figure only moves by one per request. */
export const OPENROUTER_KEY_INFO_TTL_MS = 60_000;
const KEY_INFO_TIMEOUT_MS = 5_000;

export type OpenRouterKeyInfo = {
  label?: string;
  /** The key's credit limit; undefined when unlimited or not reported. */
  limit?: number;
  /** Credits left under the key's limit; undefined when unlimited or not reported. */
  limitRemaining?: number;
  /** Credits used, all time. */
  usage?: number;
  /** True when the account has never purchased credits. */
  isFreeTier?: boolean;
  /** Free-model (`:free`) requests for the current UTC day. */
  freeDailyRequests?: { used?: number; limit?: number; remaining?: number };
};

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

/** The documented `{ data: {...} }` body, field by field; anything malformed is dropped. */
export function parseOpenRouterKeyInfo(body: unknown): OpenRouterKeyInfo | undefined {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const row = data as Record<string, unknown>;
  const daily = row.free_model_daily_requests && typeof row.free_model_daily_requests === "object" ? row.free_model_daily_requests as Record<string, unknown> : undefined;
  const used = count(daily?.used);
  const limit = count(daily?.limit);
  const remaining = count(daily?.remaining) ?? (used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined);
  const info: OpenRouterKeyInfo = {
    ...(typeof row.label === "string" && row.label.trim() ? { label: row.label.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 80) } : {}),
    ...(finite(row.limit) !== undefined ? { limit: finite(row.limit) } : {}),
    ...(finite(row.limit_remaining) !== undefined ? { limitRemaining: finite(row.limit_remaining) } : {}),
    ...(finite(row.usage) !== undefined ? { usage: finite(row.usage) } : {}),
    ...(typeof row.is_free_tier === "boolean" ? { isFreeTier: row.is_free_tier } : {}),
    ...(used !== undefined || limit !== undefined || remaining !== undefined ? { freeDailyRequests: {
      ...(used !== undefined ? { used } : {}), ...(limit !== undefined ? { limit } : {}), ...(remaining !== undefined ? { remaining } : {}),
    } } : {}),
  };
  return info;
}

export type KeyCheck =
  | { ok: true; info: OpenRouterKeyInfo }
  | { ok: false; reason: "invalid" | "network" | "error"; status?: number };

export type KeyInfoFetch = (url: string, init: { signal: AbortSignal; redirect: RequestRedirect; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Asks OpenRouter about `apiKey`. Never throws: 401/403 is an invalid key, no response is a
 * network failure, anything else is an error with its status. The key appears in no result.
 */
export async function checkOpenRouterKey(apiKey: string, options: { fetchImpl?: KeyInfoFetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<KeyCheck> {
  const key = apiKey.trim();
  if (!key || /\s/.test(key)) return { ok: false, reason: "invalid" };
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? KEY_INFO_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  let response: Awaited<ReturnType<KeyInfoFetch>>;
  try {
    response = await (options.fetchImpl ?? globalThis.fetch)(OPENROUTER_KEY_URL, { signal, redirect: "error", headers: { authorization: `Bearer ${key}`, accept: "application/json" } });
  } catch {
    // The transport error is deliberately not kept: some runtimes echo request headers into it.
    return { ok: false, reason: "network" };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "invalid", status: response.status };
  if (!response.ok) return { ok: false, reason: "error", status: response.status };
  const info = parseOpenRouterKeyInfo(await response.json().catch(() => undefined));
  return info ? { ok: true, info } : { ok: false, reason: "error", status: response.status };
}

/** One sentence for a failed check, suitable for the terminal. */
export function describeKeyCheckFailure(check: Extract<KeyCheck, { ok: false }>): string {
  if (check.reason === "invalid") return "OpenRouter did not accept that key. Copy it again from https://openrouter.ai/keys (it starts with sk-or-).";
  if (check.reason === "network") return "Could not reach OpenRouter to check the key. Check your connection.";
  return `OpenRouter could not check the key right now (HTTP ${check.status ?? "error"}). Try again shortly.`;
}

/**
 * Key info cached for `OPENROUTER_KEY_INFO_TTL_MS`. Concurrent callers share one request, a failed
 * read keeps the last good figure (and is retried after the TTL), and `peek` never waits.
 */
export class OpenRouterKeyInfoCache {
  private value?: OpenRouterKeyInfo;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private pending?: Promise<OpenRouterKeyInfo | undefined>;

  constructor(private readonly apiKey: string, private readonly options: { fetchImpl?: KeyInfoFetch; now?: () => number; ttlMs?: number; timeoutMs?: number } = {}) {}

  /** The newest figure without waiting, or undefined before the first read finishes. */
  peek(): OpenRouterKeyInfo | undefined {
    return this.value;
  }

  /** Fresh info, refreshed when older than the TTL. Never throws. */
  get(signal?: AbortSignal): Promise<OpenRouterKeyInfo | undefined> {
    const now = (this.options.now ?? Date.now)();
    if (this.value && now - this.fetchedAt < (this.options.ttlMs ?? OPENROUTER_KEY_INFO_TTL_MS)) return Promise.resolve(this.value);
    if (this.pending) return this.pending;
    this.pending = checkOpenRouterKey(this.apiKey, { ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}), ...(signal ? { signal } : {}), timeoutMs: this.options.timeoutMs ?? KEY_INFO_TIMEOUT_MS })
      .then((check) => {
        // A failure still counts as a read, so a down endpoint is not asked again on every request.
        this.fetchedAt = (this.options.now ?? Date.now)();
        if (check.ok) this.value = check.info;
        return this.value;
      })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /** One request was just spent: count it locally until the next read corrects the figure. */
  noteRequest(): void {
    const daily = this.value?.freeDailyRequests;
    if (!this.value || !daily || daily.remaining === undefined) return;
    this.value = { ...this.value, freeDailyRequests: { ...daily, remaining: Math.max(0, daily.remaining - 1), ...(daily.used !== undefined ? { used: daily.used + 1 } : {}) } };
  }
}

/** The next UTC midnight after `now`, as an ISO timestamp: when `free_model_daily_requests` resets. */
export function nextUtcMidnight(now: number): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
}
