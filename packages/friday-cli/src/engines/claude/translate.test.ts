import { describe, expect, it } from "vitest";
import type { ArchymedesEvent } from "@archymedes/core/cli/agent";
import type { SdkMessage } from "./sdk";
import { ClaudeTranslator, editDiff, MAX_RESULT_CHARS, modelUsage, resultText, type ResultSummary } from "./translate";

const ROOT = "/work/project";

// Shapes as Claude Code 2.1.301 sends them (recorded live, 2026-10-15; see the trial in WS-22).
const start = (id: string): SdkMessage => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id, model: "claude-haiku-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 100 } } } });
const delta = (text: string, parent: string | null = null): SdkMessage => ({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const usage = (output: number): SdkMessage => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: output } } });
const stop: SdkMessage = { type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } };
const assistant = (id: string, content: unknown[], parent: string | null = null): SdkMessage => ({ type: "assistant", parent_tool_use_id: parent, message: { id, content: content as never } });
const toolResult = (id: string, content: unknown, isError = false, parent: string | null = null): SdkMessage => ({ type: "user", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
const result = (overrides: Partial<ResultSummary> = {}): ResultSummary => ({ type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 2, output_tokens: 3 }, session_id: "s-1", ...overrides });

function runtimeEvents(events: ArchymedesEvent[]) {
  return events.flatMap((event) => (event.type === "runtime" ? [event.event] : []));
}

/** `end` null: the stream ended with no result at all. */
function turn(messages: SdkMessage[], end: ResultSummary | null = result(), reason = {}) {
  const translator = new ClaudeTranslator(ROOT);
  translator.begin();
  const events = messages.flatMap((message) => translator.feed(message));
  const finished = translator.finish(end ?? undefined, reason);
  return { translator, events: [...events, ...finished.events], outcome: finished.outcome };
}

describe("ClaudeTranslator", () => {
  it("passes streamed text on as it arrives, and does not repeat it when the whole message follows", () => {
    const { events, outcome } = turn([start("m1"), delta("Hel"), delta("lo"), assistant("m1", [{ type: "text", text: "Hello" }]), usage(4), stop]);
    const said = runtimeEvents(events).filter((event) => event.type === "assistant_delta").map((event) => (event as { text: string }).text);
    expect(said).toEqual(["Hel", "lo"]);
    expect(outcome).toMatchObject({ status: "completed", text: "Hello" });
  });

  it("sends a message's text whole when nothing streamed (partial messages off)", () => {
    const { events, outcome } = turn([assistant("m1", [{ type: "text", text: "Whole" }])]);
    expect(runtimeEvents(events).filter((event) => event.type === "assistant_delta")).toHaveLength(1);
    expect(outcome.text).toBe("Whole");
  });

  it("shows Claude Code's tools as Friday's, with project-relative paths, and an edit's result as its diff", () => {
    const edit = { file_path: `${ROOT}/src/app.ts`, old_string: "hello", new_string: "bye", replace_all: false };
    const { events } = turn([
      start("m1"),
      assistant("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: `${ROOT}/src/app.ts` } }, { type: "tool_use", id: "t2", name: "Edit", input: edit }, { type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test", description: "run tests" } }]),
      stop,
      toolResult("t1", "1\thello"),
      toolResult("t2", "The file has been updated."),
      toolResult("t3", [{ type: "text", text: "ok" }]),
    ]);
    const calls = runtimeEvents(events).filter((event) => event.type === "tool_call") as Array<{ toolName: string; arguments: Record<string, unknown>; effect: string }>;
    expect(calls.map((call) => call.toolName)).toEqual(["read_file", "edit_file", "run_command"]);
    expect(calls[0].arguments).toEqual({ path: "src/app.ts" });
    expect(calls[1]).toMatchObject({ arguments: { path: "src/app.ts", oldText: "hello", newText: "bye", replaceAll: false }, effect: "workspace" });
    expect(calls[2].arguments).toEqual({ command: "npm test", description: "run tests" });
    const results = runtimeEvents(events).filter((event) => event.type === "tool_result") as Array<{ toolName: string; content: string }>;
    expect(results[1].content).toBe("--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-hello\n+bye");
    expect(results[2].content).toBe("ok");
  });

  it("keeps a sub-agent's own messages out of the conversation", () => {
    const { events } = turn([
      assistant("m1", [{ type: "tool_use", id: "task", name: "Task", input: { description: "look around", subagent_type: "Explore" } }]),
      delta("inner thoughts", "task"),
      assistant("m2", [{ type: "text", text: "inner reply" }, { type: "tool_use", id: "inner", name: "Read", input: {} }], "task"),
      toolResult("inner", "x", false, "task"),
      toolResult("task", "Found it."),
    ]);
    const shown = runtimeEvents(events);
    expect(shown.filter((event) => event.type === "assistant_delta")).toEqual([]);
    expect(shown.filter((event) => event.type === "tool_call").map((event) => (event as { toolName: string }).toolName)).toEqual(["delegate_task"]);
    expect(shown.filter((event) => event.type === "tool_result")).toHaveLength(1);
  });

  it("shows a sub-agent's tool calls under its Task call, with its role, without their output", () => {
    const { events } = turn([
      assistant("m1", [{ type: "tool_use", id: "task", name: "Task", input: { description: "look around", subagent_type: "Explore" } }]),
      assistant("m2", [{ type: "tool_use", id: "inner", name: "Read", input: { file_path: "/repo/src/app.ts" } }], "task"),
      toolResult("inner", "x".repeat(5_000), true, "task"),
      toolResult("task", "Found it."),
    ]);
    const sub = events.filter((event) => event.type === "subagent") as Array<Extract<ArchymedesEvent, { type: "subagent" }>>;
    expect(sub.map((event) => [event.parentToolCallId, event.agent, event.event.type])).toEqual([["task", "Explore", "tool_call"], ["task", "Explore", "tool_result"]]);
    expect(sub[0].event).toMatchObject({ toolName: "read_file" });
    expect(sub[1].event).toMatchObject({ isError: true });
    expect((sub[1].event as { content: string }).content.length).toBeLessThanOrEqual(240);
  });

  it("reports each model call once with its usage, cache included in input", () => {
    const { events, translator } = turn([start("m1"), delta("a"), usage(7), stop, start("m2"), usage(3), stop]);
    const calls = runtimeEvents(events).filter((event) => event.type === "model_turn") as Array<{ responseId: string; usage: ReturnType<typeof modelUsage> }>;
    expect(calls.map((call) => call.responseId)).toEqual(["m1", "m2"]);
    expect(calls[0].usage).toEqual({ inputTokens: 152, outputTokens: 7, totalTokens: 159, cachedInputTokens: 100, cacheWriteTokens: 50, reasoningTokens: 0 });
    expect(translator.totals).toMatchObject({ calls: 2, output: 10, cacheRead: 200 });
  });

  it("falls back to the result's usage when no call reported any", () => {
    const { events } = turn([assistant("m1", [{ type: "text", text: "hi" }])]);
    expect(runtimeEvents(events).filter((event) => event.type === "model_turn")).toHaveLength(1);
  });

  it("says a retry while it waits, and a compaction when Claude Code shortens the conversation", () => {
    const { events } = turn([
      { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 2000, error_status: 429, error: "rate_limit" },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150_000 } },
    ]);
    expect(runtimeEvents(events)[0]).toEqual({ type: "provider_retry", iteration: 0, nextAttempt: 2, maxAttempts: 11, delayMs: 2000, reason: "rate_limit" });
    expect(events.find((event) => event.type === "compaction")).toMatchObject({ tokensBefore: 150_000, urgency: "required" });
  });

  it("closes calls still open when a turn is stopped, and says it was stopped", () => {
    const { events, outcome } = turn([assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 100" } }])], result({ subtype: "error_during_execution", is_error: true }), { cancelled: true });
    expect(runtimeEvents(events).find((event) => event.type === "tool_result")).toMatchObject({ toolCallId: "t1", isError: true, content: "Stopped before it finished." });
    expect(outcome.status).toBe("cancelled");
  });

  it("names a used-up plan limit in a failed turn", () => {
    const translator = new ClaudeTranslator(ROOT);
    translator.begin();
    translator.feed({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_000_000 } });
    const { outcome } = translator.finish(result({ subtype: "success", is_error: true, result: "API Error: 429" }));
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toMatch(/^Claude Code: API Error: 429\. Your Claude plan's five-hour limit is used up; it resets at/);
  });

  it("reads the outcome of turn limits and of a stream that ended without a result", () => {
    expect(turn([], result({ subtype: "error_max_turns", is_error: true })).outcome.status).toBe("iteration_limit");
    expect(turn([], null, { error: "Claude Code exited." }).outcome).toMatchObject({ status: "failed", summary: "Claude Code exited." });
  });

  it("learns the session id, model and tools from init, and the plan from TodoWrite", () => {
    const { translator } = turn([
      { type: "system", subtype: "init", session_id: "abc", model: "claude-opus-5-5", tools: ["Read", "Edit"] },
      assistant("m1", [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [{ content: "write tests", status: "in_progress", activeForm: "Writing tests" }] } }]),
    ], result({ session_id: "abc" }));
    expect(translator).toMatchObject({ sessionId: "abc", model: "claude-opus-5-5", tools: ["Read", "Edit"], todos: [{ text: "write tests", status: "in_progress" }] });
  });

  it("bounds tool results, and keeps a path outside the project whole", () => {
    expect(resultText("x".repeat(MAX_RESULT_CHARS + 10))).toHaveLength(MAX_RESULT_CHARS + "\n… 10 more characters".length);
    expect(resultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\n[image]\nb");
    expect(editDiff({ file_path: "/etc/hosts", old_string: "a", new_string: "" }, ROOT)).toBe("--- a//etc/hosts\n+++ b//etc/hosts\n@@ -1,1 +1,0 @@\n-a");
  });
});

