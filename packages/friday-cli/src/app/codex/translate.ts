import path from "node:path";
import type { AgentRuntimeResult } from "@archymedes/core/agent-runtime";
import type { ArchymedesEvent } from "@archymedes/core/cli/agent";
import { asRecord } from "./rpc";

/**
 * Codex's app-server notifications, said in Archymedes's events: the ones the interface already
 * draws. Pure: notifications in, events out. A session feeds a turn's notifications through `feed`
 * and ends the turn with `finish`. What it keeps, which `translate.test.ts` checks:
 *
 * - The reply's text arrives once: streamed deltas are the text; a completed message that streamed
 *   nothing is sent whole.
 * - Every tool call (a command, a file change, an MCP or web call) is answered exactly once, after
 *   it was announced; one still open when the turn ends is closed as failed.
 * - A turn ends with exactly one `runtime_stop`, and nothing follows it.
 * - Each `thread/tokenUsage/updated` is one model call, reported with that call's usage.
 *
 * Commands are shown as `run_command` with the command Codex wrapped in `bash -lc` unwrapped, and a
 * file change as `edit_file` (or `write_file` for a new file) whose result is the change's diff,
 * with project-relative paths — the cards people already read.
 */

export const MAX_RESULT_CHARS = 20_000;

export type TodoItem = { text: string; status: string };

export type TurnOutcome = { status: AgentRuntimeResult["status"]; summary: string; text: string };

type Usage = { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number; cacheWriteTokens: number; reasoningTokens: number };

export class CodexTranslator {
  model?: string;
  todos: TodoItem[] = [];
  /** The context window Codex reports for its model, once it has. */
  contextWindow?: number;
  readonly totals = { calls: 0, input: 0, output: 0, cacheRead: 0 };

  private iteration = 0;
  private toolCallsSinceUsage = 0;
  private open = new Map<string, string>();
  private streamed = new Set<string>();
  private messages = new Map<string, string>();
  private order: string[] = [];
  /** The newest message Codex marked as its final answer: the turn's summary. */
  private finalAnswer?: string;
  /** What each file change is about to touch, for the approval that may follow it. */
  private readonly changePaths = new Map<string, string[]>();
  private failure?: string;
  private ended = false;

  constructor(private readonly root: string) {}

  begin(): void {
    this.open.clear();
    this.streamed.clear();
    this.messages.clear();
    this.order = [];
    this.finalAnswer = undefined;
    this.changePaths.clear();
    this.failure = undefined;
    this.toolCallsSinceUsage = 0;
    this.iteration = 0;
    this.ended = false;
  }

