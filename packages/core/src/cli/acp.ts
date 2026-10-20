import type { AgentMessage, AgentRuntimeResult } from "../agent-runtime";
import type { ArchymedesEvent } from "./agent";
import type { ApprovalPattern, ArchymedesMode, PermissionDecision } from "./permissions";
import { runtimeEventForJournal } from "./protocol";
import type { AskUser, UserQuestion } from "./tools";

/**
 * Archymedes as an ACP agent: the same session, driven by an editor instead of a terminal.
 *
 * The Agent Client Protocol is JSON-RPC 2.0 over stdio, and it exists for exactly one reason —
 * without it, every editor that wants to host an agent has to write a bespoke integration for
 * every agent, which is the N×M problem LSP solved for language servers. Archymedes already has the two
 * things the protocol needs and neither is easy to retrofit: a turn that streams structured events
 * rather than raw text, and an approval gate that can pause a turn and wait for a human. This file
 * is the translation layer between those and the wire, and deliberately nothing else.
 *
 * It owns no transport and no agent. A connection is handed `send` (write one JSON-RPC message)
 * and a factory that makes sessions, which is what keeps the protocol testable without a subprocess
 * on one side and a model on the other: the tests here drive real messages through a fake agent and
 * assert on the exact frames that come back.
 */

/** The major version of the wire shape this implements. */
export const ACP_PROTOCOL_VERSION = 1;

export type JsonValue = unknown;
export type JsonRpcId = string | number;

export type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, JsonValue> };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result: JsonValue } | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: JsonValue } };
export type JsonRpcOutgoing = JsonRpcRequest | JsonRpcResponse;

/** JSON-RPC's own codes; the protocol defines no others that this agent can raise. */
export const JSON_RPC = { parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internalError: -32603 } as const;

/** What ACP calls a session: one Archymedes agent, bound to one working directory. */
export interface AcpSession {
  readonly id: string;
  send(prompt: string): Promise<Pick<AgentRuntimeResult, "status" | "summary">>;
  cancel(): void;
  /** Async because a mode is a capability boundary: Archymedes changes it by rebuilding the session under it. */
  setMode(mode: ArchymedesMode): Promise<void>;
  dispose(): Promise<void>;
  /** What a rich client shows in its header: provider, model and mode. Only sent under the extension. */
  info?(): Record<string, JsonValue>;
  /** Switches the session's model, keeping its transcript; rejects a provider or model that cannot be used. */
  setModel?(provider: string, model?: string): Promise<void>;
  /** `/cost`, `/diff`, `/undo`, `/todos` and the like, answered as data for the client to draw. */
  command?(command: string, argument: string): Promise<JsonValue>;
  /** The stored conversation of a loaded session, replayed to the client before `session/load` answers. */
  history?(): readonly AgentMessage[];
  /** Hands a message to the turn in progress; false when there is none to take it. */
  steer?(text: string): boolean;
}

/**
 * Archymedes's own extension, for a client that renders more than an editor does.
 *
 * ACP's `session/update` has no shape for usage, retries, checkpoints, compactions or Jev, and a
 * client that only sees ACP cannot show spend accruing or a retry in progress. A client opts in with
 * `clientCapabilities._meta.archymedes.events: true` and then also receives `_archymedes/event`
 * notifications (ACP reserves `_`-prefixed methods for extensions), each carrying one
 * `ArchymedesEvent` with tool arguments and results passed through the journal's redaction and
 * bounding. Assistant text is not repeated there: it already arrives as `agent_message_chunk`.
 * Opt-in, so an editor that never asked receives exactly the frames it always did.
 */
export const ARCHYMEDES_EVENT_METHOD = "_archymedes/event";
export const ARCHYMEDES_EVENTS_VERSION = 1;

/** One event as the extension sends it, or `null` for what the standard channel already carries. */
export function archymedesEventForClient(event: ArchymedesEvent): ArchymedesEvent | null {
  if (event.type === "subagent") return { ...event, event: runtimeEventForJournal(event.event) as typeof event.event };
  if (event.type !== "runtime") return event;
  if (event.event.type === "assistant_delta") return null;
  return { type: "runtime", event: runtimeEventForJournal(event.event) };
}

/**
 * `ask_user`'s request to the client: one question, its suggested options, and the person's answer
 * back as text (`{answer}`), or `{dismissed: true}`. Offered only to a client that sets
 * `clientCapabilities._meta.archymedes.questions: true`: any other client would never answer it.
 */
