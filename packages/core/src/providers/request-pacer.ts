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
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
};

const DEFAULTS = { baseGapMs: 2_000, maxGapMs: 120_000, releaseMs: 500 } as const;

export class RequestPacer {
  private gapMs = 0;
  private lastStart = 0;
  private readonly baseGapMs: number;
  private readonly maxGapMs: number;
  private readonly releaseMs: number;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: PacerOptions = {}) {
    this.baseGapMs = options.baseGapMs ?? DEFAULTS.baseGapMs;
    this.maxGapMs = options.maxGapMs ?? DEFAULTS.maxGapMs;
    this.releaseMs = options.releaseMs ?? DEFAULTS.releaseMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((delayMs, signal) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delayMs);
      const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
      signal?.addEventListener("abort", onAbort, { once: true });
    }));
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
    if (this.gapMs <= 0) {
      this.lastStart = this.now();
      return;
    }
    const elapsed = this.now() - this.lastStart;
    const remaining = this.gapMs - elapsed;
    if (remaining > 0) await this.sleep(remaining, signal);
    signal?.throwIfAborted();
    this.lastStart = this.now();
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
    const doubled = this.gapMs <= 0 ? this.baseGapMs : Math.min(this.maxGapMs, this.gapMs * 2);
    const asked = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
    this.gapMs = Math.min(this.maxGapMs, Math.max(doubled, Math.min(this.maxGapMs, asked)));
  }
}
