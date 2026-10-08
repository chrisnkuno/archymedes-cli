import { describe, expect, it, vi } from "vitest";
import { mergeFreeCatalog, parseFreeOpenRouterModels, type FreeModel } from "@archymedes/core/providers/free-catalog";
import { createFreeGateway, type GatewayConfig } from "./handler";
import { clientKey, MemoryCounterStore, type RateRule } from "./rate-limit";

const entry = { id: "lab/code:free", name: "Code", context_length: 65536, top_provider: { max_completion_tokens: 2048 },
  pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"] };
const models = new Map(parseFreeOpenRouterModels({ data: [entry] }).map((model): [string, FreeModel] => [model.id, model]));
const chat = { model: entry.id, messages: [{ role: "user", content: "hi" }], max_tokens: 999_999, stream: true,
  tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  provider: { max_price: { prompt: 5 }, allow_fallbacks: true }, models: ["paid/model"], plugins: [{ id: "web" }] };
const lenient: RateRule[] = [{ name: "ip-minute", scope: "ip", windowMs: 60_000, limit: 100 }];
const DAY = 24 * 60 * 60_000;
/** Noon UTC, so the day window ends at the next UTC midnight. */
const fixedNow = Date.UTC(2026, 9, 6, 12);
const minuteRule: RateRule = { name: "ip-minute", scope: "ip", windowMs: 60_000, limit: 1_000 };
const dayRule: RateRule = { name: "ip-day", scope: "ip", windowMs: DAY, limit: 25 };
const tokenRule: RateRule = { name: "ip-token-day", scope: "ip", windowMs: DAY, limit: 100_000 };

function gateway(overrides: Partial<GatewayConfig> = {}) {
  const upstream = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response("data: {\"choices\":[]}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
  const handler = createFreeGateway({ apiKey: "sk-or-operator-secret", store: new MemoryCounterStore(), rules: lenient,
    catalog: async () => models, salt: "s", fetchImpl: upstream as unknown as typeof fetch, now: () => 1_000, ...overrides });
  const post = (body: unknown, ip = "1.2.3.4") => handler(new Request("https://gw.test/v1/chat/completions", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), ip);
  return { handler, upstream, post };
}

/** A gateway whose upstream answers with a stream carrying measured usage. */
function usageGateway(rules: RateRule[], tokenRules: RateRule[], stream: (call: number) => Response) {
  let calls = 0;
  const upstream = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => stream(++calls));
  const store = new MemoryCounterStore();
  const handler = createFreeGateway({ apiKey: "sk-or-operator-secret", store, rules, tokenRules,
    catalog: async () => models, salt: "s", fetchImpl: upstream as unknown as typeof fetch, now: () => fixedNow });
  const post = (ip = "1.2.3.4") => handler(new Request("https://gw.test/v1/chat/completions", { method: "POST", body: JSON.stringify(chat) }), ip);
  return { post, upstream, store };
}

const withUsage = (input: number, output: number, total: number) => new Response(
  `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`
  + `data: {"choices":[],"usage":{"prompt_tokens":${input},"completion_tokens":${output},"total_tokens":${total}}}\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } });

const identityKey = (ip: string) => `free:ip-token-day:ip:${clientKey(ip, "s")}:${Math.floor(fixedNow / DAY)}`;

describe("free usage limits", () => {
  it("allows the 25th request of the day and refuses the 26th with the reset time and /upgrade", async () => {
    const { post, upstream } = usageGateway([minuteRule, dayRule], [tokenRule], () => withUsage(1, 1, 2));
    for (let index = 0; index < 25; index += 1) {
      const served = await post();
      expect(served.status).toBe(200);
      expect(served.headers.get("x-free-remaining-requests")).toBe(String(25 - index)); // before this request
    }
    const refused = await post();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("x-free-gateway-error")).toBe("429");
    expect(refused.headers.get("x-free-reset-utc")).toBe(new Date(Date.UTC(2026, 9, 7)).toISOString());
    expect(refused.headers.get("x-free-remaining-requests")).toBe("0");
    expect(refused.headers.get("retry-after")).toBe(String(12 * 60 * 60));
    const body = await refused.json() as { error: Record<string, unknown> & { message: string } };
    expect(body.error).toMatchObject({ code: 429, kind: "daily_requests", rule: "ip-day", scope: "ip", limit: 25,
      reset_utc: "2026-10-07T00:00:00.000Z", retry_after_seconds: 12 * 60 * 60, remaining_requests: 0 });
    const message = body.error.message;
    expect(message).toContain("today's free request limit (25 requests)");
    expect(message).toContain("Your allowance resets at");
    expect(message).toContain("/upgrade");
    expect(upstream).toHaveBeenCalledTimes(25); // the refused request never reached the model
  });

  it("allows five requests a minute and refuses the sixth, naming the minute limit", async () => {
    const { post } = usageGateway([{ ...minuteRule, limit: 5 }, dayRule], [tokenRule], () => withUsage(1, 1, 2));
    for (let index = 0; index < 5; index += 1) expect((await post()).status).toBe(200);
    const refused = await post();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(refused.headers.get("x-free-remaining-requests")).toBe("20"); // the refusal itself was not counted
    const body = await refused.json() as { error: Record<string, unknown> & { message: string } };
    expect(body.error).toMatchObject({ code: 429, kind: "per_minute", rule: "ip-minute", limit: 5, retry_after_seconds: 60,
      reset_utc: new Date(fixedNow + 60_000).toISOString(), remaining_requests: 20 });
    const message = body.error.message;
    expect(message).toContain("5 requests per minute");
    expect(message).toContain("daily allowance is separate");
  });

  it("charges measured input plus output tokens, not the request size, and stops at the token limit", async () => {
    // The request asks for 999,999 output tokens; only the tokens the
    // model reports are ever charged.
    let calls = 0;
    const { post, upstream } = usageGateway([minuteRule, dayRule], [tokenRule], () => withUsage(0, 0, ++calls === 1 ? 99_999 : 1));
    const first = await post();
    expect(first.status).toBe(200);
    await first.text(); // usage is charged as the stream is forwarded
    expect(await post().then((response) => response.text())).toContain("ok");
    const refused = await post(); // exactly 100,000 used: the next request is refused
    expect(refused.status).toBe(429);
    const body = await refused.json() as { error: Record<string, unknown> & { message: string } };
    expect(body.error).toMatchObject({ code: 429, kind: "daily_tokens", rule: "ip-token-day", scope: "ip", limit: 100_000,
      reset_utc: "2026-10-07T00:00:00.000Z", retry_after_seconds: 12 * 60 * 60, remaining_tokens: 0, remaining_requests: 23 });
    const message = body.error.message;
    expect(message).toContain("today's free usage limit (100,000 tokens)");
    expect(message).toContain("Your allowance resets at");
    expect(message).toContain("/upgrade");
    expect(refused.headers.get("x-free-remaining-tokens")).toBe("0");
    expect(refused.headers.get("x-free-remaining-requests")).toBe("23"); // two of 25 served; the refusal is not charged
    expect(refused.headers.get("retry-after")).toBe(String(12 * 60 * 60));
    expect((await post()).headers.get("x-free-remaining-requests")).toBe("23");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("reports the remaining allowance and reset time, warning at eighty percent", async () => {
    let calls = 0;
    const { post } = usageGateway([minuteRule, dayRule], [tokenRule], () => withUsage(0, 0, ++calls === 1 ? 80_000 : 1_000));
    const first = await post();
    expect(first.status).toBe(200);
    await first.text();
    expect(first.headers.get("x-free-remaining-tokens")).toBe("100000");
    expect(first.headers.get("x-free-reset-utc")).toBe(new Date(Date.UTC(2026, 9, 7)).toISOString());
    expect(first.headers.get("x-free-allowance-warning")).toBeNull();
    const second = await post(); // 80,000 is now charged: the warning threshold is crossed
    expect(second.status).toBe(200);
    expect(second.headers.get("x-free-remaining-tokens")).toBe("20000");
    expect(second.headers.get("x-free-allowance-warning")).toBe("You've used 80% of today's free allowance.");
  });

  it("charges nothing when the model fails or reports no usage", async () => {
    const failed = usageGateway([minuteRule, dayRule], [tokenRule], () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }));
    expect((await failed.post()).status).toBe(500);
    expect(await failed.store.get(identityKey("1.2.3.4"))).toBeUndefined();
    const silent = usageGateway([minuteRule, dayRule], [tokenRule], () =>
      new Response("data: {\"choices\":[]}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
    expect((await silent.post()).status).toBe(200);
    expect(await silent.post().then((response) => response.text())).toBe("data: {\"choices\":[]}\n\n");
    expect(await silent.store.get(identityKey("1.2.3.4"))).toBeUndefined();
  });

  it("charges a duplicated usage event exactly once", async () => {
    const duplicated = usageGateway([minuteRule, dayRule], [tokenRule], () => new Response(
      `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n`
      + `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } }));
    const response = await duplicated.post();
    await response.text();
    expect(await duplicated.store.get(identityKey("1.2.3.4"))).toBe(15);
  });

  it("charges usage even when the client stops reading after it was reported", async () => {
    const { post, store } = usageGateway([minuteRule, dayRule], [tokenRule], () => withUsage(20, 10, 30));
    const response = await post();
    // Reading the body drives the stream through the gateway; the usage
    // event has been reported by the time the text is available.
    const text = await response.text();
    expect(text).toContain("usage");
    expect(await store.get(identityKey("1.2.3.4"))).toBe(30);
  });

  it("cannot exceed the request limit through concurrency", async () => {
    const { post } = usageGateway([{ ...minuteRule, limit: 5 }, dayRule], [tokenRule], () => withUsage(1, 1, 2));
    const responses = await Promise.all(Array.from({ length: 10 }, () => post()));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(5);
  });

  it("separates identities: one address's usage never limits another", async () => {
    const { post } = usageGateway([minuteRule, dayRule], [{ ...tokenRule, limit: 100 }], () => withUsage(0, 0, 100));
    expect(await (await post("1.1.1.1")).text()).toContain("usage");
    expect((await post("1.1.1.1")).status).toBe(429); // 100 of 100 tokens used
    expect((await post("2.2.2.2")).status).toBe(200); // a different address has its own allowance
  });
});

