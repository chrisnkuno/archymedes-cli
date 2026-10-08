/**
 * Idle protection for an upstream body that is already flowing.
 *
 * The first-byte deadline ends once the model starts answering, but a stream can still stall
 * mid-answer. This wrapper forwards every upstream chunk as it arrives (no buffering, no read
 * ahead beyond one chunk) and, if the upstream goes quiet for longer than `idleMs` while the
 * client is waiting for more, aborts the upstream and ends the client stream cleanly: an SSE
 * stream gets one final `data: {"error": ...}` event and a normal close, so OpenAI-compatible
 * clients raise a typed error and can fail over to another model instead of hanging or seeing a
 * truncated socket. A non-SSE body errors instead, so the caller can answer with a JSON 504.
 */

export const IDLE_TIMEOUT_TYPE = "upstream_idle_timeout";
export const STREAM_FAILED_TYPE = "upstream_stream_failed";

export class UpstreamIdleError extends Error {
  constructor(readonly idleMs: number) {
    super(`The model service stopped sending data for ${Math.round(idleMs / 1000)}s.`);
    this.name = "UpstreamIdleError";
  }
}

/** One SSE event carrying an OpenAI-shaped error; `retryable` tells clients another model may work. */
export function sseErrorEvent(message: string, code: number, type: string): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify({ error: { message, code, type, retryable: true } })}\n\n`);
}

export function guardIdle(
  body: ReadableStream<Uint8Array>,
  options: { idleMs: number; sse: boolean; onIdle: () => void },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const stop = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      const idle = new Promise<"idle">((resolve) => { timer = setTimeout(() => resolve("idle"), options.idleMs); });
      try {
        const next = await Promise.race([reader.read(), idle]);
        if (next === "idle") {
          finished = true;
          options.onIdle();
          void reader.cancel().catch(() => undefined);
          const error = new UpstreamIdleError(options.idleMs);
          if (options.sse) {
            controller.enqueue(sseErrorEvent(error.message, 504, IDLE_TIMEOUT_TYPE));
            controller.close();
          } else {
            controller.error(error);
          }
          return;
        }
        if (next.done) { finished = true; controller.close(); return; }
        controller.enqueue(next.value);
      } catch (error) {
        finished = true;
        if (options.sse) {
          // A broken upstream connection mid-stream: end with a clear event, not a cut socket.
          controller.enqueue(sseErrorEvent("The model service connection failed mid-response.", 502, STREAM_FAILED_TYPE));
          controller.close();
        } else {
          controller.error(error);
        }
      } finally {
        stop();
      }
    },
    cancel(reason) {
      finished = true;
      stop();
      return reader.cancel(reason);
    },
  });
}
