/**
 * Byte-level timeouts for streaming provider calls.
 *
 * Every streaming adapter used to share one wall-clock `AbortSignal.timeout(180s)` over the whole
 * request. That confuses two different failures: a provider that never answers (dead) and a
 * provider that answers slowly (alive). A healthy free-tier stream that trickles tokens for three
 * minutes is not a failure, but the single timer killed it mid-sentence — the user saw a "timed
 * out", the runtime retried, and the retry raced the abandoned stream. That is the reconnect churn.
 *
 * The three deadlines of {@link createStreamDeadline} (first byte, idle, total) replace the one,
 * enforced here where the bytes are visible — a `fetch` wrapper, so the SDKs (OpenAI, Anthropic)
 * keep their parsing untouched and SSE keepalive comments count as signs of life:
 *
 * - **TTFB**: headers and the first byte must arrive within `ttfbMs`. Catches DNS, refused
 *   connections and queued-but-never-started requests.
 * - **Idle**: once bytes flow, silence longer than `idleMs` aborts. This is the dead-connection
 *   detector. It resets on every chunk — including SSE keepalives — so a slow stream is never
 *   mistaken for a stuck one.
 * - **Total**: `totalMs` bounds the whole request, so a stream that trickles forever still ends.
 *
 * Timeouts surface as {@link StreamTimeoutError}: they name the phase that failed and always contain
 * the words "timed out", which is what the runtime's retry classifier and the CLI's diagnosis match
 * on. Caller cancellation passes through untouched with the caller's own reason, so Ctrl+C never
 * looks like a provider timeout.
 */
import {
  createStreamDeadline, DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS, streamTimeoutsFor,
  type StreamTimeouts as DeadlineTimeouts,
} from "./stream-deadline";

export type StreamTimeouts = {
  /** Headers and the first byte must arrive within this long. Defaults to `DEFAULT_STREAM_TIMEOUTS.ttfbMs`. */
  ttfbMs?: number;
  /** Silence between chunks longer than this aborts. Defaults to `DEFAULT_STREAM_TIMEOUTS.idleMs`. */
  idleMs?: number;
  /** The whole request must complete within this long. Defaults to `DEFAULT_STREAM_TIMEOUTS.totalMs`. */
  totalMs?: number;
};

/** The deadline engine's defaults, under this transport's option names. */
export const DEFAULT_STREAM_TIMEOUTS = {
  ttfbMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  idleMs: DEFAULT_IDLE_TIMEOUT_MS,
  totalMs: DEFAULT_TOTAL_TIMEOUT_MS,
} as const;

/** Converts between this transport's option names and the deadline engine's. */
export function deadlineTimeouts(timeouts: StreamTimeouts = {}): Partial<DeadlineTimeouts> {
  return {
    ...(timeouts.ttfbMs !== undefined ? { firstByteMs: timeouts.ttfbMs } : {}),
    ...(timeouts.idleMs !== undefined ? { idleMs: timeouts.idleMs } : {}),
    ...(timeouts.totalMs !== undefined ? { totalMs: timeouts.totalMs } : {}),
  };
}

/**
 * The full budget for an adapter: explicit `streamTimeouts` win; otherwise the legacy `timeoutMs`
 * maps onto them as `streamTimeoutsFor` describes (it is the idle timeout and never shortens the
 * first-byte or total deadlines).
 */
export function resolveStreamTimeouts(timeoutMs?: number, overrides?: StreamTimeouts): DeadlineTimeouts {
  return streamTimeoutsFor(timeoutMs, deadlineTimeouts(overrides));
}

/**
 * Settles as `promise` does unless `signal` aborts first, in which case it rejects with the
 * signal's reason: the deadline's timeout, or the caller's own cancellation. A body source that
 * ignores its abort must still stop being read the moment either happens.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The losing promise may still settle later; its rejection must not go unhandled.
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      promise.catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** Enforces TTFB/idle/total timeouts on every request made through the returned fetch. */
export function fetchWithStreamTimeouts(fetchImpl: typeof fetch, timeouts: StreamTimeouts = {}): typeof fetch {
  const budget = deadlineTimeouts(timeouts);

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const caller = init?.signal ?? undefined;
    // Matches fetch semantics: a pre-aborted signal rejects without touching the network.
    caller?.throwIfAborted();
    const deadline = createStreamDeadline({ ...budget, ...(caller ? { signal: caller } : {}) });

    let response: Response;
    try {
      // Raced as well as signalled: a fetch that ignores its signal must still fail on time.
      response = await untilAborted(fetchImpl(input, { ...init, signal: deadline.signal }), deadline.signal);
    } catch (error) {
      deadline.dispose();
      throw error;
    }
    if (!response.body) {
      // No body to watch (a HEAD, a 204): nothing left the timers can observe.
      deadline.dispose();
      return response;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch {
      // Instrumentation must never break a request that would otherwise work.
      deadline.dispose();
      return response;
    }
    // Headers are the first byte: the first-byte phase is over, the idle timer starts.
    deadline.touch();
    let finished = false;
    const finish = (): void => {
      finished = true;
      deadline.dispose();
    };
    const watched = new ReadableStream<Uint8Array>({
      async pull(stream): Promise<void> {
        // A source that ignores the abort must not keep feeding a request that already failed:
        // the consumer would read stale bytes past the timeout it was promised.
        if (finished) {
          stream.error(deadline.signal.reason ?? new Error("Provider request was aborted"));
          return;
        }
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          // Every read races the deadline and the caller's cancellation, so a source that never
          // settles still ends on time.
          // A read that fails because the deadline fired carries the descriptive timeout error;
          // any other failure is the provider's own and passes through untouched.
          next = await untilAborted(reader.read(), deadline.signal);
        } catch (error) {
          finish();
          stream.error(error);
          return;
        }
        if (next.done) {
          finish();
          stream.close();
          return;
        }
        deadline.touch();
        stream.enqueue(next.value);
      },
      async cancel(reason): Promise<void> {
        finish();
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    });
    // Status, headers and content type are the contract the SDKs read; the body is the same
    // bytes, only watched.
    return new Response(watched, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}
