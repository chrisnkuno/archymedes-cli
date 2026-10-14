import { describe, expect, it } from "vitest";
import { analyzeSession, parseSession } from "./analyze-session";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 12, 0, 0) + Math.round(seconds * 1000)).toISOString();
const line = (seconds: number, event: Record<string, unknown>) => JSON.stringify({ at: at(seconds), ...event });

describe("analyzeSession", () => {
  const session = [
    line(0, { type: "turn_start" }),
    line(0.3, { type: "checkpoint" }),
    line(1, { type: "text", text: "I will" }),
    line(5, { type: "model_turn", usage: { inputTokens: 1000, outputTokens: 80, reasoningTokens: 50 }, effort: "low" }),
    line(5.01, { type: "tool_call", toolCallId: "a", tool: "run_command" }),
    line(5.51, { type: "tool_result", toolCallId: "a", tool: "run_command", isError: false }),
    line(9, { type: "model_turn", usage: { inputTokens: 1200, outputTokens: 40, reasoningTokens: 0 }, effort: "minimal" }),
    line(9.5, { type: "model_turn", usage: { inputTokens: 1300, outputTokens: 10, reasoningTokens: 0 } }),
    line(10, { type: "provider_retry", delayMs: 2000 }),
    line(10.2, { type: "runtime_stop" }),
    line(10.9, { type: "turn_end" }),
  ].join("\n");

  it("splits the wall clock into model, tools, and what comes after the answer", () => {
    const b = analyzeSession(parseSession(session));
    expect(b.wallMs).toBe(10_900);
    expect(b.modelCalls).toBe(3);
    expect(b.toolCalls).toBe(1);
    expect(b.toolMs).toBe(500);
    expect(b.afterAnswerMs).toBe(700);
    expect(b.modelMs).toBe(8_990); // 5 s from the start, 3.49 s after the tool result, 0.5 s after the previous reply
    expect(b.retries).toBe(1);
    expect(b.retryWaitMs).toBe(2_000);
  });

  it("counts the checkpoint without ending the first model wait (it runs alongside it)", () => {
    const b = analyzeSession(parseSession(session));
    expect(b.checkpointMs).toBe(300);
    expect(b.firstTokenMs).toBe(1_000);
  });

  it("reports tokens and the effort each call was asked for", () => {
    const b = analyzeSession(parseSession(session));
    expect(b.inputTokens).toBe(3_500);
    expect(b.reasoningTokens).toBe(50);
    expect(b.effortCalls).toEqual({ low: 1, minimal: 1, default: 1 });
  });

  it("tolerates a partial last line and a session that never ended", () => {
    expect(parseSession(`${line(0, { type: "turn_start" })}\n{"type":"mod`)).toHaveLength(1);
    expect(analyzeSession(parseSession(line(0, { type: "turn_start" }))).wallMs).toBe(0);
  });
});
