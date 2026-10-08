import { describe, expect, it } from "vitest";
import { MemoryCounterStore } from "./rate-limit";
import { chargeTokens, extractUsage, tokenAllowance, trackUsage, usageFromSseLine, type TokenUsage } from "./usage";

const DAY = 24 * 60 * 60_000;
const tokenRule = { name: "ip-token-day", scope: "ip" as const, windowMs: DAY, limit: 100_000 };

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const usageEvent = (input: number, output: number, total: number) =>
  `data: {"choices":[],"usage":{"prompt_tokens":${input},"completion_tokens":${output},"total_tokens":${total}}}\n\n`;

describe("usage extraction", () => {
  it("reads input, output and total from an OpenRouter usage object", () => {
    expect(extractUsage({ usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }))
      .toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    expect(extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } }))
      .toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(extractUsage({ usage: { total_tokens: 7 } })).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 7 });
  });

  it("reports no usage for payloads without one, and never invents a count", () => {
    expect(extractUsage({ choices: [] })).toBeUndefined();
    expect(extractUsage({ usage: {} })).toBeUndefined();
    expect(extractUsage({ usage: { prompt_tokens: "many" } })).toBeUndefined();
    expect(extractUsage(null)).toBeUndefined();
    expect(extractUsage("text")).toBeUndefined();
    expect(usageFromSseLine("data: {\"choices\":[]}")).toBeUndefined();
    expect(usageFromSseLine("data: [DONE]")).toBeUndefined();
    expect(usageFromSseLine("event: message")).toBeUndefined();
    expect(usageFromSseLine("data: {not json")).toBeUndefined();
    expect(usageFromSseLine("not a data line")).toBeUndefined();
  });

  it("reads usage from an SSE data line", () => {
    expect(usageFromSseLine(`data: {"usage":{"total_tokens":42}}`)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 42 });
    expect(usageFromSseLine(`  data: {"usage":{"total_tokens":42}}`)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 42 });
  });
});

describe("token allowance and charging", () => {
  it("counts charged usage and reports what is left of the day", async () => {
    const store = new MemoryCounterStore();
    const identity = "client";
    const now = Date.UTC(2026, 9, 6, 12);
    const before = await tokenAllowance(store, [tokenRule], identity, now);
    expect(before).toMatchObject({ used: 0, remaining: 100_000, exhausted: false, warning: false });
    expect(before?.resetAtMs).toBe(Date.UTC(2026, 9, 7)); // the next UTC midnight
    await chargeTokens(store, [tokenRule], identity, now, { inputTokens: 90_000, outputTokens: 10_000, totalTokens: 100_000 });
    const after = await tokenAllowance(store, [tokenRule], identity, now);
    expect(after).toMatchObject({ used: 100_000, remaining: 0, exhausted: true, warning: true });
    // A read never charges: the count is unchanged by looking at it.
    expect((await tokenAllowance(store, [tokenRule], identity, now))?.used).toBe(100_000);
  });

  it("warns at eighty percent and separates identities and windows", async () => {
    const store = new MemoryCounterStore();
    const now = Date.UTC(2026, 9, 6, 12);
    await chargeTokens(store, [tokenRule], "client", now, { inputTokens: 0, outputTokens: 0, totalTokens: 80_000 });
    expect((await tokenAllowance(store, [tokenRule], "client", now))?.warning).toBe(true);
    expect((await tokenAllowance(store, [tokenRule], "other", now))?.warning).toBe(false);
    // A new UTC day is a fresh allowance.
    const nextDay = Date.UTC(2026, 9, 7, 0, 0, 1);
    expect((await tokenAllowance(store, [tokenRule], "client", nextDay))?.used).toBe(0);
  });

  it("charges nothing for zero-token usage", async () => {
    const store = new MemoryCounterStore();
    await chargeTokens(store, [tokenRule], "client", Date.UTC(2026, 9, 6), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect((await tokenAllowance(store, [tokenRule], "client", Date.UTC(2026, 9, 6)))?.used).toBe(0);
  });
});

describe("stream usage tracking", () => {
  it("forwards the stream untouched and charges the usage it reports, once", async () => {
    const charged: TokenUsage[] = [];
    const tracked = await trackUsage(sse([
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`,
      usageEvent(120, 30, 150),
    ]), (usage) => charged.push(usage));
    expect(await tracked.text()).toBe(`data: {"choices":[{"delta":{"content":"hi"}}]}\n\n` + usageEvent(120, 30, 150));
    expect(charged).toEqual([{ inputTokens: 120, outputTokens: 30, totalTokens: 150 }]);
  });

  it("charges usage split across chunk boundaries", async () => {
    const charged: TokenUsage[] = [];
    const event = usageEvent(100, 50, 150);
    const tracked = await trackUsage(sse([event.slice(0, 20), event.slice(20)]), (usage) => charged.push(usage));
    await tracked.text();
    expect(charged).toEqual([{ inputTokens: 100, outputTokens: 50, totalTokens: 150 }]);
  });

  it("charges nothing when the stream reports no usage, even if it ends", async () => {
    const charged: TokenUsage[] = [];
    const tracked = await trackUsage(sse([`data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`, "data: [DONE]\n\n"]), (usage) => charged.push(usage));
    expect(await tracked.text()).toContain("hi");
    expect(charged).toEqual([]);
  });

  it("never charges twice for a repeated usage event", async () => {
    const charged: TokenUsage[] = [];
    const tracked = await trackUsage(sse([usageEvent(10, 5, 15), usageEvent(10, 5, 15)]), (usage) => charged.push(usage));
    await tracked.text();
    expect(charged).toEqual([{ inputTokens: 10, outputTokens: 5, totalTokens: 15 }]);
  });

  it("charges only the growth of a running total, so cumulative streams pay exactly once", async () => {
    const charged: TokenUsage[] = [];
    const tracked = await trackUsage(sse([usageEvent(100, 0, 100), usageEvent(100, 20, 120), usageEvent(100, 60, 160)]), (usage) => charged.push(usage));
    await tracked.text();
    expect(charged).toEqual([{ inputTokens: 100, outputTokens: 0, totalTokens: 100 }, { inputTokens: 0, outputTokens: 0, totalTokens: 20 }, { inputTokens: 0, outputTokens: 0, totalTokens: 40 }]);
    expect(charged.reduce((sum, usage) => sum + usage.totalTokens, 0)).toBe(160);
  });

  it("charges usage that arrives on the last line without a trailing newline", async () => {
    const charged: TokenUsage[] = [];
    const tracked = await trackUsage(sse(["data: {\"choices\":[]}\n\n", `data: {"usage":{"total_tokens":9}}`]), (usage) => charged.push(usage));
    await tracked.text();
    expect(charged).toEqual([{ inputTokens: 0, outputTokens: 0, totalTokens: 9 }]);
  });

  it("charges the usage of a non-streaming JSON response and forwards it verbatim", async () => {
    const charged: TokenUsage[] = [];
    const body = JSON.stringify({ id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
    const tracked = await trackUsage(new Response(body, { status: 200, headers: { "content-type": "application/json" } }), (usage) => charged.push(usage));
    expect(await tracked.text()).toBe(body);
    expect(charged).toEqual([{ inputTokens: 7, outputTokens: 3, totalTokens: 10 }]);
  });

  it("charges nothing for a non-JSON body that is not a chat response", async () => {
    const charged: TokenUsage[] = [];
    const tracked = await trackUsage(new Response("not json", { status: 200, headers: { "content-type": "application/json" } }), (usage) => charged.push(usage));
    expect(await tracked.text()).toBe("not json");
    expect(charged).toEqual([]);
  });
});