export const ARCHYMEDES_ASK_METHOD = "_archymedes/session/ask";

function wantsQuestions(params: Record<string, JsonValue>): boolean {
  const capabilities = params.clientCapabilities as { _meta?: { archymedes?: { questions?: unknown } } } | undefined;
  return capabilities?._meta?.archymedes?.questions === true;
}

function wantsArchymedesEvents(params: Record<string, JsonValue>): boolean {
  const capabilities = params.clientCapabilities as { _meta?: { archymedes?: { events?: unknown } } } | undefined;
  return capabilities?._meta?.archymedes?.events === true;
}

/** What the agent hands the connection when a tool call needs the client's human. */
export type AcpApprovalRequest = {
  toolName: string;
  summary: string;
  toolCallId: string;
  /** A broader standing rule the human may grant instead; offered as an extra `allow_always`-kind option. */
  pattern?: ApprovalPattern;
};

export type AcpSessionFactory = (input: {
  cwd: string;
  /** Streamed straight out as `session/update` notifications. */
  onEvent: (event: ArchymedesEvent) => void;
  /** Asks the *client* to decide, since in ACP the editor owns the human. */
  approve: (request: AcpApprovalRequest) => Promise<PermissionDecision>;
  /** Puts a question to the client's human; present only when the client can show one. */
  ask?: AskUser;
  /** Present only for `session/load`: resume this stored session rather than starting one. */
  resumeSessionId?: string;
}) => Promise<AcpSession>;

export const ACP_MODES: ArchymedesMode[] = ["plan", "build", "auto", "defender"];

/**
 * How a Archymedes tool name reads to an editor.
 *
 * ACP's `kind` is what a client renders an icon and a label from, so the mapping is by what the
 * tool *does* to the world rather than by which package it came from. Anything unrecognised —
 * every MCP, skill and plugin tool, which are exactly the ones Archymedes cannot know the names of — is
 * `other`, which every client is required to handle.
 */
export function acpToolKind(toolName: string): "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other" {
  if (/^(read_file|list_files)$/.test(toolName)) return "read";
  if (/^(write_file|edit_file)$/.test(toolName)) return "edit";
  if (/^(glob_files|grep_files|scan_secrets)$/.test(toolName)) return "search";
  if (/^(run_command|start_application|application_status|stop_application|run_tests|verify|typecheck|lint)$/.test(toolName)) return "execute";
  if (/^(web_search|deep_research|web_fetch)$/.test(toolName)) return "fetch";
  if (/^(todo_write|todo_read|remember|delegate_task|delegate_readonly_task)$/.test(toolName)) return "think";
  return "other";
}

/** Archymedes's terminal statuses, said in the four words ACP has for them. */
export function acpStopReason(status: AgentRuntimeResult["status"]): "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" {
  if (status === "cancelled") return "cancelled";
  if (status === "blocked") return "refusal";
  if (status === "iteration_limit") return "max_turn_requests";
  return "end_turn";
}

/** The four decisions Archymedes's ledger understands for every request, as the option list a client renders. */
export const ACP_PERMISSION_OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow this action from now on", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
  { optionId: "deny_always", name: "Deny this action from now on", kind: "reject_always" },
] as const;

