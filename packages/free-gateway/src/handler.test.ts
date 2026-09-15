import { describe, expect, it, vi } from "vitest";
import { mergeFreeCatalog, parseFreeOpenRouterModels, type FreeModel } from "@archymedes/core/providers/free-catalog";
import { createFreeGateway, type GatewayConfig } from "./handler";
import { MemoryCounterStore, type RateRule } from "./rate-limit";

const entry = { id: "lab/code:free", name: "Code", context_length: 65536, top_provider: { max_completion_tokens: 2048 },
  pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"] };
const models = new Map(parseFreeOpenRouterModels({ data: [entry] }).map((model): [string, FreeModel] => [model.id, model]));
const chat = { model: entry.id, messages: [{ role: "user", content: "hi" }], max_tokens: 999_999, stream: true,
  tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  provider: { max_price: { prompt: 5 }, allow_fallbacks: true }, models: ["paid/model"], plugins: [{ id: "web" }] };
const lenient: RateRule[] = [{ name: "ip-minute", scope: "ip", windowMs: 60_000, limit: 100 }];

function gateway(overrides: Partial<GatewayConfig> = {}) {
  const upstream = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response("data: {\"choices\":[]}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
  const handler = createFreeGateway({ apiKey: "sk-or-operator-secret", store: new MemoryCounterStore(), rules: lenient,
    catalog: async () => models, salt: "s", fetchImpl: upstream as unknown as typeof fetch, now: () => 1_000, ...overrides });
  const post = (body: unknown, ip = "1.2.3.4") => handler(new Request("https://gw.test/v1/chat/completions", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), ip);
  return { handler, upstream, post };
}

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
    const { post, upstream } = gateway({ store: { increment: async () => { throw new Error("down"); } } });
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
});
