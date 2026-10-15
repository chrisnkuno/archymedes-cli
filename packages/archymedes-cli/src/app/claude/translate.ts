import path from "node:path";
import type { AgentRuntimeResult, ProviderFailureKind } from "@archymedes/core/agent-runtime";
import type { ArchymedesEvent } from "@archymedes/core/cli/agent";
import type { ModelUsage } from "@archymedes/core/providers/model";
import type { ApiUsage, ContentBlock, RateLimitInfo, SdkMessage } from "./sdk";

/**
 * Claude Code's stream, said in Archymedes's events: the ones the interface already draws.
 *
 * Pure: messages in, events out, no I/O. A session feeds every message of a turn through `feed`
 * and ends the turn with `finish`. The invariants it keeps, which `translate.test.ts` checks
 * against random streams:
 *
 * - The reply's text arrives once. Streamed deltas are the text; the complete assistant message
 *   that follows repeats it and is not sent again. A message that streamed nothing (no partial
 *   messages) is sent whole.
 * - Every tool call is answered exactly once, after it was announced. A call still open when the
 *   turn ends (an interrupt, a crash) is closed as failed, so no card spins forever.
 * - A turn ends with exactly one `runtime_stop`, and nothing follows it.
 * - Only the main conversation is shown. A sub-agent's own messages (`parent_tool_use_id` set)
 *   are its work, reported through its tool call.
 *
 * Tool calls are shown under Archymedes's names where one means the same thing (`Edit` is
 * `edit_file`, its `file_path` a project-relative `path`), so they draw as the cards people
 * already read. An edit's result is the change itself, as a diff, rather than Claude Code's
 * "The file has been updated" — the change is what someone reviewing wants to see.
 */

/** Claude Code's tools that are one of ours, with the argument mapping. Others keep their names. */
const TOOLS: Record<string, { name: string; args: (input: Record<string, unknown>, root: string) => Record<string, unknown> }> = {
  Bash: { name: "run_command", args: (input) => pick({ command: input.command, description: input.description }) },
  Read: { name: "read_file", args: (input, root) => pick({ path: relative(input.file_path, root), offset: input.offset, limit: input.limit }) },
  Write: { name: "write_file", args: (input, root) => pick({ path: relative(input.file_path, root), content: input.content }) },
  Edit: { name: "edit_file", args: (input, root) => pick({ path: relative(input.file_path, root), oldText: input.old_string, newText: input.new_string, replaceAll: input.replace_all }) },
  MultiEdit: { name: "edit_file", args: (input, root) => pick({ path: relative(input.file_path, root), edits: input.edits }) },
  Glob: { name: "glob_files", args: (input, root) => pick({ pattern: input.pattern, path: relative(input.path, root) }) },
  Grep: { name: "grep_files", args: (input, root) => pick({ query: input.pattern, include: input.glob, path: relative(input.path, root) }) },
  WebSearch: { name: "web_search", args: (input) => pick({ query: input.query }) },
  WebFetch: { name: "web_fetch", args: (input) => pick({ url: input.url }) },
  TodoWrite: { name: "todo_write", args: (input) => pick({ todos: input.todos }) },
  Task: { name: "delegate_task", args: (input) => pick({ task: input.description ?? input.prompt, agent: input.subagent_type }) },
  Agent: { name: "delegate_task", args: (input) => pick({ task: input.description ?? input.prompt, agent: input.subagent_type }) },
};

/** Tools whose work changes the project, for the event's `effect`. */
const WRITES = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** How much of one tool result is kept in the event: enough to read, never a megabyte. */
export const MAX_RESULT_CHARS = 20_000;

export type TodoItem = { text: string; status: string };

export type TurnOutcome = {
  status: AgentRuntimeResult["status"];
  summary: string;
  /** The reply, as said: what is kept in the session's transcript. */
  text: string;
};

export type ResultSummary = Extract<SdkMessage, { type: "result" }>;

export class ClaudeTranslator {
  /** Claude Code's own session id, from `init`; what `resume` takes. */
  sessionId?: string;
  model?: string;
  tools: readonly string[] = [];
  todos: TodoItem[] = [];
  rateLimit?: RateLimitInfo;
  /** Usage over the whole session, for /cost. */
  readonly totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

