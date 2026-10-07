/**
 * Byte-level timeouts for streaming provider calls.
 *
 * Every streaming adapter used to share one wall-clock `AbortSignal.timeout(180s)` over the whole
 * request. That confuses two different failures: a provider that never answers (dead) and a
 * provider that answers slowly (alive). A healthy free-tier stream that trickles tokens for three
 * minutes is not a failure, but the single timer killed it mid-sentence — the user saw a "timed
 * out", the runtime retried, and the retry raced the abandoned stream. That is the reconnect churn.
 *
 * Three timers replace the one, enforced where the bytes are visible — a `fetch` wrapper, so the
 * SDKs (OpenAI, Anthropic) keep their parsing untouched:
 *
 * - **TTFB**: headers and the first byte must arrive within `ttfbMs`. Catches DNS, refused
 *   connections and queued-but-never-started requests fast.
 * - **Idle**: once bytes flow, silence longer than `idleMs` aborts. This is the dead-connection
 *   detector. It resets on every chunk — including SSE keepalives — so a slow stream is never
 *   mistaken for a stuck one.
 * - **Total**: `totalMs` bounds the whole request, so a stream that trickles forever still ends.
 *
 * Timeout errors name the phase that failed and always contain the words "timed out", which is what
 * the runtime's retry classifier and failure-kind detector match on. Caller cancellation passes
 * through untouched with the caller's own reason, so Ctrl+C never looks like a provider timeout.
 */

export type StreamTimeouts = {
  /** Headers and the first byte must arrive within this long. Defaults to `DEFAULT_STREAM_TIMEOUTS.ttfbMs`. */
  ttfbMs?: number;
  /** Silence between chunks longer than this aborts. Defaults to `DEFAULT_STREAM_TIMEOUTS.idleMs`. */
  idleMs?: number;
  /** The whole request must complete within this long. Defaults to `DEFAULT_STREAM_TIMEOUTS.totalMs`. */
  totalMs?: number;
};

export const DEFAULT_STREAM_TIMEOUTS = {
  /** Free-tier queues regularly hold a request a minute before the first token. */
  ttfbMs: 120_000,
  /** Slow providers pause between tokens; two silent minutes means stuck, not slow. */
  idleMs: 120_000,
  /** A backstop, not a budget: with idle detection working this should never fire. */
  totalMs: 600_000,
} as const;

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/** Enforces TTFB/idle/total timeouts on every request made through the returned fetch. */
export function fetchWithStreamTimeouts(fetchImpl: typeof fetch, timeouts: StreamTimeouts = {}): typeof fetch {
  const ttfbMs = timeouts.ttfbMs ?? DEFAULT_STREAM_TIMEOUTS.ttfbMs;
  const idleMs = timeouts.idleMs ?? DEFAULT_STREAM_TIMEOUTS.idleMs;
  const totalMs = timeouts.totalMs ?? DEFAULT_STREAM_TIMEOUTS.totalMs;

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const caller = init?.signal;
    // Matches fetch semantics: a pre-aborted signal rejects without touching the network.
    caller?.throwIfAborted();
    const controller = new AbortController();
    let settled = false;
    let failure: unknown;
    // A cooperative source (a real socket) fails its pending read when aborted, but a source
    // that ignores the signal would leave `pull` hanging forever — so every read races the
    // failure signal directly. The noop catch only silences unhandled-rejection warnings; the
    // race below still observes the rejection.
    let notifyFailed: (reason: unknown) => void = () => undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      notifyFailed = reject;
    });
    failed.catch(() => undefined);
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let ttfbTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clear = (): void => {
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(ttfbTimer);
      clearTimeout(idleTimer);
      totalTimer = undefined;
      ttfbTimer = undefined;
      idleTimer = undefined;
      caller?.removeEventListener("abort", onCallerAbort);
    };
    const fail = (reason: unknown): void => {
      if (settled) return;
      failure = reason;
      notifyFailed(reason);
      clear();
      controller.abort(reason);
    };
    const onCallerAbort = (): void => {
      fail(caller?.reason);
    };
    const resetIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(new Error(`Provider connection timed out: no data received for ${seconds(idleMs)} (stream stalled)`));
      }, idleMs);
    };
    caller?.addEventListener("abort", onCallerAbort, { once: true });
    totalTimer = setTimeout(() => {
      fail(new Error(`Provider request timed out after ${seconds(totalMs)} without completing`));
    }, totalMs);
    ttfbTimer = setTimeout(() => {
      fail(new Error(`Provider timed out waiting for response headers (no first byte within ${seconds(ttfbMs)})`));
    }, ttfbMs);

    let response: Response;
    try {
      response = await fetchImpl(input, { ...init, signal: controller.signal });
    } catch (error) {
      clear();
      throw error;
    }
    clearTimeout(ttfbTimer);
    ttfbTimer = undefined;
    if (!response.body) {
      // No body to watch (a HEAD, a 204): nothing left the timers can observe.
      clear();
      return response;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch {
      // Instrumentation must never break a request that would otherwise work.
      clear();
      return response;
    }
    resetIdle();
    const watched = new ReadableStream<Uint8Array>({
      async pull(stream): Promise<void> {
        // A cooperative source (a real socket) stops delivering once aborted, but a source
        // that ignores the signal must not keep feeding a request this wrapper already
        // failed: the consumer would read stale bytes past the timeout it was promised.
        if (settled) {
          stream.error(failure ?? new Error("Provider request was aborted"));
          return;
        }
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await Promise.race([reader.read(), failed]);
        } catch (error) {
          // A read that fails because this wrapper aborted carries the descriptive timeout
          // error; any other failure is the provider's own and passes through untouched.
          clear();
          stream.error(error);
          return;
        }
        if (next.done) {
          clear();
          stream.close();
          return;
        }
        resetIdle();
        stream.enqueue(next.value);
      },
      async cancel(reason): Promise<void> {
        clear();
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
