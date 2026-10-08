/**
 * Deadlines for a streamed model response.
 *
 * A single wall-clock `AbortSignal.timeout` over a whole streamed reply is the wrong shape: it
 * kills a long, healthy generation half-way through (the model is producing tokens the whole time)
 * while being far too patient with a connection that has silently stalled. What actually matters
 * is three separate questions:
 *
 * - **First byte** — has the model started answering at all? Reasoning models can think for minutes
 *   before the first chunk, so this one is generous.
 * - **Idle** — is the stream still alive? Reset by *every* received chunk or event, including
 *   reasoning and tool-call fragments that never surface as text.
 * - **Total** — a generous overall cap, so a stream that dribbles one byte a minute forever still
 *   ends.
 *
 * Whichever fires aborts the request with a {@link StreamTimeoutError}, which is named
 * `TimeoutError`, carries `code: "ETIMEDOUT"` and says "timed out" — so the runtime's existing
 * failure classification reads it as a timeout and the CLI's network diagnosis as one too.
 */

export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 300_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000;

export type StreamTimeoutPhase = "first_byte" | "idle" | "total";

export type StreamTimeouts = { firstByteMs: number; idleMs: number; totalMs: number };

export class StreamTimeoutError extends Error {
  /** Matches the DOMException name `AbortSignal.timeout` uses, which callers already recognise. */
  override readonly name = "TimeoutError";
  /** Transient by code, so the bounded retry policy sees it as a timeout rather than a bug. */
  readonly code = "ETIMEDOUT";

  constructor(readonly phase: StreamTimeoutPhase, readonly timeoutMs: number) {
    const seconds = Math.round(timeoutMs / 1000);
    super(phase === "first_byte"
      ? `Model request timed out: no response within ${seconds}s.`
      : phase === "idle"
        ? `Model stream timed out: no data received for ${seconds}s.`
        : `Model request timed out: exceeded the ${seconds}s overall limit.`);
  }
}

/**
 * Maps a provider's legacy single `timeoutMs` option onto the three deadlines.
 *
 * `timeoutMs` used to be a wall-clock limit over the whole response. It now means the *idle*
 * timeout: the longest silence tolerated mid-stream. It never shortens the first-byte or total
 * deadlines below their defaults (a reasoning model must still be allowed to think), but a value
 * larger than either raises it, so "be more patient" keeps meaning what it says.
 */
export function streamTimeoutsFor(timeoutMs?: number, overrides: Partial<StreamTimeouts> = {}): StreamTimeouts {
  const legacy = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
  return {
    firstByteMs: overrides.firstByteMs ?? Math.max(DEFAULT_FIRST_BYTE_TIMEOUT_MS, legacy ?? 0),
    idleMs: overrides.idleMs ?? legacy ?? DEFAULT_IDLE_TIMEOUT_MS,
    totalMs: overrides.totalMs ?? Math.max(DEFAULT_TOTAL_TIMEOUT_MS, legacy ?? 0),
  };
}

export type StreamDeadline = {
  /** Aborts on a deadline (reason: the {@link StreamTimeoutError}) or when the parent signal aborts. */
  readonly signal: AbortSignal;
  /** The deadline that fired, if one did. A parent (user) abort never sets this. */
  readonly timedOut: StreamTimeoutError | undefined;
  /** Whether any chunk has been received yet — i.e. whether the first-byte deadline is over. */
  readonly started: boolean;
  /** Records activity: ends the first-byte phase and restarts the idle timer. */
  touch(): void;
  /**
   * Resolves or rejects as `promise` does, unless a deadline fires first, in which case it rejects
   * with the timeout. Guards against a transport that ignores its abort signal.
   */
  race<T>(promise: Promise<T>): Promise<T>;
  /** Yields `stream`'s items, touching the deadline for each and racing every `next()`. */
  wrap<T>(stream: AsyncIterable<T>): AsyncIterable<T>;
  /** Stops every timer. Always call once the response is finished or has failed. */
  dispose(): void;
};

export function createStreamDeadline(options: Partial<StreamTimeouts> & { signal?: AbortSignal } = {}): StreamDeadline {
  const timeouts = {
    firstByteMs: options.firstByteMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    idleMs: options.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    totalMs: options.totalMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
  };
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let timedOut: StreamTimeoutError | undefined;
  let started = false;
  let disposed = false;
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const waiters = new Set<(error: StreamTimeoutError) => void>();

  const schedule = (ms: number, fire: () => void) => {
    const timer = setTimeout(fire, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  };
  const clear = () => {
    if (phaseTimer !== undefined) clearTimeout(phaseTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    phaseTimer = totalTimer = undefined;
  };
  const expire = (phase: StreamTimeoutPhase, ms: number) => {
    if (disposed || timedOut || options.signal?.aborted) return;
    timedOut = new StreamTimeoutError(phase, ms);
    clear();
    controller.abort(timedOut);
    for (const reject of waiters) reject(timedOut);
    waiters.clear();
  };

  if (!options.signal?.aborted) {
    phaseTimer = schedule(timeouts.firstByteMs, () => expire("first_byte", timeouts.firstByteMs));
    totalTimer = schedule(timeouts.totalMs, () => expire("total", timeouts.totalMs));
  }

  const touch = () => {
    if (disposed || timedOut) return;
    started = true;
    if (phaseTimer !== undefined) clearTimeout(phaseTimer);
    phaseTimer = schedule(timeouts.idleMs, () => expire("idle", timeouts.idleMs));
  };

  const race = <T>(promise: Promise<T>): Promise<T> => {
    if (timedOut) {
      promise.catch(() => undefined);
      return Promise.reject(timedOut);
    }
    return new Promise<T>((resolve, reject) => {
      const onTimeout = (error: StreamTimeoutError) => {
        // The losing promise may still settle later; its rejection must not go unhandled.
        promise.catch(() => undefined);
        reject(error);
      };
      waiters.add(onTimeout);
      promise.then(
        (value) => { waiters.delete(onTimeout); resolve(value); },
        (error: unknown) => { waiters.delete(onTimeout); reject(error); },
      );
    });
  };

  async function* wrap<T>(stream: AsyncIterable<T>): AsyncGenerator<T> {
    const iterator = stream[Symbol.asyncIterator]();
    let finished = false;
    try {
      while (true) {
        const next = await race(iterator.next());
        if (next.done) { finished = true; return; }
        touch();
        yield next.value;
      }
    } finally {
      // Not awaited: a stalled iterator's return() can queue behind the very next() that stalled.
      if (!finished) void Promise.resolve().then(() => iterator.return?.()).catch(() => undefined);
    }
  }

  return {
    signal,
    get timedOut() { return timedOut; },
    get started() { return started; },
    touch,
    race,
    wrap,
    dispose() { disposed = true; clear(); waiters.clear(); },
  };
}