  feed(method: string, params: Record<string, unknown>): ArchymedesEvent[] {
    if (this.ended) return [];
    switch (method) {
      case "item/agentMessage/delta": {
        const id = String(params.itemId ?? "");
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!delta) return [];
        this.streamed.add(id);
        this.say(id, delta);
        return [runtime({ type: "assistant_delta", iteration: this.iteration, text: delta })];
      }
      case "item/started":
        return this.started(asRecord(params.item));
      case "item/completed":
        return this.completed(asRecord(params.item));
      case "thread/tokenUsage/updated":
        return this.usage(params);
      case "turn/plan/updated":
        this.todos = (Array.isArray(params.plan) ? params.plan : []).map(asRecord).map((step) => ({
          text: String(step.step ?? ""),
          status: step.status === "inProgress" ? "in_progress" : step.status === "completed" ? "done" : "pending",
        }));
        return [];
      case "error": {
        const error = asRecord(params.error);
        const text = codexErrorText(String(error.message ?? "Codex reported an error"));
        if (params.willRetry === true) return [runtime({ type: "provider_retry", iteration: this.iteration, nextAttempt: 2, maxAttempts: 2, delayMs: 0, reason: failureKind(text) })];
        this.failure = text;
        return [];
      }
      case "thread/compacted":
        return [{ type: "compaction", tokensBefore: 0, messagesBefore: 0, messagesAfter: 0, urgency: "required" }];
      default:
        return [];
    }
  }

  /** Ends the turn with Codex's own status for it; `cancelled` when the person stopped it. */
  finish(turn: { status?: string; error?: string } | undefined, reason: { cancelled?: boolean; error?: string } = {}): { events: ArchymedesEvent[]; outcome: TurnOutcome } {
    if (this.ended) return { events: [], outcome: { status: "failed", summary: "The turn had already ended.", text: "" } };
    const events: ArchymedesEvent[] = [];
    for (const [id, name] of this.open) {
      events.push(runtime({ type: "tool_result", toolCallId: id, toolName: name, isError: true, effect: "none", content: reason.cancelled ? "Stopped before it finished." : "Ended before it finished." }));
    }
    this.open.clear();
    const text = this.order.map((id) => this.messages.get(id) ?? "").filter((part) => part.trim()).join("\n\n");
    const error = reason.error ?? (turn?.error ? codexErrorText(turn.error) : undefined) ?? this.failure;
    let outcome: TurnOutcome;
    if (reason.cancelled || turn?.status === "interrupted") outcome = { status: "cancelled", summary: "Stopped.", text };
    else if (turn?.status === "completed" && !reason.error) outcome = { status: "completed", summary: this.finalAnswer?.trim() || lastParagraph(text) || "Codex finished.", text };
    else outcome = { status: "failed", summary: error ?? "Codex stopped before finishing the turn.", text };
    events.push(runtime({ type: "runtime_stop", status: outcome.status, summary: outcome.summary }));
    this.ended = true;
    return { events, outcome };
  }

  /** The files a file change announced, project-relative: what its approval is about. */
  pathsOf(itemId: string): string[] {
    return this.changePaths.get(itemId) ?? [];
  }

  private started(item: Record<string, unknown>): ArchymedesEvent[] {
    const id = String(item.id ?? "");
    if (!id || this.open.has(id)) return [];
    if (item.type === "fileChange") {
      this.changePaths.set(id, (Array.isArray(item.changes) ? item.changes : []).map(asRecord).map((change) => relative(String(change.path ?? ""), this.root)));
    }
    const call = this.describe(item);
    if (!call) return [];
    this.open.set(id, call.name);
    this.toolCallsSinceUsage += 1;
    return [runtime({ type: "tool_call", toolCallId: id, toolName: call.name, effect: call.effect, arguments: call.args })];
  }

  private completed(item: Record<string, unknown>): ArchymedesEvent[] {
    const id = String(item.id ?? "");
    if (item.type === "agentMessage") {
      if (item.phase === "final_answer" && typeof item.text === "string") this.finalAnswer = item.text;
      if (this.streamed.has(id) || typeof item.text !== "string" || !item.text) return [];
      this.streamed.add(id); // said now: a repeat of the completed message is not said again
      this.say(id, item.text);
      return [runtime({ type: "assistant_delta", iteration: this.iteration, text: item.text })];
    }
    const name = this.open.get(id);
    if (!name) return []; // never announced, or answered already
    this.open.delete(id);
    const { content, isError } = this.result(item);
    return [runtime({ type: "tool_result", toolCallId: id, toolName: name, isError, effect: "none", content: bounded(content) })];
  }

  private usage(params: Record<string, unknown>): ArchymedesEvent[] {
    const tokenUsage = asRecord(params.tokenUsage);
    const last = asRecord(tokenUsage.last);
    if (typeof tokenUsage.modelContextWindow === "number") this.contextWindow = tokenUsage.modelContextWindow;
    const usage: Usage = {
      inputTokens: count(last.inputTokens),
      outputTokens: count(last.outputTokens),
      totalTokens: count(last.totalTokens),
      cachedInputTokens: count(last.cachedInputTokens),
      cacheWriteTokens: count(last.cacheWriteInputTokens),
      reasoningTokens: count(last.reasoningOutputTokens),
    };
    this.totals.calls += 1;
    this.totals.input += usage.inputTokens;
    this.totals.output += usage.outputTokens;
    this.totals.cacheRead += usage.cachedInputTokens;
    this.iteration += 1;
    const event = runtime({
      type: "model_turn", iteration: this.iteration, responseId: `${String(params.turnId ?? "turn")}:${this.iteration}`,
      model: this.model ?? "codex", toolCallCount: this.toolCallsSinceUsage, usage,
    });
    this.toolCallsSinceUsage = 0;
    return [event];
  }

  private say(id: string, text: string): void {
    if (!this.messages.has(id)) this.order.push(id);
    this.messages.set(id, (this.messages.get(id) ?? "") + text);
  }

  private describe(item: Record<string, unknown>): { name: string; effect: "none" | "workspace" | "external"; args: Record<string, unknown> } | undefined {
    switch (item.type) {
      case "commandExecution":
        return { name: "run_command", effect: "workspace", args: { command: unwrapShell(String(item.command ?? "")) } };
      case "fileChange": {
        const changes = (Array.isArray(item.changes) ? item.changes : []).map(asRecord);
        const created = changes.length > 0 && changes.every((change) => asRecord(change.kind).type === "add");
        const first = changes[0] ? relative(String(changes[0].path ?? ""), this.root) : "";
        return { name: created ? "write_file" : "edit_file", effect: "workspace", args: { path: first, ...(changes.length > 1 ? { files: changes.map((change) => relative(String(change.path ?? ""), this.root)) } : {}) } };
      }
      case "mcpToolCall":
        return { name: `${String(item.server ?? "mcp")}.${String(item.tool ?? "tool")}`, effect: "external", args: asRecord(item.arguments) };
      case "dynamicToolCall":
        return { name: String(item.tool ?? "tool"), effect: "external", args: asRecord(item.arguments) };
      case "webSearch":
        return { name: "web_search", effect: "external", args: { query: String(item.query ?? "") } };
      default:
        return undefined;
    }
  }

  private result(item: Record<string, unknown>): { content: string; isError: boolean } {
    switch (item.type) {
      case "commandExecution": {
        const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
        const output = typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim() ? item.aggregatedOutput.trimEnd() : "(no output)";
        if (item.status === "declined") return { content: "Refused: the person did not allow this command.", isError: true };
        return { content: `exit ${exitCode ?? "?"}\n${output}`, isError: item.status !== "completed" || (exitCode !== null && exitCode !== 0) };
      }
      case "fileChange": {
        const changes = (Array.isArray(item.changes) ? item.changes : []).map(asRecord);
        if (item.status === "declined") return { content: "Refused: the person did not allow this change.", isError: true };
        const diff = changes.map((change) => `--- ${relative(String(change.path ?? ""), this.root)}\n${String(change.diff ?? "")}`).join("\n");
        return { content: diff || "(no change)", isError: item.status !== "completed" };
      }
      case "mcpToolCall": {
        const error = asRecord(item.error);
        if (typeof error.message === "string") return { content: error.message, isError: true };
        return { content: JSON.stringify(asRecord(item.result).content ?? item.result ?? null), isError: false };
      }
      default:
        return { content: item.status === "failed" ? "Failed." : "Done.", isError: item.status === "failed" };
    }
  }
}