export type AcpPermissionOption = { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" };

/**
 * The options for one request. A request that offers a pattern gets a fifth, `allow_pattern`,
 * rendered with ACP's `allow_always` kind (ACP has no narrower "standing rule" kind) and named by
 * the pattern's label ("Always allow commands starting with …") so the human sees exactly how broad the grant is.
 */
export function acpPermissionOptions(pattern?: ApprovalPattern): AcpPermissionOption[] {
  const options: AcpPermissionOption[] = ACP_PERMISSION_OPTIONS.map((option) => ({ ...option }));
  if (pattern) options.splice(2, 0, { optionId: "allow_pattern", name: capitalize(pattern.label), kind: "allow_always" });
  return options;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * `patternOffered` gates `allow_pattern`: an answer naming an option this request never offered is
 * not consent to anything, so it reads as a refusal like any other unrecognised id.
 */
export function decisionFromOptionId(optionId: unknown, patternOffered = false): PermissionDecision {
  // Anything unrecognised is a refusal. An editor that answers with a string this agent does not
  // know must never be read as consent — the safe reading of an unparseable answer is "no".
  if (optionId === "allow_pattern") return patternOffered ? "allow_pattern" : "deny";
  return optionId === "allow" || optionId === "allow_always" || optionId === "deny_always" ? optionId : "deny";
}

function textBlocksToPrompt(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const value = block as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") return value.text;
      // An embedded resource carries its own text; a link carries only where it is. Both are worth
      // passing through, because a client that attached a file meant the agent to see it.
      if (value.type === "resource" && typeof value.resource === "object" && value.resource !== null) {
        const resource = value.resource as Record<string, unknown>;
        const uri = typeof resource.uri === "string" ? resource.uri : "attached resource";
        return typeof resource.text === "string" ? `<resource uri="${uri}">\n${resource.text}\n</resource>` : uri;
      }
      if (value.type === "resource_link" && typeof value.uri === "string") return value.uri;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * One ACP connection: dispatches incoming messages and streams a session's events back out.
 *
 * Requests this agent makes of the *client* (only `session/request_permission` today) are tracked
 * by id here, because JSON-RPC is symmetric and the same pipe carries both directions. A response
 * that arrives for an id nobody is waiting on is dropped rather than thrown: a client is allowed to
 * be late, and a late answer must not take down a live session.
 */
export class AcpConnection {
  private readonly sessions = new Map<string, AcpSession>();
  private readonly pending = new Map<JsonRpcId, { resolve: (value: JsonValue) => void; reject: (error: Error) => void }>();
  private nextRequestId = 1;
  private initialized = false;
  private archymedesEvents = false;
  private questions = false;

  constructor(private readonly dependencies: {
    send: (message: JsonRpcOutgoing) => void;
    createSession: AcpSessionFactory;
    /**
     * Archymedes's own `_archymedes/*` requests, answered after `initialize` and before any session
     * exists — first-run setup is asked before there is anything to open a session with.
     */
    extensions?: Record<string, (params: Record<string, JsonValue>) => Promise<JsonValue>>;
  }) {}

  /** Feeds one parsed incoming message in. Responses are written through `send`. */
  async receive(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return;
    const value = message as Record<string, JsonValue>;
    if ("result" in value || "error" in value) {
      this.settle(value);
      return;
    }
    const id = value.id as JsonRpcId | undefined;
    const method = value.method;
    if (typeof method !== "string") {
      if (id !== undefined) this.fail(id, JSON_RPC.invalidRequest, "A JSON-RPC request must name a method");
      return;
    }
    try {
      const result = await this.dispatch(method, (value.params as Record<string, JsonValue>) ?? {});
      // A notification (no id) gets no reply, even when the handler returned something.
      if (id !== undefined) this.dependencies.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const code = error instanceof AcpError ? error.code : JSON_RPC.internalError;
      if (id !== undefined) this.fail(id, code, error instanceof Error ? error.message : "Agent failed");
    }
  }

  /**
   * The client closed its side: a request still waiting on it can never be answered. Each one is
   * rejected now, which `askClient` reads as a refusal, so a turn paused on approval ends instead
   * of waiting forever. Sessions stay up until `dispose`, so a turn already running can finish.
   */
  endOfInput(): void {
    for (const waiter of this.pending.values()) waiter.reject(new Error("Client closed its input"));
    this.pending.clear();
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) await session.dispose().catch(() => undefined);
    this.sessions.clear();
    for (const waiter of this.pending.values()) waiter.reject(new Error("Connection closed"));
    this.pending.clear();
  }

  private settle(value: Record<string, JsonValue>): void {
    const waiter = this.pending.get(value.id as JsonRpcId);
    if (!waiter) return;
    this.pending.delete(value.id as JsonRpcId);
    if ("error" in value) {
      const error = value.error as { message?: string } | undefined;
      waiter.reject(new Error(error?.message ?? "Client returned an error"));
      return;
    }
    waiter.resolve(value.result);
  }

  private fail(id: JsonRpcId, code: number, message: string): void {
    this.dependencies.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private request(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    const id = `archymedes-${this.nextRequestId++}`;
    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.dependencies.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Record<string, JsonValue>): void {
    this.dependencies.send({ jsonrpc: "2.0", method, params });
  }

  private sessionFor(params: Record<string, JsonValue>): AcpSession {
    const sessionId = params.sessionId;
    const session = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    if (!session) throw new AcpError(JSON_RPC.invalidParams, `Unknown session ${String(sessionId)}`);
    return session;
  }

  private async dispatch(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    switch (method) {
      case "initialize": {
        this.initialized = true;
        this.archymedesEvents = wantsArchymedesEvents(params);
        this.questions = wantsQuestions(params);
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            ...(this.archymedesEvents ? { _meta: { archymedes: { events: ARCHYMEDES_EVENTS_VERSION } } } : {}),
          },
          // Archymedes authenticates through provider environment variables and its own settings file,
          // so there is no in-band method for a client to offer. An empty list says exactly that.
          authMethods: [],
        };
      }
      case "authenticate":
        return {};
      case "session/new":
      case "session/load": {
        if (!this.initialized) throw new AcpError(JSON_RPC.invalidRequest, "initialize must come first");
        const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
        const resumeSessionId = method === "session/load" && typeof params.sessionId === "string" ? params.sessionId : undefined;
        // The callbacks need the session's id, which the factory has not returned yet. Bound
        // through a variable rather than by capturing the result, so a factory that emits an event
        // while it is still constructing drops that event instead of throwing on an unset binding.
        let bound: AcpSession | undefined;
        const session = await this.dependencies.createSession({
          cwd,
          resumeSessionId,
          onEvent: (event) => { if (bound) this.publish(bound.id, event); },
          approve: async (request) => (bound ? this.askClient(bound.id, request) : "deny"),
          ...(this.questions ? { ask: async (question: UserQuestion) => (bound ? this.askQuestion(bound.id, question) : null) } : {}),
        });
        bound = session;
        this.sessions.set(session.id, session);
        // ACP's load contract: the client is sent the conversation it is resuming before the reply,
        // so it can show it. A client that cannot render a part simply drops that notification.
        if (method === "session/load") for (const message of session.history?.() ?? []) this.replay(session.id, message);
        const meta = this.archymedesEvents && session.info ? { _meta: { archymedes: session.info() } } : {};
        return method === "session/load"
          ? meta
          : { sessionId: session.id, modes: { currentModeId: "build", availableModes: ACP_MODES.map((mode) => ({ id: mode, name: mode })) }, ...meta };
      }
      case "session/set_mode": {
        const session = this.sessionFor(params);
        const mode = ACP_MODES.find((candidate) => candidate === params.modeId);
        if (!mode) throw new AcpError(JSON_RPC.invalidParams, `Unknown mode ${String(params.modeId)}`);
        await session.setMode(mode);
        return {};
      }
      case "_archymedes/session/command": {
        const session = this.sessionFor(params);
        if (!session.command) throw new AcpError(JSON_RPC.methodNotFound, "This agent has no session commands");
        if (typeof params.command !== "string") throw new AcpError(JSON_RPC.invalidParams, "command is required");
        return session.command(params.command, typeof params.argument === "string" ? params.argument : "");
      }
      case "_archymedes/session/steer": {
        // Answered at once, while the turn runs: accepted means the model will read it in this turn.
        const session = this.sessionFor(params);
        if (typeof params.text !== "string") throw new AcpError(JSON_RPC.invalidParams, "text is required");
        return { accepted: session.steer?.(params.text) ?? false };
      }
      case "_archymedes/session/set_model": {
        const session = this.sessionFor(params);
        if (!session.setModel) throw new AcpError(JSON_RPC.methodNotFound, "This agent cannot switch models");
        if (typeof params.provider !== "string") throw new AcpError(JSON_RPC.invalidParams, "provider is required");
        await session.setModel(params.provider, typeof params.model === "string" ? params.model : undefined);
        return this.archymedesEvents && session.info ? { _meta: { archymedes: session.info() } } : {};
      }
      case "session/prompt": {
        const session = this.sessionFor(params);
        const prompt = textBlocksToPrompt(params.prompt);
        if (!prompt.trim()) throw new AcpError(JSON_RPC.invalidParams, "prompt must contain at least one text block");
        const result = await session.send(prompt);
        return { stopReason: acpStopReason(result.status) };
      }
      case "session/cancel": {
        // A notification: cancelling an unknown session is not worth an error nobody will read.
        const sessionId = params.sessionId;
        if (typeof sessionId === "string") this.sessions.get(sessionId)?.cancel();
        return null;
      }
      case "session/close": {
        const session = this.sessionFor(params);
        this.sessions.delete(session.id);
        await session.dispose();
        return {};
      }
      default: {
        const extension = method.startsWith("_archymedes/") ? this.dependencies.extensions?.[method] : undefined;
        if (!extension) throw new AcpError(JSON_RPC.methodNotFound, `Method not found: ${method}`);
        if (!this.initialized) throw new AcpError(JSON_RPC.invalidRequest, "initialize must come first");
        return extension(params);
      }
    }
  }

  private async askClient(sessionId: string, request: AcpApprovalRequest): Promise<PermissionDecision> {
    const answer = await this.request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: request.toolCallId, title: request.summary, kind: acpToolKind(request.toolName), status: "pending" },
      options: acpPermissionOptions(request.pattern),
    }).catch(() => null);
    if (typeof answer !== "object" || answer === null) return "deny";
    // ACP's schema nests the outcome (`{ outcome: { outcome: "selected", optionId } }`), as standard
    // clients such as Zed send it; the Go interface sends it flat (`{ outcome: "selected",
    // selectedOptionId }`). Both are read; anything else is no consent.
    const raw = (answer as Record<string, unknown>).outcome;
    const outcome = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : (answer as Record<string, unknown>);
    // `cancelled` is the client saying the human went away. That is not consent either.
    if (outcome.outcome !== "selected") return "deny";
    return decisionFromOptionId(outcome.optionId ?? outcome.selectedOptionId, request.pattern !== undefined);
  }

  /** A question for the human; anything but a non-empty answer (an error, a closed client) is no answer. */
  private async askQuestion(sessionId: string, question: UserQuestion): Promise<string | null> {
    const reply = await this.request(ARCHYMEDES_ASK_METHOD, {
      sessionId,
      question: question.question,
      options: question.options,
      multiSelect: question.multiSelect,
      ...(question.toolCallId ? { toolCallId: question.toolCallId } : {}),
    }).catch(() => null);
    const answer = typeof reply === "object" && reply !== null && !Array.isArray(reply) ? (reply as Record<string, JsonValue>).answer : undefined;
    return typeof answer === "string" && answer.trim() ? answer : null;
  }

  private replay(sessionId: string, message: AgentMessage): void {
    if (message.internal || message.role === "system") return;
    if (message.role === "user") {
      this.notify("session/update", { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: message.content } } });
      return;
    }
    if (message.role === "assistant") {
      if (message.content.trim()) this.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.content } } });
      for (const call of "toolCalls" in message ? message.toolCalls : []) {
        const args = (typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {}) as Record<string, unknown>;
        this.publish(sessionId, { type: "runtime", event: { type: "tool_call", toolCallId: call.id, toolName: call.name, effect: "none", arguments: args } });
      }
      return;
    }
    if (message.role !== "tool") return;
    this.publish(sessionId, { type: "runtime", event: { type: "tool_result", toolCallId: message.toolCallId, toolName: message.name, isError: false, effect: "none", content: message.content } });
  }

  /** One Archymedes event, as whichever `session/update` an editor can render. */
  private publish(sessionId: string, event: ArchymedesEvent): void {
    const update = acpUpdateFor(event);
    if (update) this.notify("session/update", { sessionId, update });
    if (!this.archymedesEvents) return;
    const extended = archymedesEventForClient(event);
    if (extended) this.notify(ARCHYMEDES_EVENT_METHOD, { sessionId, event: extended });
  }
}

