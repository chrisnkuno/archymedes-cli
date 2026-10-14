/**
 * Where a real session's wall time went, from the JSONL that `archymedes --json` writes.
 *
 *   bun run benchmarks/speed/analyze-session.ts <session.jsonl> [more.jsonl ...]
 *
 * The event stream is timestamped at emission, so the split needs no instrumentation:
 * - a `model_turn` is emitted when its response is complete, so the time since the previous boundary
 *   (turn start, checkpoint, last tool result, a retry) is that model call; the first `text` event
 *   after the boundary marks time-to-first-token;
 * - a `tool_call` to its `tool_result` is the tool;
 * - `turn_start` to `checkpoint` is the pre-turn snapshot (it overlaps the first model call);
 * - `runtime_stop` to `turn_end` is what happens after the answer is done (the Jev verdict).
 * Everything left over is "other", which is where unexplained overhead shows up.
 */

export type SessionEvent = { type: string; at: string; tool?: string; toolCallId?: string; delayMs?: number; [key: string]: unknown };

export type Breakdown = {
  wallMs: number;
  modelMs: number;
  /** Sum of waits before the first token of each model call. */
  firstTokenMs: number;
  modelCalls: number;
  toolMs: number;
  toolCalls: number;
  toolsByName: Record<string, { calls: number; ms: number }>;
  checkpointMs: number;
  /** Time between the agent finishing and the turn closing: verdicts and bookkeeping. */
  afterAnswerMs: number;
  retryWaitMs: number;
  retries: number;
  otherMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Output tokens per second over the part of each call after the first token. */
  tokensPerSecond: number;
  /** Model calls by the effort they were asked to think at ("default" when none was set). */
  effortCalls: Record<string, number>;
};

const ms = (event: SessionEvent): number => Date.parse(event.at);

export function parseSession(text: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as SessionEvent;
      if (typeof parsed.type === "string" && typeof parsed.at === "string" && !Number.isNaN(Date.parse(parsed.at))) events.push(parsed);
    } catch { /* a partial last line is not an error */ }
  }
  return events;
}

export function analyzeSession(events: readonly SessionEvent[]): Breakdown {
  const out: Breakdown = {
    wallMs: 0, modelMs: 0, firstTokenMs: 0, modelCalls: 0, toolMs: 0, toolCalls: 0, toolsByName: {},
    checkpointMs: 0, afterAnswerMs: 0, retryWaitMs: 0, retries: 0, otherMs: 0,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, tokensPerSecond: 0, effortCalls: {},
  };
  let generationMs = 0;
  const start = events.find((event) => event.type === "turn_start");
  const end = [...events].reverse().find((event) => event.type === "turn_end");
  if (!start || !end) return out;
  out.wallMs = ms(end) - ms(start);

  let boundary = ms(start);
  let firstText: number | undefined;
  const openTools = new Map<string, { at: number; name: string }>();
  let stopAt: number | undefined;

  for (const event of events) {
    const at = ms(event);
    if (at < ms(start)) continue;
    switch (event.type) {
      case "checkpoint":
        // Taken alongside the first model call since 3.3, so it does not end a model wait: only how
        // long it took is recorded. (Older logs have it strictly first; the model call then simply
        // includes it, which overstates the model by the checkpoint's few hundred ms.)
        out.checkpointMs = at - ms(start);
        break;
      case "text":
        firstText ??= at;
        break;
      case "provider_retry":
        out.retries += 1;
        out.retryWaitMs += Number(event.delayMs ?? 0);
        break;
      case "model_turn":
        out.modelCalls += 1;
        {
          const effort = typeof event.effort === "string" ? event.effort : "default";
          out.effortCalls[effort] = (out.effortCalls[effort] ?? 0) + 1;
        }
        out.modelMs += at - boundary;
        if (firstText !== undefined) {
          out.firstTokenMs += firstText - boundary;
          generationMs += at - firstText;
        }
        {
          const usage = event.usage as { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | undefined;
          out.inputTokens += usage?.inputTokens ?? 0;
          out.outputTokens += usage?.outputTokens ?? 0;
          out.reasoningTokens += usage?.reasoningTokens ?? 0;
        }
        boundary = at;
        firstText = undefined;
        break;
      case "tool_call":
        openTools.set(String(event.toolCallId), { at, name: String(event.tool ?? "?") });
        break;
      case "tool_result": {
        const call = openTools.get(String(event.toolCallId));
        if (!call) break;
        openTools.delete(String(event.toolCallId));
        const took = at - call.at;
        out.toolMs += took;
        out.toolCalls += 1;
        const row = (out.toolsByName[call.name] ??= { calls: 0, ms: 0 });
        row.calls += 1;
        row.ms += took;
        boundary = Math.max(boundary, at);
        break;
      }
      case "runtime_stop":
        stopAt = at;
        break;
      case "turn_end":
        if (stopAt !== undefined) out.afterAnswerMs += at - stopAt;
        break;
    }
  }
  // Tools run concurrently (parallel-safe batches), so their summed time can exceed the wall clock;
  // "other" is only the part of the wall clock nothing above claims.
  out.tokensPerSecond = generationMs > 0 ? (out.outputTokens / generationMs) * 1000 : 0;
  out.otherMs = Math.max(0, out.wallMs - out.modelMs - out.toolMs - out.afterAnswerMs);
  return out;
}

const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(0)}%`.padStart(4) : "   -");
const sec = (value: number) => `${(value / 1000).toFixed(2)}s`.padStart(8);

export function formatBreakdown(label: string, b: Breakdown): string {
  const rows: Array<[string, number, string]> = [
    ["model (incl. generation)", b.modelMs, `${b.modelCalls} calls, ${b.modelCalls ? Math.round(b.modelMs / b.modelCalls) : 0} ms avg, ${b.modelCalls ? Math.round(b.firstTokenMs / b.modelCalls) : 0} ms to first token`],
    ["tools", b.toolMs, `${b.toolCalls} calls, ${b.toolCalls ? Math.round(b.toolMs / b.toolCalls) : 0} ms avg`],
    ["pre-turn checkpoint", b.checkpointMs, "overlaps the first model call; not on the critical path"],
    ["after the answer", b.afterAnswerMs, "verdicts and bookkeeping"],
    ["other", b.otherMs, "unexplained: look here first"],
  ];
  const lines = [`${label}  wall ${sec(b.wallMs).trim()}  (retries: ${b.retries}, asked to wait ${sec(b.retryWaitMs).trim()})`];
  for (const [name, value, note] of rows) lines.push(`  ${name.padEnd(26)} ${sec(value)} ${pct(value, b.wallMs)}  ${note}`);
  lines.push(`  tokens: ${b.inputTokens} in (${b.modelCalls ? Math.round(b.inputTokens / b.modelCalls) : 0}/call), ${b.outputTokens} out (${b.reasoningTokens} reasoning), ${b.tokensPerSecond.toFixed(0)} tok/s while streaming`);
  if (Object.keys(b.effortCalls).length > 0) lines.push(`  effort: ${Object.entries(b.effortCalls).map(([name, count]) => `${name} x${count}`).join(", ")}`);
  const slow = Object.entries(b.toolsByName).sort((a, c) => c[1].ms - a[1].ms).slice(0, 4);
  if (slow.length > 0) lines.push(`  slowest tools: ${slow.map(([name, row]) => `${name} ${row.ms}ms/${row.calls}`).join(", ")}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const { readFileSync } = await import("node:fs");
  for (const file of process.argv.slice(2)) console.log(formatBreakdown(file.split("/").pop() ?? file, analyzeSession(parseSession(readFileSync(file, "utf8")))) + "\n");
}
