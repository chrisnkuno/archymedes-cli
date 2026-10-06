import { beforeEach, describe, expect, it } from "vitest";
import { configureRendering, renderEvent } from "./transcript";

/**
 * The transcript's event rows, pinned without standing up a terminal.
 *
 * Rendering is module-stateful (markdown streaming, tool lines), so each case
 * reconfigures first — otherwise a half-streamed line from one case leaks into the next.
 */

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (chunk: unknown) => boolean) = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as never;
  return {
    writes,
    restore: () => {
      process.stdout.write = original as typeof process.stdout.write;
    },
  };
}

describe("renderEvent", () => {
  beforeEach(() => configureRendering("none", true));

  it("prints a checkpoint line naming a short prefix of the tree", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "checkpoint", checkpoint: { tree: "abcdef1234567890", label: "before", createdAt: 0, turnId: "t1", messageCount: 0 } });
    restore();
    expect(writes.join("")).toContain("checkpoint abcdef12");
  });

  it("reports a compaction with the before and after message counts", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "compaction", tokensBefore: 0, messagesBefore: 40, messagesAfter: 6 });
    restore();
    expect(writes.join("")).toContain("compacted context (40 → 6 messages)");
  });

  it("shows why a provider request is retrying and the bounded attempt count", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "runtime", event: { type: "provider_retry", iteration: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 100, reason: "rate_limit" } });
    restore();
    expect(writes.join("")).toContain("rate limited");
    expect(writes.join("")).toContain("2/3");
    expect(writes.join("")).toContain("100ms");
  });

  it("prints a jev verdict with its outcome and probabilities, quietly", () => {
    const { writes, restore } = captureStdout();
    renderEvent({
      type: "jev-verdict",
      verdict: {
        status: "verdict", model: "jev-1.13.0", outcome: "follow_up",
        outcomeProbabilities: { complete: 0.1, follow_up: 0.78, blocked: 0.12 },
        sensitiveAction: 0.05, usage: { inputTokens: 10, outputTokens: 5 },
      },
    });
    restore();
    const text = writes.join("");
    expect(text).toContain("jev: follow_up");
    expect(text).toContain("0.78");
    expect(text).toContain("0.05");
  });

  it("warns when the judge calls the turn blocked instead of printing it quietly", () => {
    const { writes, restore } = captureStdout();
    renderEvent({
      type: "jev-verdict",
      verdict: {
        status: "verdict", model: "jev-1.13.0", outcome: "blocked",
        outcomeProbabilities: { complete: 0.05, follow_up: 0.2, blocked: 0.75 },
        sensitiveAction: 0.4, usage: { inputTokens: 10, outputTokens: 5 },
      },
    });
    restore();
    const text = writes.join("");
    expect(text).toContain("jev: blocked");
    expect(text).toContain("/undo");
  });

  it("admits a missing jev verdict instead of printing nothing", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "jev-verdict", verdict: { status: "unavailable", reason: "Jev returned HTTP 503" } });
    restore();
    expect(writes.join("")).toContain("jev verdict unavailable");
  });
});