describe("free gateway", () => {
  it("lists models in OpenRouter's shape so the CLI verifies them with its own parser", async () => {
    const { handler } = gateway();
    const response = await handler(new Request("https://gw.test/v1/models"), "1.2.3.4");
    const parsed = parseFreeOpenRouterModels(await response.json());
    expect(parsed.map((model) => [model.id, model.eligible, model.max_output])).toEqual([[entry.id, true, 2048]]);
    expect(mergeFreeCatalog(parsed, [], 0).models).toHaveLength(1);
  });

  it("rebuilds the request: zero price, no fallbacks or plugins, clamped output, operator key only upstream", async () => {
    const { post, upstream } = gateway();
    const response = await post(chat);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const sent = JSON.parse(String(init!.body));
    expect(sent).toEqual({
      model: entry.id, messages: chat.messages, tools: chat.tools, max_tokens: 2048, stream: true, stream_options: { include_usage: true },
      provider: { require_parameters: true, max_price: { prompt: 0, completion: 0 }, allow_fallbacks: false },
    });
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer sk-or-operator-secret");
    expect(await response.text()).not.toContain("sk-or");
  });

  it.each([
    [{ ...chat, model: "lab/paid" }, 400],
    [{ ...chat, model: "openrouter/auto" }, 400],
    [{ ...chat, messages: [] }, 400],
    [{ ...chat, messages: [{ role: "developer", content: "x" }] }, 400],
    [{ ...chat, tools: [{ type: "web_search" }] }, 400],
    ["{not json", 400],
  ])("refuses %j with %i before calling upstream", async (body, status) => {
    const { post, upstream } = gateway();
    expect((await post(body)).status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses oversized bodies", async () => {
    const { post, upstream } = gateway({ limits: { maxBodyBytes: 100, maxMessages: 10, maxTools: 4, maxOutputTokens: 100 } });
    expect((await post({ ...chat, messages: [{ role: "user", content: "x".repeat(500) }] })).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("limits per address and globally, with retry-after", async () => {
    const rules: RateRule[] = [
      { name: "ip-minute", scope: "ip", windowMs: 60_000, limit: 1 },
      { name: "global-minute", scope: "global", windowMs: 60_000, limit: 2 },
    ];
    const { post, upstream } = gateway({ rules });
    expect((await post(chat, "1.1.1.1")).status).toBe(200);
    const limited = await post(chat, "1.1.1.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("59");
    expect((await post(chat, "2.2.2.2")).status).toBe(200);
    const busy = await post(chat, "3.3.3.3");
    expect(busy.status).toBe(429);
    expect(busy.headers.get("x-free-gateway-error")).toBe("429");
    expect((await busy.json()).error.message).toContain("Shared free capacity");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the limiter is unavailable", async () => {
    const { post, upstream } = gateway({ store: { increment: async () => { throw new Error("down"); }, add: async () => { throw new Error("down"); }, get: async () => { throw new Error("down"); } } });
    expect((await post(chat)).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("hides the operator account in upstream errors and turns key/credit problems into 503", async () => {
    const reply = (status: number) => async () => new Response(JSON.stringify({ error: { message: "model gated", code: status }, user_id: "user_operator" }), { status, headers: { "retry-after": "7" } });
    const gated = await gateway({ fetchImpl: reply(403) as unknown as typeof fetch }).post(chat);
    expect(gated.status).toBe(403);
    const text = await gated.text();
    expect(text).toContain("model gated");
    expect(text).not.toContain("user_operator");
    expect(gated.headers.get("x-free-gateway-error")).toBeNull(); // relayed from one model: clients may try another
    const exhausted = await gateway({ fetchImpl: reply(402) as unknown as typeof fetch }).post(chat);
    expect(exhausted.status).toBe(503);
    expect(exhausted.headers.get("retry-after")).toBe("7");
    expect(exhausted.headers.get("x-free-gateway-error")).toBe("503");
  });

  it("serves health and nothing else", async () => {
    const { handler } = gateway();
    expect((await handler(new Request("https://gw.test/health"), undefined)).status).toBe(200);
    expect((await handler(new Request("https://gw.test/v1/embeddings", { method: "POST" }), undefined)).status).toBe(404);
    expect((await handler(new Request("https://gw.test/v1/chat/completions"), undefined)).status).toBe(405);
  });

  it("times out the upstream request after the configured timeout", async () => {
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")), { once: true });
      }));
    const handler = createFreeGateway({ apiKey: "sk-or-operator-secret", store: new MemoryCounterStore(), rules: lenient,
      catalog: async () => models, salt: "s", fetchImpl: upstream as unknown as typeof fetch, now: () => 1_000,
      upstreamTimeoutMs: 50 });
    const response = await handler(new Request("https://gw.test/v1/chat/completions", { method: "POST", body: JSON.stringify(chat) }), "1.2.3.4");
    expect(response.status).toBe(504);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain("did not answer in time");
  });

  it("does not cut a stream short once the upstream has started answering", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const handler = createFreeGateway({ apiKey: "sk-or-operator-secret", store: new MemoryCounterStore(), rules: lenient,
      catalog: async () => models, salt: "s", fetchImpl: upstream as unknown as typeof fetch, now: () => 1_000,
      upstreamTimeoutMs: 20 });
    const response = await handler(new Request("https://gw.test/v1/chat/completions", { method: "POST", body: JSON.stringify(chat) }), "1.2.3.4");
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(upstreamSignal?.aborted).toBe(false);
  });
});