export class AcpError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "AcpError";
  }
}

/**
 * The event translation, kept as a pure function so it can be asserted on directly.
 *
 * Not every Archymedes event has an ACP shape, and inventing one would be worse than dropping it: a
 * checkpoint is a local git detail an editor cannot act on, and a compaction is bookkeeping. They
 * return `null` and stay out of the client's transcript.
 */
export function acpUpdateFor(event: ArchymedesEvent): Record<string, JsonValue> | null {
  if (event.type !== "runtime") return null;
  const runtime = event.event;
  switch (runtime.type) {
    case "assistant_delta":
      return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: runtime.text } };
    case "tool_call":
      return {
        sessionUpdate: "tool_call",
        toolCallId: runtime.toolCallId,
        title: toolCallTitle(runtime.toolName, runtime.arguments),
        kind: acpToolKind(runtime.toolName),
        status: "in_progress",
        rawInput: runtime.arguments,
      };
    case "tool_result":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: runtime.toolCallId,
        status: runtime.isError ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: runtime.content } }],
      };
    default:
      return null;
  }
}

/** "edit src/app.ts" rather than "edit_file", which is the tool's name and not the work. */
export function toolCallTitle(toolName: string, argumentsValue: Record<string, unknown>): string {
  const subject = ["path", "command", "pattern", "query", "task"].map((key) => argumentsValue[key]).find((value) => typeof value === "string" && value.trim());
  const label = toolName.replace(/_+/g, " ").trim();
  return subject ? `${label}: ${String(subject).slice(0, 120)}` : label;
}
