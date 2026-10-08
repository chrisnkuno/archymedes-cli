/**
 * What a failed free-mode request means, in one line that says what to do next.
 *
 * Free failures have causes the user can act on and a generic "request failed" hides them all: an
 * OpenRouter account whose privacy settings exclude every endpoint of a free model (OpenRouter
 * answers "No endpoints found matching your data policy"), a negative credit balance (402, which
 * blocks even `:free` models), OpenRouter's own free-model limits (20 requests a minute; 50 a day,
 * or 1000 a day once 10 credits have been bought — https://openrouter.ai/docs/api-reference/limits),
 * and the hosted gateway's daily or per-minute allowance, whose 429 body names which with `kind`.
 *
 * Upstream error text is matched, never relayed: it can carry anything, including the request.
 * Only the gateway's own messages (marked `x-free-gateway-error`, sanitized server-side) are shown.
 */
import { formatResetUtc, parseFreeAllowanceHeaders, type FreeAllowanceHeaders } from "./free-usage";

type HeaderBag = { get?(name: string): string | null } | undefined;

export const OPENROUTER_PRIVACY_SETTINGS_URL = "https://openrouter.ai/settings/privacy";
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/settings/credits";

/** Longer than this, a `retry-after` is the daily reset rather than the per-minute limit. */
export const FREE_RETRY_AFTER_CEILING_SECONDS = 120;

export type FreeLimitKind = "daily_tokens" | "daily_requests" | "per_minute";

/** The gateway's JSON 429 body, `{error: {message, code, kind, reset_utc, retry_after_seconds}}`, validated field by field. */
export type FreeLimitBody = { message?: string; kind?: FreeLimitKind; resetUtc?: string; retryAfterSeconds?: number };

/**
 * Reads the limit body off a thrown error. The OpenAI SDK puts the body's `error` object on
 * `error.error`; a raw body (`{error: {...}}`) is accepted too. Absent or malformed reads as `{}`.
 */
export function parseFreeLimitBody(error: unknown): FreeLimitBody {
  const outer = (error as { error?: unknown } | undefined)?.error;
  const candidate = outer && typeof outer === "object" && (outer as { error?: unknown }).error && typeof (outer as { error?: unknown }).error === "object"
    ? (outer as { error: unknown }).error : outer;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
  const body = candidate as Record<string, unknown>;
  const kind = body.kind === "daily_tokens" || body.kind === "daily_requests" || body.kind === "per_minute" ? body.kind : undefined;
  const reset = typeof body.reset_utc === "string" && body.reset_utc.length <= 64 && Number.isFinite(Date.parse(body.reset_utc)) ? new Date(Date.parse(body.reset_utc)).toISOString() : undefined;
  const retry = typeof body.retry_after_seconds === "number" && Number.isFinite(body.retry_after_seconds) && body.retry_after_seconds >= 0 ? body.retry_after_seconds : undefined;
  const message = typeof body.message === "string" ? body.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 300) : undefined;
  return { ...(message ? { message } : {}), ...(kind ? { kind } : {}), ...(reset ? { resetUtc: reset } : {}), ...(retry !== undefined ? { retryAfterSeconds: retry } : {}) };
}

/** Whether an upstream message is OpenRouter refusing because of the account's data/privacy policy. */
export function isDataPolicyRefusal(message: string | undefined): boolean {
  return typeof message === "string" && /data policy|privacy setting|zero data retention|\bzdr\b|may train on|prompt training/i.test(message);
}

/**
 * Whether an OpenRouter 429 (user's own key) is the daily free-model cap rather than the per-minute
 * one. OpenRouter's platform 429 carries `X-RateLimit-Limit/Remaining/Reset` (reset in epoch ms);
 * a reset further away than a couple of minutes, or a per-day sized limit, is the daily cap.
 */
export function isOpenRouterDailyLimit(headers: HeaderBag, now: number): boolean {
  const remaining = Number(headers?.get?.("x-ratelimit-remaining"));
  const limit = Number(headers?.get?.("x-ratelimit-limit"));
  const resetRaw = Number(headers?.get?.("x-ratelimit-reset"));
  // Seconds or milliseconds: anything below 1e12 is read as seconds.
  const reset = Number.isFinite(resetRaw) && resetRaw > 0 ? (resetRaw < 1e12 ? resetRaw * 1000 : resetRaw) : undefined;
  if (headers?.get?.("x-ratelimit-remaining") == null || !Number.isFinite(remaining) || remaining > 0) return false;
  if (reset !== undefined) return reset - now > FREE_RETRY_AFTER_CEILING_SECONDS * 1000;
  return Number.isFinite(limit) && limit >= 50;
}

export type FreeFailure = { message: string; retryable: boolean; retryAfterMs?: number };

/**
 * A gateway 429 message with the reset time added when the message does not already say it.
 *
 * The gateway names the reset in its daily-limit messages but not in its per-minute or network
 * ones; `x-free-reset-utc` is on every 429, so the time is always available to say.
 */