  private iteration = 0;
  private streamed = new Set<string>();
  private call?: { id: string; model: string; usage: ApiUsage; toolCalls: number };
  private open = new Map<string, { name: string; input: Record<string, unknown> }>();
  private text: string[] = [];
  private ended = false;

  constructor(private readonly root: string) {}

  /** A new turn: per-turn state cleared, session facts kept. */
  begin(): void {
    this.streamed.clear();
    this.open.clear();
    this.call = undefined;
    this.text = [];
    this.ended = false;
  }

  feed(message: SdkMessage): ArchymedesEvent[] {
    if (this.ended) return [];
    switch (message.type) {
      case "system":
        return this.system(message);
      case "stream_event":
        return this.stream(message as Extract<SdkMessage, { type: "stream_event" }>);
      case "assistant":
        return this.assistant(message as Extract<SdkMessage, { type: "assistant" }>);
      case "user":
        return this.user(message as Extract<SdkMessage, { type: "user" }>);
      case "rate_limit_event":
        this.rateLimit = (message as Extract<SdkMessage, { type: "rate_limit_event" }>).rate_limit_info;
        return [];
      default:
        return [];
    }
  }

  /**
   * Ends the turn: open calls closed, usage reported if no call reported it, one `runtime_stop`.
   * `result` is Claude Code's own end of turn; absent when the stream ended without one.
   */
  finish(result: ResultSummary | undefined, reason: { cancelled?: boolean; error?: string } = {}): { events: ArchymedesEvent[]; outcome: TurnOutcome } {
    const events: ArchymedesEvent[] = [];
    if (this.ended) return { events, outcome: { status: "failed", summary: "The turn had already ended.", text: "" } };
    events.push(...this.endCall());
    for (const [id, call] of this.open) {
      events.push(runtime({ type: "tool_result", toolCallId: id, toolName: call.name, isError: true, effect: "none", content: reason.cancelled ? "Stopped before it finished." : "Ended before it finished." }));
    }
    this.open.clear();
    if (result) {
      this.sessionId = result.session_id || this.sessionId;
      this.totals.costUsd += Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : 0;
      if (this.iteration === 0 && result.usage) events.push(this.modelTurn("result", this.model ?? "claude", result.usage, 0));
    }
    const text = this.text.join("");
    const outcome = outcomeOf(result, reason, text, this.rateLimit);
    events.push(runtime({ type: "runtime_stop", status: outcome.status, summary: outcome.summary }));
    this.ended = true;
    this.iteration = 0;
    return { events, outcome };
  }

  private system(message: SdkMessage): ArchymedesEvent[] {
    const subtype = (message as { subtype?: string }).subtype;
    if (subtype === "init") {
      const init = message as Extract<SdkMessage, { subtype: "init" }>;
      this.sessionId = init.session_id;
      this.model = init.model;
      this.tools = Array.isArray(init.tools) ? init.tools : [];
      return [];
    }
    if (subtype === "api_retry") {
      const retry = message as Extract<SdkMessage, { subtype: "api_retry" }>;
      return [runtime({
        type: "provider_retry", iteration: this.iteration, nextAttempt: retry.attempt + 1, maxAttempts: retry.max_retries + 1,
        delayMs: retry.retry_delay_ms, reason: failureKind(retry.error, retry.error_status),
      })];
    }
    if (subtype === "compact_boundary") {
      const meta = (message as Extract<SdkMessage, { subtype: "compact_boundary" }>).compact_metadata;
      return [{ type: "compaction", tokensBefore: meta.pre_tokens, messagesBefore: 0, messagesAfter: 0, urgency: meta.trigger === "auto" ? "required" : "none" }];
    }
    return [];
  }

