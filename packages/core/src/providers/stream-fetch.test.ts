import { describe, expect, it } from "vitest";
import { DEFAULT_STREAM_TIMEOUTS, fetchWithStreamTimeouts } from "./stream-fetch";

function streamOf(chunks: string[], delaysMs: number[] = []): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let index = 0; index < chunks.length; index += 1) {
        const wait = delaysMs[index] ?? 0;
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        controller.enqueue(encoder.encode(chunks[index]));
      }
      controller.close();
    },
  });
}

async function textOf(response: Response): Promise<string> {
  return new TextDecoder().decode((await response.arrayBuffer()) as ArrayBuffer);
}

describe("streaming fetch timeouts", () => {
  it("passes status, headers and bytes through untouched on a healthy stream", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(String(input));
      void init;
      return new Response(streamOf(["hello ", "world"]), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const response = await fetchWithStreamTimeouts(fetchImpl)( "https://provider.test/v1/chat", {});
    expect(seen).toEqual(["https://provider.test/v1/chat"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await textOf(response)).toBe("hello world");
  });

  it("aborts when response headers never arrive", async () => {
    const fetchImpl = ((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
    const failing = fetchWithStreamTimeouts(fetchImpl, { ttfbMs: 40, idleMs: 1_000, totalMs: 5_000 });
    const error = await failing("https://provider.test/v1/chat", {}).catch((error: unknown) => error);
    expect(String((error as Error)?.message ?? error)).toContain("timed out waiting for response headers");
  });

  it("aborts a stream that stalls mid-response", async () => {
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        // Never closes: the connection is stuck open with nothing more to say.
      },
    });
    const fetchImpl = (async () => new Response(hanging, { status: 200 })) as typeof fetch;
    const failing = fetchWithStreamTimeouts(fetchImpl, { ttfbMs: 1_000, idleMs: 40, totalMs: 5_000 });
    const response = await failing("https://provider.test/v1/chat", {});
    const error = await textOf(response).then(() => null, (error: unknown) => error);
    expect(String((error as Error)?.message ?? error)).toContain("stream stalled");
  });

  it("does not mistake a slow-but-alive stream for a stall", async () => {
    const fetchImpl = (async () => new Response(streamOf(["a", "b", "c"], [30, 30, 30]), { status: 200 })) as typeof fetch;
    const response = await fetchWithStreamTimeouts(fetchImpl, { ttfbMs: 1_000, idleMs: 100, totalMs: 5_000 })("https://provider.test/v1/chat", {});
    expect(await textOf(response)).toBe("abc");
  });

  it("bounds a trickling stream with the total timeout", async () => {
    const fetchImpl = (async () => new Response(streamOf(["a", "b", "c", "d"], [30, 30, 30, 30]), { status: 200 })) as typeof fetch;
    const response = await fetchWithStreamTimeouts(fetchImpl, { ttfbMs: 1_000, idleMs: 1_000, totalMs: 50 })("https://provider.test/v1/chat", {});
    const error = await textOf(response).then(() => null, (error: unknown) => error);
    expect(String((error as Error)?.message ?? error)).toContain("timed out after");
  });

  it("propagates caller cancellation with the caller's reason", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
    const pending = fetchWithStreamTimeouts(fetchImpl)("https://provider.test/v1/chat", { signal: controller.signal });
    controller.abort(new Error("user pressed ctrl-c"));
    const error = await pending.then(() => null, (error: unknown) => error);
    expect(String((error as Error)?.message ?? error)).toContain("user pressed ctrl-c");
  });

  it("rejects immediately when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("ok"); }) as typeof fetch;
    const error = await fetchWithStreamTimeouts(fetchImpl)("https://provider.test/v1/chat", { signal: controller.signal }).then(() => null, (error: unknown) => error);
    expect(String((error as Error)?.message ?? error)).toContain("already gone");
    expect(called).toBe(false);
  });

  it("ships generous production defaults", () => {
    expect(DEFAULT_STREAM_TIMEOUTS.ttfbMs).toBeGreaterThanOrEqual(60_000);
    expect(DEFAULT_STREAM_TIMEOUTS.idleMs).toBeGreaterThanOrEqual(60_000);
    expect(DEFAULT_STREAM_TIMEOUTS.totalMs).toBeGreaterThan(DEFAULT_STREAM_TIMEOUTS.idleMs);
  });
});