export function withFreeResetTime(message: string, headers: FreeAllowanceHeaders | undefined, now = Date.now()): string {
  const reset = formatResetUtc(headers?.resetsAt);
  if (!reset || /\bresets?\b/i.test(message)) return message;
  const wait = Date.parse(headers!.resetsAt!) - now;
  const totalMinutes = Math.ceil(wait / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const inWords = wait > 0 ? ` (in ${hours > 0 ? `${hours}h ` : ""}${minutes}m)` : "";
  return `${message.replace(/\s+$/, "")}${/[.!?]$/.test(message.trim()) ? "" : "."} Allowance resets at ${reset}${inWords}.`;
}

const ADD_KEY = "add your own free OpenRouter key (archymedes settings → OpenRouter API key) to keep going";

/**
 * The one-line description, retryability and wait of an HTTP failure in free mode.
 *
 * `message` is the upstream text — matched for the data-policy refusal and otherwise relayed only
 * when `gatewayOwned` (the gateway's own sanitized message). `requestLimit` is the user's daily
 * free-request limit from OpenRouter's key info, and `requestsLeft` what it last said was left.
 */
export function describeFreeFailure(input: {
  status: number; viaGateway: boolean; gatewayOwned: boolean; message?: string; headers?: HeaderBag; body?: FreeLimitBody; now: number; requestLimit?: number; requestsLeft?: number;
}): FreeFailure {
  const { status, viaGateway, headers, now } = input;
  const body = input.body ?? {};
  // The body's own message first: the SDK prefixes the thrown message with the status ("429 …").
  const relayed = input.gatewayOwned ? (body.message || input.message?.trim() || undefined) : undefined;
  const retryAfterHeader = Number(headers?.get?.("retry-after"));
  const retryAfterSeconds = body.retryAfterSeconds ?? (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : undefined);
  const retryAfterMs = retryAfterSeconds !== undefined && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined;
  const allowance = parseFreeAllowanceHeaders(headers);
  const resetHeaders: FreeAllowanceHeaders | undefined = body.resetUtc ? { ...allowance, resetsAt: body.resetUtc } : allowance;
  const transient = status === 429 || status >= 500;

  if (viaGateway) {
    if (status === 429) {
      // The body's `kind` is authoritative; without it, a spent token count or a long wait means the day.
      const daily = body.kind ? body.kind !== "per_minute"
        : allowance?.remainingTokens === 0 || allowance?.remainingRequests === 0 || (retryAfterSeconds !== undefined && retryAfterSeconds > FREE_RETRY_AFTER_CEILING_SECONDS);
      const canned = body.kind === "daily_tokens" ? `Today's free token allowance is used up; ${ADD_KEY}.`
        : body.kind === "daily_requests" ? `Today's free request allowance is used up; ${ADD_KEY}.`
        : body.kind === "per_minute" ? "The free gateway is busy (per-minute limit). Wait a moment and retry."
        : "Free gateway limit reached. Wait before retrying, or set your own OPENROUTER_API_KEY.";
      return { message: withFreeResetTime(relayed ?? canned, resetHeaders, now), retryable: !daily, ...(retryAfterMs ? { retryAfterMs } : {}) };
    }
    const message = status === 413 ? "The conversation is too large for the free gateway. Start a new session."
      : status === 403 ? "This free model refused the request. Choose another with /model."
      : relayed ?? "The free gateway could not complete the request. Try again later, or set your own OPENROUTER_API_KEY; no paid fallback was attempted.";
    return { message, retryable: transient, ...(retryAfterMs ? { retryAfterMs } : {}) };
  }

  if (isDataPolicyRefusal(input.message) && (status === 404 || status === 400 || status === 403)) {
    return { message: `OpenRouter has no endpoint for this free model that your privacy settings allow. At ${OPENROUTER_PRIVACY_SETTINGS_URL}, allow free endpoints that may train on or log prompts, and turn off "ZDR endpoints only" if it is on; or choose another model with /model.`, retryable: false };
  }
  if (status === 429) {
    if (input.requestsLeft === 0 || isOpenRouterDailyLimit(headers, now)) {
      const limit = input.requestLimit ? ` (${input.requestLimit} requests a day on this account)` : "";
      return { message: `OpenRouter's daily free-model limit for this key is used up${limit}; it resets at 00:00 UTC. Accounts that have bought at least 10 credits get 1000 free requests a day (${OPENROUTER_CREDITS_URL}).`, retryable: false };
    }
    return { message: "OpenRouter free-model rate limit reached (20 requests a minute, or the model is busy upstream). Wait a moment and retry, or pick another model with /model.", retryable: true, ...(retryAfterMs ? { retryAfterMs } : {}) };
  }
  const message = status === 401 ? `OpenRouter rejected the key. Create a new one at ${OPENROUTER_KEYS_URL} and save it in archymedes settings (OpenRouter API key).`
    : status === 403 ? "OpenRouter refused this free model for this key; some are limited to listed apps. Choose another with /model."
    : status === 402 ? `OpenRouter says this account or key is out of credit (402). Free models still need a balance of zero or more and a key limit not yet reached: check ${OPENROUTER_CREDITS_URL} and the key's limit at ${OPENROUTER_KEYS_URL}.`
    : status === 404 ? "This free model is no longer available. Run /models refresh or choose another with /model."
    : status === 408 || status === 504 ? "The free model took too long to answer. Retry, or choose a faster one with /model."
    : status >= 500 ? "The free model's provider failed. Retry shortly or choose another with /model; no paid fallback was attempted."
    : "Free model request failed. Check OpenRouter availability or refresh /models; no paid fallback was attempted.";
  return { message, retryable: transient, ...(retryAfterMs ? { retryAfterMs } : {}) };
}
