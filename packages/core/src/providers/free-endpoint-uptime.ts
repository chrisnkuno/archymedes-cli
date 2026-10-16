/**
 * Whether a free model's endpoint is up right now, from OpenRouter's own public figures.
 *
 * `GET /api/v1/models/{id}/endpoints` reports each endpoint's uptime over the last 30 minutes and the
 * last day. On 2026-10-16 that listing said, before any request was spent, what probing found out
 * the slow way: nemotron-3-ultra at 0% (10% over the day) timed out on every call, nemotron-3-nano-
 * omni at 0% (6%) answered "ResourceExhausted", and the models at 100% answered. The router reads
 * it for its candidates and moves the ones that are down behind every one that is up, instead of
 * spending a request and up to 45 seconds per turn rediscovering each outage.
 *
 * Uptime counts provider errors, not rate limits: a model can be at 100% and still refuse most free
 * requests with 429 (Gemma 4 on Google AI Studio did). Those are the health tracker's job
 * (free-health.ts) and the measured `busy` fit's (free-model-profiles.ts), not this module's.
 *
 * Public metadata, read without a credential, cached for a few minutes, and bounded by a short
 * deadline. Nothing here may fail or delay a turn by more than that deadline: an unknown figure
 * means "not known to be down".
 */
import { FREE_BASE_URL } from "./free-catalog";

export type EndpointUptime = { last30m?: number; last1d?: number };

/** Below this percentage over the most recent window, an endpoint counts as down. */
export const FREE_ENDPOINT_DOWN_PERCENT = 30;
export const FREE_UPTIME_TTL_MS = 5 * 60 * 1000;
/** The whole read, for every candidate in parallel. The listing usually answers in a few hundred ms. */
export const FREE_UPTIME_TIMEOUT_MS = 2_000;

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

/**
 * The best uptime among a model's endpoints: a model with one healthy endpoint is reachable.
 * Undefined when the body names no endpoint with a figure.
 */
export function parseEndpointUptime(body: unknown): EndpointUptime | undefined {
  const data = (body as { data?: { endpoints?: unknown } } | undefined)?.data;
  const endpoints = Array.isArray(data?.endpoints) ? data.endpoints : [];
  let best: EndpointUptime | undefined;
  for (const endpoint of endpoints.slice(0, 32)) {
    const row = endpoint as Record<string, unknown> | null;
    if (!row || typeof row !== "object") continue;
    const uptime = { last30m: percent(row.uptime_last_30m), last1d: percent(row.uptime_last_1d) };
    if (uptime.last30m === undefined && uptime.last1d === undefined) continue;
    const score = (u: EndpointUptime) => u.last30m ?? u.last1d ?? 0;
    if (!best || score(uptime) > score(best)) best = uptime;
  }
  return best;
}

/** Down when the most recent window known is below the threshold; unknown is never down. */
export function isEndpointDown(uptime: EndpointUptime | undefined): boolean {
  const latest = uptime?.last30m ?? uptime?.last1d;
  return latest !== undefined && latest < FREE_ENDPOINT_DOWN_PERCENT;
}

type UptimeFetch = (url: string, init: { signal: AbortSignal; redirect: RequestRedirect; headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Per-model uptime, cached. `down` never throws. It waits (at most its deadline) only for ids it has
 * never read; stale figures are answered at once and refreshed in the background, so after the
 * first turn a session never waits on this at all.
 */
export class FreeEndpointUptime {
  private readonly cache = new Map<string, { at: number; uptime: EndpointUptime | undefined }>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly options: { fetchImpl?: UptimeFetch; now?: () => number; baseUrl?: string; timeoutMs?: number } = {}) {}

  /** The ids, of those given, whose endpoints are known to be down. */
  async down(ids: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
    const now = (this.options.now ?? Date.now)();
    const unknown: Promise<void>[] = [];
    for (const id of ids) {
      const hit = this.cache.get(id);
      if (hit && hit.at <= now && now - hit.at < FREE_UPTIME_TTL_MS) continue;
      const reading = this.read(id, now);
      if (!hit) unknown.push(reading);
    }
    if (unknown.length) {
      const deadline = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? FREE_UPTIME_TIMEOUT_MS), ...(signal ? [signal] : [])]);
      await Promise.race([Promise.all(unknown), new Promise((resolve) => deadline.addEventListener("abort", resolve, { once: true }))]);
    }
    return new Set(ids.filter((id) => isEndpointDown(this.cache.get(id)?.uptime)));
  }

  /** One model's figures, at most one request in flight per model, bounded by its own deadline. */
  private read(id: string, now: number): Promise<void> {
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as unknown as UptimeFetch);
    const base = this.options.baseUrl ?? FREE_BASE_URL;
    // Its own deadline, not the turn's: a background refresh outlives the turn that started it.
    const signal = AbortSignal.timeout(Math.max(this.options.timeoutMs ?? FREE_UPTIME_TIMEOUT_MS, 10_000));
    const work = (async () => {
      try {
        // The id is a validated `publisher/model:free`; only the ':' needs escaping.
        const response = await fetchImpl(`${base}/models/${id.split("/").map(encodeURIComponent).join("/")}/endpoints`, { signal, redirect: "error", headers: { accept: "application/json" } });
        if (response.ok) this.cache.set(id, { at: now, uptime: parseEndpointUptime(await response.json()) });
      } catch {
        // Unknown is not down; the next turn asks again.
      } finally {
        this.inFlight.delete(id);
      }
    })();
    this.inFlight.set(id, work);
    return work;
  }
}