/**
 * The translator's invariants, against Claude Code streams generated at random from the shapes it
 * really sends — streamed and unstreamed text, tool calls answered late, twice, never or for
 * calls never announced, sub-agent noise, messages of types nobody knows, a turn that ends with or
 * without a result, stopped or not. A failure names its seed: `SEED=<n> npx vitest run translate`.
 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const TOOL_NAMES = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebFetch", "TodoWrite", "Task", "NotebookEdit", "mcp__github__create_issue"];

function randomStream(next: () => number): { messages: SdkMessage[]; expected: string; end?: ResultSummary; reason: { cancelled?: boolean; error?: string } } {
  const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)];
  const messages: SdkMessage[] = [];
  const announced: string[] = [];
  let expected = ""; // the main conversation's text, each piece once: what must be said
  const calls = 1 + Math.floor(next() * 5);
  for (let call = 0; call < calls; call += 1) {
    const id = `msg_${call}`;
    const streams = next() < 0.8;
    if (streams) messages.push(start(id));
    const text = next() < 0.7 ? `part ${call} ` : "";
    expected += text;
    if (streams && text) for (const piece of text.match(/.{1,3}/g) ?? []) messages.push(delta(piece));
    const content: unknown[] = text ? [{ type: "text", text }] : [];
    for (let tool = 0; tool < Math.floor(next() * 3); tool += 1) {
      const toolId = next() < 0.1 && announced.length > 0 ? pick(announced) : `toolu_${call}_${tool}`; // sometimes a repeated id
      announced.push(toolId);
      content.push({ type: "tool_use", id: toolId, name: pick(TOOL_NAMES), input: next() < 0.9 ? { file_path: `${ROOT}/f${tool}.ts`, command: "ls", old_string: "a", new_string: "b", todos: [] } : "not an object" });
    }
    if (next() < 0.5) messages.push(assistant(id, content)); else for (const block of content) messages.push(assistant(id, [block])); // whole, or one block per message as Claude Code does
    if (next() < 0.2) messages.push(delta("sub-agent text", "toolu_x"), assistant("sub", [{ type: "tool_use", id: "sub_tool", name: "Read", input: {} }], "toolu_x"));
    if (next() < 0.1) messages.push({ type: "command_lifecycle", stage: "start" } as SdkMessage, { type: "system", subtype: "status", status: "requesting" } as SdkMessage);
    if (streams) { messages.push(usage(Math.floor(next() * 100))); if (next() < 0.9) messages.push(stop); }
    for (const toolId of [...announced]) {
      const roll = next();
      if (roll < 0.7) messages.push(toolResult(toolId, next() < 0.5 ? "output" : [{ type: "text", text: "out" }], next() < 0.2));
      else if (roll < 0.8) messages.push(toolResult(toolId, "again"), toolResult(toolId, "and again"));
      // else: never answered (an interrupt, a crash)
    }
    announced.length = 0;
    if (next() < 0.05) messages.push(toolResult("never_announced", "orphan"));
  }
  const ending = next();
  if (ending < 0.7) return { messages, expected, end: result(), reason: {} };
  if (ending < 0.8) return { messages, expected, end: result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] }), reason: {} };
  if (ending < 0.9) return { messages, expected, end: result({ subtype: "error_during_execution", is_error: true }), reason: { cancelled: true } };
  return { messages, expected, end: undefined, reason: { error: "Claude Code exited." } };
}

describe("ClaudeTranslator invariants", () => {
  const seeds = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: 400 }, (_, index) => index + 1);
  it.each(seeds)("seed %i", (seed) => {
    const next = random(seed);
    const translator = new ClaudeTranslator(ROOT);
    for (let turnIndex = 0; turnIndex < 3; turnIndex += 1) {
      const { messages, expected, end, reason } = randomStream(next);
      translator.begin();
      const events = messages.flatMap((message) => translator.feed(message));
      const finished = translator.finish(end, reason);
      const all = [...events, ...finished.events];
      const shown = runtimeEvents(all);

      // Exactly one stop, and it is the last thing said.
      expect(shown.filter((event) => event.type === "runtime_stop"), `seed ${seed}`).toHaveLength(1);
      expect(all.at(-1)).toMatchObject({ type: "runtime", event: { type: "runtime_stop", status: finished.outcome.status } });
      // Nothing more once the turn is over, whatever arrives.
      expect(messages.flatMap((message) => translator.feed(message)), `seed ${seed}: spoke after the turn ended`).toEqual([]);
      expect(translator.finish(result()).events).toEqual([]);

      // The text said is the text kept, once.
      const said = shown.filter((event) => event.type === "assistant_delta").map((event) => (event as { text: string }).text).join("");
      expect(said, `seed ${seed}`).toBe(expected);
      expect(finished.outcome.text).toBe(expected);
      expect(said).not.toContain("sub-agent");

      // Every call answered exactly once, after it was announced; no answer to a call never made.
      const opened = new Set<string>();
      const answered = new Set<string>();
      for (const event of shown) {
        if (event.type === "tool_call") {
          expect(opened.has(event.toolCallId), `seed ${seed}: ${event.toolCallId} announced twice`).toBe(false);
          expect(typeof event.arguments === "object" && event.arguments !== null && !Array.isArray(event.arguments)).toBe(true);
          for (const key of ["path"]) {
            const value = event.arguments[key];
            if (typeof value === "string") expect(value.startsWith(ROOT), `seed ${seed}: ${value} not made relative`).toBe(false);
          }
          opened.add(event.toolCallId);
        }
        if (event.type === "tool_result") {
          expect(opened.has(event.toolCallId), `seed ${seed}: answer to ${event.toolCallId} before or without its call`).toBe(true);
          expect(answered.has(event.toolCallId), `seed ${seed}: ${event.toolCallId} answered twice`).toBe(false);
          expect(event.content.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 40);
          answered.add(event.toolCallId);
        }
      }
      expect([...opened].filter((id) => !answered.has(id)), `seed ${seed}: calls left open`).toEqual([]);
      if (reason.cancelled) expect(finished.outcome.status).toBe("cancelled");

      // Usage is counted once per call, never negative, and every event survives the wire.
      const usages = shown.filter((event) => event.type === "model_turn") as Array<{ usage: Record<string, number> }>;
      for (const { usage: counted } of usages) for (const value of Object.values(counted)) expect(value).toBeGreaterThanOrEqual(0);
      expect(() => JSON.parse(JSON.stringify(all))).not.toThrow();
    }
  });
});
