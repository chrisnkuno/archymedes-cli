/**
 * Token accounting for free mode.
 *
 * Request limits are charged up front, but a request's token usage is only
 * known once the model has answered — so the daily token gate is the count
 * before a request is sent, and the usage the upstream actually reports is
 * charged afterwards, exactly once, from the response stream. Nothing here
 * ever estimates: a response without a usage report charges nothing.
 */
import { counterKey, type CounterStore, type Identities, type RateRule } from "./rate-limit";

export type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The usage of one parsed SSE event or JSON body, or undefined when the
 * payload carries no usage object. Input and output are both read because
 * the total is what is charged; a body that reports neither is not usage.
 */
export function extractUsage(payload: unknown): TokenUsage | undefined {
  if (!isRecord(payload)) return undefined;
  const usage = payload.usage;
  if (!isRecord(usage)) return undefined;
  const input = tokens(usage.prompt_tokens) ?? tokens(usage.input_tokens);
  const output = tokens(usage.completion_tokens) ?? tokens(usage.output_tokens);
  const total = tokens(usage.total_tokens);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0, totalTokens: total ?? (input ?? 0) + (output ?? 0) };
}

/** The usage carried by one SSE `data:` line, if that line is an event with usage. */
export function usageFromSseLine(line: string): TokenUsage | undefined {
  const match = /^data:\s*(.*)$/.exec(line.trimStart());
  if (!match) return undefined;
  const text = match[1].trim();
  if (!text || text === "[DONE]") return undefined;
  try {
    return extractUsage(JSON.parse(text));
  } catch {
    return undefined; // A malformed event is not usage; the stream still flows.
  }
}

/**
 * How much of a daily token allowance is left for one identity, read before a
 * request is sent. Returns undefined when the store is unreachable — the
 * caller must fail closed rather than guess.
 */
export async function tokenAllowance(
  store: CounterStore,
  rules: readonly RateRule[],
  identity: string | Identities,
  now: number,
): Promise<{ rule: RateRule; used: number; remaining: number; resetAtMs: number; exhausted: boolean; warning: boolean } | undefined> {
  let tightest: { rule: RateRule; used: number; remaining: number; resetAtMs: number; exhausted: boolean; warning: boolean } | undefined;
  for (const rule of rules) {
    const window = Math.floor(now / rule.windowMs);
    const key = counterKey(rule, identity, window);
    if (key === undefined) continue;
    const used = await store.get(key);
    const counted = used ?? 0;
    const state = {
      rule,
      used: counted,
      remaining: Math.max(0, rule.limit - counted),
      resetAtMs: (window + 1) * rule.windowMs,
      exhausted: counted >= rule.limit,
      warning: counted >= rule.limit * 0.8,
    };
    if (!tightest || state.remaining / rule.limit < tightest.remaining / tightest.rule.limit) tightest = state;
  }
  return tightest;
}

/**
 * Charges measured usage to every token rule. Atomic per counter, so
 * concurrent requests can never lose or double-count each other's usage.
 */
export async function chargeTokens(
  store: CounterStore,
  rules: readonly RateRule[],
  identity: string | Identities,
  now: number,
  usage: TokenUsage,
): Promise<void> {
  if (usage.totalTokens <= 0) return;
  for (const rule of rules) {
    const window = Math.floor(now / rule.windowMs);
    const key = counterKey(rule, identity, window);
    if (key !== undefined) await store.add(key, usage.totalTokens, rule.windowMs);
  }
}

/**
 * Wraps an upstream response so the usage its stream reports is handed to
 * `onUsage` exactly once, while every original byte is forwarded untouched.
 *
 * OpenAI-compatible streams report usage in one final event; some providers
 * report a running total on every chunk. Only the growth beyond what has
 * already been charged is new usage, so a repeated or duplicate event never
 * charges twice, and a stream that ends without usage charges nothing.
 */
export async function trackUsage(upstream: Response, onUsage: (usage: TokenUsage) => void): Promise<Response> {
  const headers = upstream.headers;
  const extra: Record<string, string> = {};
  for (const [name, value] of headers.entries()) extra[name] = value;
  if (!upstream.body) return new Response(null, { status: upstream.status, headers });
  if (!(headers.get("content-type") ?? "").includes("text/event-stream")) {
    // Not a stream: usage rides in the JSON body, which is read whole and
    // forwarded verbatim so the client sees exactly what the model sent.
    const body = await upstream.text();
    let usage: TokenUsage | undefined;
    try {
      usage = extractUsage(JSON.parse(body) as unknown);
    } catch {
      usage = undefined; // Not JSON, or not a chat response: nothing to charge.
    }
    if (usage) onUsage(usage);
    return new Response(body, { status: upstream.status, headers });
  }
  let chargedTotal = 0;
  let buffer = "";
  const decoder = new TextDecoder();
  const charge = (usage: TokenUsage) => {
    if (usage.totalTokens <= chargedTotal) return; // A repeat or stale event: already charged.
    const delta = usage.totalTokens - chargedTotal;
    const first = chargedTotal === 0;
    chargedTotal = usage.totalTokens;
    // Only the total is attributable on a running total; the first event carries
    // the full input/output split the upstream reported.
    onUsage(first ? usage : { inputTokens: 0, outputTokens: 0, totalTokens: delta });
  };
  const stream = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const usage = usageFromSseLine(line);
        if (usage) charge(usage);
        newline = buffer.indexOf("\n");
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (buffer) {
        const usage = usageFromSseLine(buffer);
        buffer = "";
        if (usage) charge(usage);
      }
    },
  }));
  return new Response(stream, { status: upstream.status, headers });
}
