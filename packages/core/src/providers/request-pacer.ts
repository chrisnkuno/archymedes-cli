/**
 * Client-side pacing for rate-limited providers.
 *
 * Retrying after a 429 is damage control; not sending the request that triggers it is the actual
 * fix. The free tier throttles per key, and the shape that trips it is a burst: the virtual router
 * trying four models back-to-back, or the runtime retrying on top of that. A pacer spaces request
 * starts so bursts never form.
 *
 * Additive-increase/multiplicative-*decrease* would be the textbook choice if the provider told us
 * its limit; it does not, so this runs the mirror image that fits an unknown limit:
 *
 * - Every 429 doubles the minimum gap between request starts (fast backoff to something the
 *   provider tolerates), floored by an explicit `Retry-After` when the provider names one.
 * - Every success relaxes the gap a step back toward full speed (slow recovery, so one lucky
 *   request does not immediately re-trigger the limiter).
 *
 * On top of the gap there is a window budget, which is what keeps the agent fast. Most limits are
 * "N requests per minute", and the cheapest way to honour one is to do nothing until it matters:
 * requests start at full speed while the last minute holds fewer than N, and the (N+1)th waits
 * only until the oldest of those leaves the window. That wait is shorter than the alternative, a
 * 429 followed by a backoff measured in seconds. N is configured where the provider is known and
 * learned from a 429 otherwise (the requests in the window when it hit, less one), so the limit that
 * refused us once is not walked into again. Two guards keep that from slowing a healthy run: a 429
 * after only a few requests is not taken for the per-minute limit (on the free tier it is usually one
 * busy upstream model), and a learned cap is forgotten after a few quiet windows.
 *
 * One pacer per provider instance, so the learned pace survives across turns: a session that hit
 * the limiter five minutes ago still paces itself, and a fresh session starts unthrottled. It is
 * deliberately not shared across processes — two CLIs cannot coordinate through it — which is why
 * the 429 path still exists underneath. Pacing avoids the limiter; retries survive it.
 */

export type PacerOptions = {
  /** Gap enforced after a 429 before doubling further. Defaults to 2s. */
  baseGapMs?: number;
  /** Ceiling for the gap. Defaults to 2 minutes. */
  maxGapMs?: number;
  /** How much of the gap one success forgives. Defaults to 500ms. */
  releaseMs?: number;
  /** Requests the provider allows per window; unset until configured or learned from a 429. */
  windowCap?: number;
  /** The window `windowCap` is measured over. Defaults to one minute. */
  windowMs?: number;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
};

/** A 429 with fewer requests than this in the window is not a per-minute limit worth learning. */
const MIN_LEARNABLE_CAP = 8;
/** Windows without a new 429 after which a learned cap is dropped. */
const LEARNED_CAP_LIFETIME_WINDOWS = 5;

const DEFAULTS = { baseGapMs: 2_000, maxGapMs: 120_000, releaseMs: 500 } as const;

export class RequestPacer {
  private gapMs = 0;
  private lastStart = 0;
  private readonly baseGapMs: number;
  private readonly maxGapMs: number;
  private readonly releaseMs: number;
  private readonly windowMs: number;
  private cap: number | undefined;
  private readonly configuredCap: number | undefined;
  /** When the cap was last lowered by a 429; 0 when it is the configured one. */
  private learnedAt = 0;
  /** Start times inside the window, oldest first. */
  private starts: number[] = [];
  private readonly now: () => number;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: PacerOptions = {}) {
    this.baseGapMs = options.baseGapMs ?? DEFAULTS.baseGapMs;
    this.maxGapMs = options.maxGapMs ?? DEFAULTS.maxGapMs;
    this.releaseMs = options.releaseMs ?? DEFAULTS.releaseMs;
    this.windowMs = options.windowMs ?? 60_000;
    this.cap = options.windowCap !== undefined && options.windowCap >= 1 ? Math.floor(options.windowCap) : undefined;
    this.configuredCap = this.cap;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((delayMs, signal) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delayMs);
      const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
      signal?.addEventListener("abort", onAbort, { once: true });
    }));
  }

  /** The per-window request budget in force, configured or learned; undefined when none is known. */
  get windowBudget(): number | undefined {
    return this.cap;
  }

  /** Requests started inside the current window. */
  get inWindow(): number {
    this.prune(this.now());
    return this.starts.length;
  }

  private prune(now: number): void {
    let drop = 0;
    while (drop < this.starts.length && now - this.starts[drop] >= this.windowMs) drop += 1;
    if (drop > 0) this.starts.splice(0, drop);
  }

  /** Current minimum gap between request starts, for tests and status. */
  get paceMs(): number {
    return this.gapMs;
  }

  /**
   * Waits until a request may start without violating the learned pace.
   *
   * A zero pace returns without touching the clock, so providers that never see a 429 pay
   * nothing — no timers, no delays, no flakiness in tests that never throttle.
   */
  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // The window first: it is the one wait that replaces a refusal, and it costs nothing until full.
    if (this.learnedAt > 0 && this.now() - this.learnedAt > LEARNED_CAP_LIFETIME_WINDOWS * this.windowMs) {
      this.cap = this.configuredCap; // quiet for long enough: whatever refused us has passed
      this.learnedAt = 0;
    }
    if (this.cap !== undefined) {
      for (;;) {
        const now = this.now();
        this.prune(now);
        if (this.starts.length < this.cap) break;
        // A few milliseconds past the oldest start's expiry, so a clock a touch behind the server's
        // does not land on the boundary and be refused anyway.
        await this.sleep(this.starts[0] + this.windowMs - now + 25, signal);
        signal?.throwIfAborted();
      }
    }
    if (this.gapMs > 0) {
      const remaining = this.gapMs - (this.now() - this.lastStart);
      if (remaining > 0) await this.sleep(remaining, signal);
      signal?.throwIfAborted();
    }
    this.lastStart = this.now();
    this.starts.push(this.lastStart); // kept even with no cap, so a first 429 can learn one from it
    if (this.starts.length > 512) this.starts.splice(0, this.starts.length - 512);
  }

  /** A request completed without throttling: relax toward full speed. */
  reportSuccess(): void {
    this.gapMs = Math.max(0, this.gapMs - this.releaseMs);
  }

  /**
   * The provider throttled a request: double the gap (or adopt its `Retry-After` when larger),
   * so the next attempt starts after the provider asked us to.
   */
  reportRateLimited(retryAfterMs?: number): void {
    // The refused request is among the starts: the ones before it are what the provider let through.
    this.prune(this.now());
    const admitted = this.starts.length - 1;
    if (admitted >= MIN_LEARNABLE_CAP && admitted < (this.cap ?? Number.POSITIVE_INFINITY)) {
      this.cap = admitted;
      this.learnedAt = this.now();
    }
    const doubled = this.gapMs <= 0 ? this.baseGapMs : Math.min(this.maxGapMs, this.gapMs * 2);
    const asked = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
    this.gapMs = Math.min(this.maxGapMs, Math.max(doubled, Math.min(this.maxGapMs, asked)));
  }
}
