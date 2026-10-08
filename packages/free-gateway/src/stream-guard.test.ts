import { describe, expect, it, vi } from "vitest";
import { parseFreeOpenRouterModels, type FreeModel } from "@archymedes/core/providers/free-catalog";
import { createFreeGateway } from "./handler";
import { MemoryCounterStore } from "./rate-limit";

const entry = { id: "lab/code:free", name: "Code", context_length: 65536, top_provider: { max_completion_tokens: 2048 },
  pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"] };
const models = new Map(parseFreeOpenRouterModels({ data: [entry] }).map((model): [string, FreeModel] => [model.id, model]));
const encoder = new TextEncoder();

/** An upstream body that sends `chunks` with `gapMs` between them, then (unless `close`) stalls forever. */
function upstreamBody(chunks: string[], gapMs: number, close: boolean, state: { cancelled: boolean }) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
        controller.enqueue(encoder.encode(chunks[index++]));
        return;
      }
      if (close) { controller.close(); return; }
      await new Promise(() => undefined); // stalled: never answers again
    },
    cancel() { state.cancelled = true; },
  });
}

function gateway(response: (init?: RequestInit) => Response, idleMs: number) {
  const signals: AbortSignal[] = [];
  const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return response(init);
  });
  const handler = createFreeGateway({ apiKey: "sk", store: new MemoryCounterStore(), rules: [], tokenRules: [],
    catalog: async () => models, salt: "s", fetchImpl: upstream as unknown as typeof fetch, upstreamIdleTimeoutMs: idleMs });
  const post = (stream = true) => handler(new Request("https://gw.test/v1/chat/completions", { method: "POST",
    body: JSON.stringify({ model: entry.id, messages: [{ role: "user", content: "hi" }], stream }) }), "1.2.3.4");
  return { post, signals };
}

describe("upstream idle timeout", () => {
  it("aborts a stalled stream and ends the client stream with an SSE error event", async () => {
    const state = { cancelled: false };
    const { post, signals } = gateway(() => new Response(upstreamBody(['data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'], 0, false, state),
      { status: 200, headers: { "content-type": "text/event-stream" } }), 50);
    const response = await post();
    expect(response.status).toBe(200);
    const text = await response.text(); // completes: the stream is closed, not left hanging
    expect(text).toContain('"content":"hel"');
    const last = text.trim().split("\n\n").at(-1)!;
    const event = JSON.parse(last.replace(/^data:\s*/, "")) as { error: { code: number; type: string; retryable: boolean; message: string } };
    expect(event.error).toMatchObject({ code: 504, type: "upstream_idle_timeout", retryable: true });
    expect(event.error.message).toContain("stopped sending data");
    expect(signals[0]?.aborted).toBe(true);
    expect(state.cancelled).toBe(true);
  });

  it("answers a stalled non-streamed reply with a JSON 504 clients can fail over on", async () => {
    const state = { cancelled: false };
    const { post } = gateway(() => new Response(upstreamBody(['{"choices":'], 0, false, state),
      { status: 200, headers: { "content-type": "application/json" } }), 50);
    const response = await post(false);
    expect(response.status).toBe(504);
    expect(response.headers.get("x-free-gateway-error")).toBeNull(); // model-specific: another model may work
    expect(await response.json()).toMatchObject({ error: { code: 504, type: "upstream_idle_timeout" } });
  });

  it("does not cut a slow stream whose gaps stay under the idle timeout", async () => {
    const state = { cancelled: false };
    const chunks = Array.from({ length: 5 }, (_, index) => `data: {"choices":[{"delta":{"content":"${index}"}}]}\n\n`);
    const { post, signals } = gateway(() => new Response(upstreamBody(chunks, 30, true, state),
      { status: 200, headers: { "content-type": "text/event-stream" } }), 80);
    const response = await post();
    const text = await response.text();
    expect(text).toBe(chunks.join(""));
    expect(signals[0]?.aborted).toBe(false);
  });

  it("forwards chunks as they arrive instead of buffering the stream", async () => {
    const state = { cancelled: false };
    const { post } = gateway(() => new Response(upstreamBody(["data: {\"a\":1}\n\n", "data: {\"b\":2}\n\n"], 10_000, true, state),
      { status: 200, headers: { "content-type": "text/event-stream" } }), 60_000);
    const response = await post();
    const reader = response.body!.getReader();
    const first = await reader.read(); // arrives long before the second chunk exists
    expect(new TextDecoder().decode(first.value)).toBe("data: {\"a\":1}\n\n");
    await reader.cancel();
    // A client that goes away cancels the upstream read through the pipe.
    await vi.waitFor(() => expect(state.cancelled).toBe(true));
  });

  it("names the first-byte timeout so clients can fail over", async () => {
    const handler = createFreeGateway({ apiKey: "sk", store: new MemoryCounterStore(), rules: [], tokenRules: [],
      catalog: async () => models, salt: "s", upstreamTimeoutMs: 30,
      fetchImpl: ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as unknown as typeof fetch });
    const response = await handler(new Request("https://gw.test/v1/chat/completions", { method: "POST",
      body: JSON.stringify({ model: entry.id, messages: [{ role: "user", content: "hi" }], stream: true }) }), "1.2.3.4");
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: 504, type: "upstream_timeout" } });
  });
});