  private stream(message: Extract<SdkMessage, { type: "stream_event" }>): ArchymedesEvent[] {
    if (message.parent_tool_use_id) return [];
    const event = message.event;
    switch (event.type) {
      case "message_start": {
        const start = event as Extract<typeof event, { type: "message_start" }>;
        const events = this.endCall();
        this.call = { id: start.message.id, model: start.message.model ?? this.model ?? "claude", usage: start.message.usage ?? {}, toolCalls: 0 };
        return events;
      }
      case "content_block_delta": {
        const delta = (event as Extract<typeof event, { type: "content_block_delta" }>).delta;
        if (delta.type !== "text_delta" || !delta.text) return [];
        if (this.call) this.streamed.add(this.call.id);
        this.text.push(delta.text);
        return [runtime({ type: "assistant_delta", iteration: this.iteration, text: delta.text })];
      }
      case "message_delta": {
        const usage = (event as Extract<typeof event, { type: "message_delta" }>).usage;
        if (this.call && usage) this.call.usage = { ...this.call.usage, ...usage };
        return [];
      }
      case "message_stop":
        return this.endCall();
      default:
        return [];
    }
  }

  private assistant(message: Extract<SdkMessage, { type: "assistant" }>): ArchymedesEvent[] {
    if (message.parent_tool_use_id) return [];
    const events: ArchymedesEvent[] = [];
    const streamed = this.streamed.has(message.message.id);
    for (const block of message.message.content ?? []) {
      if (block.type === "text" && !streamed && typeof block.text === "string" && block.text) {
        this.text.push(block.text);
        events.push(runtime({ type: "assistant_delta", iteration: this.iteration, text: block.text }));
      }
      if (block.type === "tool_use") events.push(...this.toolCall(block as Extract<ContentBlock, { type: "tool_use" }>));
    }
    return events;
  }

  private toolCall(block: { id: string; name: string; input: unknown }): ArchymedesEvent[] {
    if (!block.id || this.open.has(block.id)) return [];
    const input = isRecord(block.input) ? block.input : {};
    const shown = describeToolUse(block.name, input, this.root);
    const name = shown.name;
    this.open.set(block.id, { name, input });
    if (this.call?.id) this.call.toolCalls += 1;
    if (block.name === "TodoWrite" && Array.isArray(input.todos)) {
      this.todos = input.todos.filter(isRecord).map((todo) => ({ text: String(todo.content ?? todo.text ?? ""), status: String(todo.status ?? "pending") }));
    }
    return [runtime({
      type: "tool_call", toolCallId: block.id, toolName: name,
      effect: WRITES.has(block.name) ? "workspace" : block.name.startsWith("Web") ? "external" : "none",
      arguments: shown.args,
    })];
  }

  private user(message: Extract<SdkMessage, { type: "user" }>): ArchymedesEvent[] {
    if (message.parent_tool_use_id || typeof message.message.content === "string") return [];
    const events: ArchymedesEvent[] = [];
    for (const block of message.message.content) {
      if (block.type !== "tool_result") continue;
      const result = block as Extract<ContentBlock, { type: "tool_result" }>;
      const call = this.open.get(result.tool_use_id);
      if (!call) continue; // never announced, or already answered: a second answer is not shown
      this.open.delete(result.tool_use_id);
      const isError = result.is_error === true;
      const content = !isError && call.name === "edit_file" ? editDiff(call.input, this.root) ?? resultText(result.content) : resultText(result.content);
      events.push(runtime({ type: "tool_result", toolCallId: result.tool_use_id, toolName: call.name, isError, effect: "none", content }));
    }
    return events;
  }

  /** The model call in progress, reported once with its usage. */
  private endCall(): ArchymedesEvent[] {
    const call = this.call;
    if (!call) return [];
    this.call = undefined;
    this.iteration += 1;
    return [this.modelTurn(call.id, call.model, call.usage, call.toolCalls)];
  }

  private modelTurn(responseId: string, model: string, usage: ApiUsage, toolCallCount: number): ArchymedesEvent {
    const counted = modelUsage(usage);
    this.totals.calls += 1;
    this.totals.input += counted.inputTokens;
    this.totals.output += counted.outputTokens;
    this.totals.cacheRead += counted.cachedInputTokens;
    this.totals.cacheWrite += counted.cacheWriteTokens;
    return runtime({ type: "model_turn", iteration: this.iteration, responseId, model, toolCallCount, usage: counted });
  }
}