/** `/bin/bash -lc "npm test"` is `npm test`: the wrapper is how Codex runs a command, not the command. */
export function unwrapShell(command: string): string {
  const match = /^(?:\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  if (!match) return command;
  return match[1] === '"' ? match[2].replace(/\\(["\\$`])/g, "$1") : match[2].replace(/'\\''/g, "'");
}

/** Codex wraps the provider's error in JSON; the provider's own sentence is what to say. */
export function codexErrorText(message: string): string {
  try {
    const parsed = asRecord(JSON.parse(message));
    const inner = asRecord(parsed.error);
    if (typeof inner.message === "string" && inner.message) return inner.message;
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch {
    // not JSON: it is the sentence
  }
  return message;
}

function failureKind(text: string): "timeout" | "rate_limit" | "server" | "network" | "unknown" {
  if (/rate.?limit|429|too many requests/i.test(text)) return "rate_limit";
  if (/time(?:d)?.?out/i.test(text)) return "timeout";
  if (/5\d\d|server error|overloaded/i.test(text)) return "server";
  if (/network|connect|ECONN|stream disconnected/i.test(text)) return "network";
  return "unknown";
}

function relative(file: string, root: string): string {
  if (!file) return file;
  const rel = path.relative(root, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : file;
}

function bounded(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (${text.length - MAX_RESULT_CHARS} more characters)` : text;
}

function lastParagraph(text: string): string {
  const parts = text.trim().split(/\n\s*\n/);
  return parts.at(-1)?.trim() ?? "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function runtime(event: Extract<ArchymedesEvent, { type: "runtime" }>["event"]): ArchymedesEvent {
  return { type: "runtime", event };
}
