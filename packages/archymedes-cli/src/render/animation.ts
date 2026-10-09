import { ASCII_GLYPHS, UNICODE_GLYPHS, type GlyphSet } from "../text/glyphs";

/**
 * Time-based motion: the spinner, the countdown, and the spring that eases a number towards a
 * target between repaints.
 *
 * Split out of `tui.ts`, which is the pinned status region and the widgets it draws. None of this
 * writes to a terminal or knows a colour — each piece takes a callback and a clock, which is why
 * they are all directly testable and why they were the obvious thing to lift when `tui.ts` grew
 * past its size ratchet. `tui.ts` re-exports every name, so existing importers are unaffected.
 */
/**
 * A drawn arc sweeping a full turn — a compass tracing a spiral, not a generic wheel.
 *
 * Every frame is five columns wide, so the activity text beside it never jitters left and right
 * as the arc rotates through its six positions. A console that cannot draw the arc glyphs gets the
 * four-frame ASCII radius (`- \ | /`) from `ASCII_GLYPHS` rather than columns of question marks.
 */
export function archymedesSpinnerFrame(index: number, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  const frames = glyphs.spinnerFrames;
  const normalized = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  return frames[normalized % frames.length];
}

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  private delay: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onTick: () => void,
    private readonly intervalMs = 120,
    private readonly glyphs: GlyphSet = UNICODE_GLYPHS,
    /**
     * How long an operation must last before it is worth animating.
     *
     * Zero renders immediately, which is right when the caller knows the wait is real. A short
     * delay is right when it does not: an operation that finishes in 40ms draws a spinner frame
     * and erases it, and a run of those reads as flicker rather than as feedback — the thing the
     * spinner exists to prevent. 200ms is the usual threshold, and is below what a person
     * perceives as a pause.
     */
    private readonly delayMs = 0,
  ) {}

  start(): void {
    if (this.timer || this.delay) return;
    const begin = () => {
      this.delay = undefined;
      this.onTick();
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % this.glyphs.spinnerFrames.length;
        this.onTick();
      }, this.intervalMs);
    };
    if (this.delayMs <= 0) begin();
    else this.delay = setTimeout(begin, this.delayMs);
  }

  stop(): void {
    // A spinner stopped inside its own start delay never drew anything; cancelling the pending
    // start is what makes that true, and is the whole point of the delay.
    if (this.delay) {
      clearTimeout(this.delay);
      this.delay = undefined;
    }
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get glyph(): string {
    return archymedesSpinnerFrame(this.frame, this.glyphs);
  }
}

/** `6s`, or `1m 05s` once a minute is on the clock — Bubbles' Timer output format. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Counts down to zero and says so on the way — Archymedes's answer to Bubbles' `timer`, for the one place
 * that used to go silent for the whole wait: the pace's cooldown between turns printed one static
 * "pausing 6s" line and then `setTimeout`'d through it, so a slow pace looked frozen rather than
 * counting down.
 *
 * A plain `setInterval` wrapped for the same reason `Spinner` is: so the call site owns only "what
 * a tick looks like," not clock arithmetic, and ticking against a fixed end time rather than
 * counting down a mutable remainder means a slow event loop cannot make the timer drift long.
 */