/** A Claude Code tool call under the name and arguments Archymedes shows it with. */
export function describeToolUse(name: string, input: Record<string, unknown>, root: string): { name: string; args: Record<string, unknown> } {
  const known = TOOLS[name];
  return known ? { name: known.name, args: known.args(input, root) } : { name, args: input };
}

function runtime(event: Extract<ArchymedesEvent, { type: "runtime" }>["event"]): ArchymedesEvent {
  return { type: "runtime", event };
}

/** Claude's usage as Archymedes counts it: input includes what was read from and written to cache. */
export function modelUsage(usage: ApiUsage): ModelUsage {
  const cachedInputTokens = count(usage.cache_read_input_tokens);
  const cacheWriteTokens = count(usage.cache_creation_input_tokens);
  const inputTokens = count(usage.input_tokens) + cachedInputTokens + cacheWriteTokens;
  const outputTokens = count(usage.output_tokens);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens, cacheWriteTokens, reasoningTokens: count(usage.output_tokens_details?.thinking_tokens) };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function failureKind(error: string, status: number | null): ProviderFailureKind {
  if (error === "rate_limit" || status === 429) return "rate_limit";
  if (error === "overloaded" || error === "server_error" || (status !== null && status >= 500)) return "server";
  return "unknown";
}

/** What a turn came to, from Claude Code's result (or its absence). */
function outcomeOf(result: ResultSummary | undefined, reason: { cancelled?: boolean; error?: string }, text: string, rateLimit?: RateLimitInfo): TurnOutcome {
  if (reason.cancelled) return { status: "cancelled", summary: "Stopped.", text };
  if (!result) return { status: "failed", summary: reason.error ?? "Claude Code stopped before the turn ended.", text };
  if (result.subtype === "success" && !result.is_error) return { status: "completed", summary: result.result?.trim() || text.trim() || "Done.", text };
  if (result.subtype === "error_max_turns") return { status: "iteration_limit", summary: "Claude Code reached its turn limit.", text };
  const said = [...(result.errors ?? []), result.subtype === "success" ? result.result ?? "" : ""].map((line) => line.trim()).filter(Boolean).join(" ");
  const limited = rateLimit?.status === "rejected" ? ` Your Claude plan's ${limitName(rateLimit.rateLimitType)} limit is used up${resetsAt(rateLimit.resetsAt)}.` : "";
  return { status: "failed", summary: `Claude Code: ${said || "the turn failed"}.${limited}`.replace(/\.\./g, "."), text };
}

function limitName(type: string | undefined): string {
  if (type === "five_hour") return "five-hour";
  if (type?.startsWith("seven_day")) return "weekly";
  return "usage";
}

function resetsAt(epochSeconds: number | undefined): string {
  if (!epochSeconds) return "";
  return `; it resets at ${new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** A tool result's text: a string, or the text blocks of a content array. */
export function resultText(content: unknown): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : isRecord(block) && block.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… ${text.length - MAX_RESULT_CHARS} more characters` : text;
}

/** An edit as a unified diff of the replaced text, which is what the edit card shows. */
export function editDiff(input: Record<string, unknown>, root: string): string | undefined {
  const file = relative(input.file_path, root);
  if (!file || typeof input.old_string !== "string" || typeof input.new_string !== "string") return undefined;
  const removed = input.old_string.split("\n").map((line) => `-${line}`);
  const added = input.new_string === "" ? [] : input.new_string.split("\n").map((line) => `+${line}`);
  return [`--- a/${file}`, `+++ b/${file}`, `@@ -1,${removed.length} +1,${added.length} @@`, ...removed, ...added].join("\n");
}

function relative(value: unknown, root: string): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (!path.isAbsolute(value)) return value;
  const inside = path.relative(root, value);
  if (inside === "") return ".";
  if (inside.startsWith("..") || path.isAbsolute(inside)) return value; // outside the project: said in full
  return inside.split(path.sep).join("/");
}

function pick(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