export class CountdownTimer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly endsAt: number;

  constructor(
    durationMs: number,
    private readonly onTick: (remainingMs: number) => void,
    private readonly onDone: () => void,
    private readonly intervalMs = 1_000,
  ) {
    this.endsAt = Date.now() + Math.max(0, durationMs);
  }

  get remaining(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  start(): void {
    if (this.timer) return;
    if (this.remaining <= 0) { this.onDone(); return; }
    this.onTick(this.remaining);
    this.timer = setInterval(() => {
      const left = this.remaining;
      if (left <= 0) { this.stop(); this.onDone(); return; }
      this.onTick(left);
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * A damped harmonic oscillator, in the spirit of Charm's Harmonica but not the same algorithm.
 *
 * Harmonica solves the spring *exactly*: `NewSpring` precomputes a state-transition matrix from the
 * closed-form analytic solution, branching on the three damping regimes (two real exponentials when
 * over-damped, `exp` against `cos`/`sin` when under-damped, the `t·exp` marginal case at exactly
 * critical). This is the implicit — backward — Euler form instead, which is an approximation of the
 * same system rather than the solution to it.
 *
 * That is a deliberate trade, for one reason: Harmonica bakes `deltaTime` into its coefficients at
 * construction, so a spring driven at a rate that changes has to be rebuilt to stay correct. This
 * takes `dt` per step, which is what a terminal actually offers — a repaint interval that slips
 * whenever the event loop is busy. It keeps the property that matters, unconditional stability: a
 * *forward* Euler spring diverges once `dt` grows past its natural period, where this one converges
 * at any timestep at all (verified out to a ten-second step, which no redraw will ever be).
 *
 * Accuracy is the thing given up, and it does not matter here. Nothing in a terminal reads the
 * intermediate positions of a settling animation as data; they are there to be looked at.
 */
export class Spring {
  constructor(private readonly angularFrequency: number, private readonly dampingRatio: number) {}

  /** One step forward. `dt` in seconds. Returns the new `[position, velocity]`. */
  update(position: number, velocity: number, target: number, dt: number): [number, number] {
    const omega = this.angularFrequency;
    const zeta = this.dampingRatio;
    const f = 1 + 2 * dt * zeta * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const detInv = 1 / (f + hhoo);
    const detX = f * position + dt * velocity + hhoo * target;
    const detV = velocity + hoo * (target - position);
    return [detX * detInv, detV * detInv];
  }
}

export type SpringAnimatorOptions = {
  /** How stiff the spring is — higher settles faster. Tuned for a redraw a person is meant to notice, not a snap. */
  angularFrequency?: number;
  /** 1 is critically damped (no overshoot); below 1 oscillates before settling. */
  dampingRatio?: number;
  intervalMs?: number;
  /** Stops ticking once within this distance of the target with near-zero velocity, rather than running forever on an unnoticeable tail. */
  epsilon?: number;
};

/**
 * Drives a `Spring` toward a moving target over real time, ticking a callback with the current
 * position until it settles — the same shape `Spinner` and `CountdownTimer` already use, so a
 * caller manages this exactly like the other two: `start`/`stop`, one `onTick`.
 *
 * The target can change mid-flight — `retarget` just updates where the spring is headed without
 * resetting its current position or velocity, which is the whole point: a second keystroke while a
 * resize is still animating should redirect it, not restart it from a standstill.
 */
export class SpringAnimator {
  private readonly spring: Spring;
  private position: number;
  private velocity = 0;
  private target: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMs: number;
  private readonly epsilon: number;

  constructor(initial: number, private readonly onTick: (position: number) => void, options: SpringAnimatorOptions = {}) {
    this.position = initial;
    this.target = initial;
    this.spring = new Spring(options.angularFrequency ?? 18, options.dampingRatio ?? 0.86);
    this.intervalMs = options.intervalMs ?? 40;
    this.epsilon = options.epsilon ?? 0.01;
  }

  get value(): number {
    return this.position;
  }

  get settled(): boolean {
    return !this.timer;
  }

  /** Redirects the spring at its current position and velocity — it does not jump or reset. */
  retarget(target: number): void {
    this.target = target;
    if (Math.abs(this.target - this.position) < this.epsilon && Math.abs(this.velocity) < this.epsilon) {
      this.position = target;
      this.onTick(target);
      return;
    }
    this.ensureRunning();
  }

  /** Jumps straight there — no animation — and stops. For the moments a spring would be wrong: dismissal, not resize. */
  snapTo(target: number): void {
    this.stop();
    this.position = target;
    this.velocity = 0;
    this.target = target;
    this.onTick(target);
  }

  private ensureRunning(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const dt = this.intervalMs / 1_000;
      const [pos, vel] = this.spring.update(this.position, this.velocity, this.target, dt);
      this.position = pos;
      this.velocity = vel;
      if (Math.abs(this.target - pos) < this.epsilon && Math.abs(vel) < this.epsilon) {
        this.position = this.target;
        this.stop();
        this.onTick(this.target);
        return;
      }
      this.onTick(pos);
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
