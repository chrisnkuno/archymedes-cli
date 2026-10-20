import { TEST_FIRST_BRIEF } from "@archymedes/core/verification-gate";
import { randomUUID } from "node:crypto";
import type { AgentRuntimeResult } from "@archymedes/core/agent-runtime";
import { toolCallTitle, type AcpApprovalRequest, type JsonValue } from "@archymedes/core/cli/acp";
import type { ArchymedesEvent } from "@archymedes/core/cli/agent";
import type { ArchymedesMode, PermissionDecision } from "@archymedes/core/cli/permissions";
import { loadSession, newSessionId, saveSession, titleFromObjective, type SessionRecord } from "@archymedes/core/cli/session";

import type { CanUseTool, ClaudeSdk, PermissionMode, PermissionResult, PermissionUpdate, Query, SdkMessage, SdkUserMessage, WarmQuery } from "./sdk";
import type { AskUser } from "@archymedes/core/cli/tools";
import { loadCommandRules, type CommandRule } from "@archymedes/core/cli/command-rules";
import { handoffPreface, markSeen, prefaceFrom } from "../handoff";
import { CLAUDE_LABEL, CLAUDE_PROVIDER } from "./identity";
import { screenToolUse } from "./permissions";
import { ClaudeTranslator, describeToolUse, type ResultSummary } from "./translate";
import type { SessionCommandResult } from "../contract";

/**
 * One Archymedes session run by the person's own Claude Code.
 *
 * Fast because the process stays warm: `startup()` spawns Claude Code and finishes its handshake
 * when the session opens (the interface opens it well before the first prompt is typed), and every
 * turn after that is one more message on the same streaming input — no process start per turn, and
 * Claude's prompt cache stays warm between turns. Tokens are passed on as they stream.
 *
 * It plugs into what Archymedes already has rather than beside it:
 * - approvals: Claude Code's permission prompts become the interface's approval dialog;
 * - undo: each turn's message carries an id, and Claude Code's file checkpoints rewind to it;
 * - sessions: the conversation is saved as an Archymedes session (same id, same /resume list),
 *   with Claude Code's own session id, so resuming continues Claude's conversation natively;
 * - switching models: a session that was on another model hands its transcript over, and Claude is
 *   told what was said before.
 *
 * If Claude Code exits (killed, crashed, updated under it), the next turn starts it again, resuming
 * the same Claude session.
 */

/** Archymedes's modes, as Claude Code's permission modes. Defender asks like build does. */
export const PERMISSION_MODES: Record<ArchymedesMode, PermissionMode> = { plan: "plan", build: "default", auto: "acceptEdits", defender: "default" };

export { MAX_PREFACE_CHARS, prefaceFrom } from "../handoff";

export type ClaudeSessionOptions = {
  root: string;
  sdk: ClaudeSdk;
  executable: string;
  /** The environment Claude Code runs in (see `claudeEnvironment`). */
  environment: Record<string, string | undefined>;
  mode: ArchymedesMode;
  /** An alias ("opus", "sonnet") or a model id; undefined is Claude Code's own default. */
  model?: string;
  /** The session to continue: a Claude one resumes; another model's is told to Claude. */
  record?: SessionRecord;
  onEvent: (event: ArchymedesEvent) => void;
  approve: (request: AcpApprovalRequest) => Promise<PermissionDecision>;
  /** Claude Code's AskUserQuestion, put to the person; absent, it goes through `approve` like any tool. */
  ask?: AskUser;
  save?: (record: SessionRecord) => Promise<unknown>;
  warn?: (message: string) => void;
  /** The person's command rules (`.archymedes/rules.json`, then their own); read from disk when absent. */
  commandRules?: () => Promise<readonly CommandRule[]>;
  /** Told the models Claude Code offers, once it has started: what the model pickers then list. */
  onModels?: (models: string[]) => void;
  /** Build test first (`ARCHYMEDES_TEST_FIRST`): Claude Code is told the same order of work Friday follows. */
  testFirst?: boolean;
};

type Turn = { resolve: (result: Pick<AgentRuntimeResult, "status" | "summary">) => void; prompt: string; cancelled: boolean; steers: string[] };

export class ClaudeSession {
  readonly kind = "claude" as const;
  private readonly translator: ClaudeTranslator;
  private record: SessionRecord;
  private mode: ArchymedesMode;
  private model: string | undefined;
  private process?: Promise<{ query: Query; input: InputQueue<SdkUserMessage> }>;
  private turn?: Turn;
  private preface: string;
  /** The message id of each turn, newest last: what /undo rewinds files to. */
  private readonly turnIds: Array<{ id: string; title: string }> = [];
  /** Tools refused for the rest of the session ("deny from now on"). */
  private readonly refused = new Set<string>();
  /** Read once, on the first tool that asks: rules changed mid-session apply from the next session. */
  private rules?: Promise<readonly CommandRule[]>;
  private stderr = "";
  private disposed = false;

  constructor(private readonly options: ClaudeSessionOptions) {
    this.translator = new ClaudeTranslator(options.root);
    this.mode = options.mode;
    this.model = options.model;
    this.record = options.record ? structuredClone(options.record) : newRecord(options.root, options.mode);
    this.record.modelSelection = { provider: CLAUDE_PROVIDER, model: this.model ?? "default" };
    // A conversation Claude has not seen (it was on another model, or Claude's own copy is gone)
    // is told to it once, before the first new prompt.
    this.preface = handoffPreface(this.record, CLAUDE_PROVIDER, Boolean(this.record.claudeSession));
  }

  get id(): string {
    return this.record.id;
  }

  /**
   * Starts Claude Code now, so the first prompt does not wait for it. Resolves once it is ready;
   * rejects with what went wrong (the session is then unusable, and says why).
   */
  async open(): Promise<void> {
    await this.start();
  }

  async send(prompt: string): Promise<Pick<AgentRuntimeResult, "status" | "summary">> {
    if (this.turn) throw new Error("A turn is already running in this session");
    if (this.disposed) throw new Error("This session is closed");
    // The turn is claimed before anything is awaited, so a second prompt sent meanwhile is refused
    // rather than taking the first one's place.
    let resolve!: Turn["resolve"];
    const done = new Promise<Pick<AgentRuntimeResult, "status" | "summary">>((settle) => { resolve = settle; });
    const turn: Turn = { resolve, prompt, cancelled: false, steers: [] };
    this.turn = turn;
    this.translator.begin();
    let input: InputQueue<SdkUserMessage>;
    try {
      ({ input } = await this.start());
    } catch (error) {
      this.turn = undefined;
      throw error;
    }
    if (turn.cancelled || this.turn !== turn) {
      this.endTurn(undefined); // stopped while Claude Code was still starting
      return done;
    }
    const id = randomUUID();
    this.turnIds.push({ id, title: titleFromObjective(prompt) });
    input.push({ type: "user", message: { role: "user", content: this.preface ? `${this.preface}\n\n${prompt}` : prompt }, parent_tool_use_id: null, uuid: id });
    return done;
  }

  /**
   * A message for the running turn. Taken only while one of Claude's tools runs: Claude Code then
   * reads it after that tool and answers it within the same turn (checked live with Claude Code
   * 2.1). At any other moment it could arrive after Claude has finished and start a turn of its
   * own, so the answer is no and the message waits for the next turn instead.
   */
  steer(text: string): boolean {
    const turn = this.turn;
    if (!turn || turn.cancelled || !this.translator.toolRunning || !this.process) return false;
    turn.steers.push(text);
    void this.process.then(({ input }) => input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: randomUUID() }));
    return true;
  }

  cancel(): void {
    if (!this.turn || this.turn.cancelled) return;
    this.turn.cancelled = true;
    void this.process?.then(({ query }) => query.interrupt()).catch(() => undefined);
  }

  async setMode(mode: ArchymedesMode): Promise<void> {
    if (mode === this.mode) return;
    if (this.process) await (await this.process).query.setPermissionMode(PERMISSION_MODES[mode]);
    this.mode = mode;
    this.record.mode = mode;
  }

  /** Another Claude model; `provider` is always Claude here (switching away is the caller's). */
  async setModel(_provider: string, model?: string): Promise<void> {
    const next = !model || model === "default" ? undefined : model;
    if (this.process) await (await this.process).query.setModel(next);
    this.model = next;
    this.record.modelSelection = { provider: CLAUDE_PROVIDER, model: next ?? "default" };
  }

  async command(command: string, argument: string): Promise<SessionCommandResult> {
    switch (command) {
      case "undo":
        return this.undo(argument);
      case "cost":
        return { kind: "text", text: this.costReport() };
      case "todos":
        return this.translator.todos.length > 0 ? { kind: "todos", items: this.translator.todos } : { kind: "text", text: "No plan yet." };
      case "tools":
        return { kind: "text", text: this.translator.tools.length > 0 ? `${this.translator.tools.length} tools (Claude Code's)\n${this.translator.tools.join("\n")}` : "Claude Code lists its tools when the first turn starts." };
      case "diff":
        return { kind: "text", text: "Claude's edits are in Changes (F10), file by file, against the last commit." };
      case "memory":
        return { kind: "text", text: "Claude Code keeps its own memory (CLAUDE.md files); /memory is for Friday's models." };
      default:
        return { kind: "error", text: `/${command} is not available while Claude runs this session.` };
    }
  }

  history(): SessionRecord["messages"] {
    return this.record.messages;
  }

  info(): Record<string, JsonValue> {
    return {
      sessionId: this.record.id, provider: CLAUDE_PROVIDER, providerLabel: CLAUDE_LABEL,
      model: this.translator.model ?? this.model ?? "default", mode: this.mode,
      root: this.options.root, workspace: "local", workspaceLabel: this.options.root,
    };
  }

  /** The transcript as an Archymedes session, for handing to another model. */
  snapshot(): SessionRecord {
    return structuredClone({ ...this.record, ...(this.translator.sessionId ? { claudeSession: this.translator.sessionId } : {}) });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    const running = this.process;
    this.process = undefined;
    if (!running) return;
    const started = await running.catch(() => undefined);
    started?.input.end();
    started?.query.close();
  }

  /** The running process, started (or restarted after an exit) when there is none. */
  private start(): Promise<{ query: Query; input: InputQueue<SdkUserMessage> }> {
    this.process ??= this.spawn().catch((error: unknown) => {
      this.process = undefined;
      throw error;
    });
    return this.process;
  }

  private async spawn(): Promise<{ query: Query; input: InputQueue<SdkUserMessage> }> {
    const resume = this.translator.sessionId ?? this.record.claudeSession;
    let warm: WarmQuery;
    try {
      warm = await this.startup(resume);
    } catch (error) {
      if (!resume) throw this.explain(error);
      // Claude's copy of the conversation is gone (another machine, a cleared ~/.claude): carry on
      // with a new one, told what was said.
      this.options.warn?.(`archymedes: Claude session ${resume} could not be resumed (${message(error)}); starting a new one`);
      delete this.record.claudeSession;
      this.translator.sessionId = undefined;
      this.preface = prefaceFrom(this.record.messages);
      warm = await this.startup(undefined).catch((retry: unknown) => { throw this.explain(retry); });
    }
    const input = new InputQueue<SdkUserMessage>();
    const query = warm.query(input);
    void this.read(query);
    if (this.options.onModels) {
      query.supportedModels().then((models) => this.options.onModels?.(models.map((model) => model.value)), () => undefined);
    }
    return { query, input };
  }

  private startup(resume: string | undefined): Promise<WarmQuery> {
    this.stderr = "";
    return this.options.sdk.startup({
      initializeTimeoutMs: 60_000,
      options: {
        cwd: this.options.root,
        pathToClaudeCodeExecutable: this.options.executable,
        env: this.options.environment,
        ...(this.model ? { model: this.model } : {}),
        permissionMode: PERMISSION_MODES[this.mode],
        canUseTool: this.canUseTool,
        includePartialMessages: true,
        enableFileCheckpointing: true,
        // Claude Code's own system prompt, tools and project instructions (CLAUDE.md): this is
        // Claude Code doing the work, not a model under Archymedes's prompt.
        systemPrompt: { type: "preset", preset: "claude_code", ...(this.options.testFirst ? { append: TEST_FIRST_BRIEF } : {}) },
        ...(resume ? { resume } : {}),
        stderr: (data) => { this.stderr = (this.stderr + data).slice(-4_000); },
      },
    });
  }

  /** Every message of the process's life; a turn ends at its `result`, the process at the end. */
  private async read(query: Query): Promise<void> {
    try {
      for await (const message of query) this.receive(message);
      this.endTurn(undefined, "Claude Code exited.");
    } catch (error) {
      this.endTurn(undefined, `Claude Code stopped: ${message(error)}${this.stderrTail()}`);
    }
    // Gone: the next turn starts a new process, resuming this conversation.
    if (this.process && (await this.process.catch(() => undefined))?.query === query) this.process = undefined;
  }

  private receive(message: SdkMessage): void {
    if (!this.turn) {
      this.translator.feed(message); // between turns: session facts (init) only, nothing to show
      return;
    }
    if (message.type === "result") {
      this.endTurn(message as ResultSummary);
      return;
    }
    for (const event of this.translator.feed(message)) this.options.onEvent(event);
  }

  private endTurn(result: ResultSummary | undefined, error?: string): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    const { events, outcome } = this.translator.finish(result, { cancelled: turn.cancelled, ...(error ? { error } : {}) });
    for (const event of events) this.options.onEvent(event);
    if (outcome.status !== "failed" || outcome.text) this.preface = ""; // Claude has now seen it
    void this.remember(turn.prompt, outcome.text, turn.steers).finally(() => turn.resolve({ status: outcome.status, summary: outcome.summary }));
  }

  /** The turn, saved as Archymedes saves any session: the prompt, the reply, Claude's session id. */
  private async remember(prompt: string, reply: string, steers: readonly string[] = []): Promise<void> {
    const record = this.record;
    record.messages = [
      ...record.messages,
      { role: "user", content: prompt },
      ...steers.map((text) => ({ role: "user" as const, content: `[Sent while you were working] ${text}` })),
      ...(reply.trim() ? [{ role: "assistant" as const, content: reply }] : []),
    ];
    if (record.title === "Untitled session") record.title = titleFromObjective(prompt);
    if (this.translator.sessionId) record.claudeSession = this.translator.sessionId;
    markSeen(record, CLAUDE_PROVIDER);
    record.mode = this.mode;
    const save = this.options.save ?? saveSession;
    try {
      await save(record);
    } catch (error) {
      // The engine before this one saved last, and this copy predates it. This session is the only
      // writer now, so it takes the stored revision and saves over it once.
      const stored = /revision conflict/i.test(message(error)) ? await loadSession(record.root, record.id).catch(() => null) : null;
      if (stored) {
        record.revision = stored.revision;
        await save(record).catch((retry: unknown) => this.options.warn?.(`archymedes: could not save the session: ${message(retry)}`));
      } else this.options.warn?.(`archymedes: could not save the session: ${message(error)}`);
    }
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, { suggestions, toolUseID, title }) => {
    if (this.refused.has(toolName)) return { behavior: "deny", message: `${toolName} was refused for the rest of this session.` };
    if (toolName === "AskUserQuestion" && this.options.ask) return askUserQuestion(this.options.ask, input, toolUseID);
    const screened = screenToolUse(toolName, input, this.mode, await this.commandRules());
    if (screened?.behavior === "allow") return { behavior: "allow", updatedInput: input };
    if (screened) return screened;
    const shown = describeToolUse(toolName, input, this.options.root);
    const decision = await this.options.approve({ toolName: shown.name, toolCallId: toolUseID, summary: title ?? toolCallTitle(shown.name, shown.args) });
    switch (decision) {
      case "allow":
        return { behavior: "allow", updatedInput: input };
      case "allow_always":
      case "allow_pattern":
        return { behavior: "allow", updatedInput: input, updatedPermissions: forThisSession(suggestions) };
      case "deny_always":
        this.refused.add(toolName);
        return { behavior: "deny", message: "The person refused this, and anything more from this tool, for this session." };
      default:
        return { behavior: "deny", message: "The person refused this." };
    }
  };

  private commandRules(): Promise<readonly CommandRule[]> {
    this.rules ??= (this.options.commandRules?.() ?? loadCommandRules(this.options.root, process.env).then((loaded) => loaded.rules)).catch(() => []);
    return this.rules;
  }

  private async undo(argument: string): Promise<SessionCommandResult> {
    if (argument === "conversation") return { kind: "text", text: "Claude keeps its conversation; /undo code puts back the files it changed." };
    if (argument !== "" && argument !== "code") return { kind: "error", text: `/undo takes no argument, "code", or "conversation" — not "${argument}".` };
    if (this.turn) return { kind: "error", text: "Wait for the turn to finish, or stop it, before undoing." };
    const last = this.turnIds.at(-1);
    if (!last || !this.process) return { kind: "text", text: "Nothing to undo." };
    const { query } = await this.process;
    const preview = await query.rewindFiles(last.id, { dryRun: true });
    if (!preview.canRewind) return { kind: "error", text: preview.error ?? "Claude Code could not put the files back." };
    const done = await query.rewindFiles(last.id);
    if (!done.canRewind) return { kind: "error", text: done.error ?? "Claude Code could not put the files back." };
    this.turnIds.pop();
    const files = preview.filesChanged?.length ?? 0;
    return { kind: "text", text: files === 0 ? `Nothing Claude edited in "${last.title}" needed putting back.` : `Put back ${files === 1 ? "the file" : `${files} files`} Claude changed in "${last.title}". (Commands it ran are not undone.)` };
  }

  private costReport(): string {
    const totals = this.translator.totals;
    const lines = [
      `${totals.calls} model calls · ${totals.input.toLocaleString("en-US")} tokens in (${totals.cacheRead.toLocaleString("en-US")} from cache) · ${totals.output.toLocaleString("en-US")} out`,
      `Billed to your Claude plan, not per token (Claude Code's API-price estimate: $${totals.costUsd.toFixed(2)}).`,
    ];
    const limit = this.translator.rateLimit;
    if (limit?.utilization !== undefined) lines.push(`Plan usage: ${Math.round(limit.utilization * 100)}% of the ${limit.rateLimitType === "five_hour" ? "five-hour" : "current"} limit.`);
    return lines.join("\n");
  }

  private explain(error: unknown): Error {
    return new Error(`Claude Code did not start: ${message(error)}${this.stderrTail()}`);
  }

  private stderrTail(): string {
    const last = this.stderr.trim().split("\n").at(-1);
    return last ? ` (${last.slice(0, 300)})` : "";
  }
}

/** "Always allow" lasts for this session, as Archymedes's own approvals do, never written to a settings file. */
function forThisSession(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] | undefined {
  return suggestions?.map((suggestion) => ({ ...suggestion, destination: "session" }));
}

function newRecord(root: string, mode: ArchymedesMode): SessionRecord {
  const now = Date.now();
  return { schemaVersion: 2, revision: 0, id: newSessionId(), createdAt: now, updatedAt: now, root, title: "Untitled session", messages: [], mode, approvals: {}, totalRwf: 0 };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An async iterable fed by `push`: Claude Code's streaming input, one prompt per turn. */
export class InputQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting?: (result: IteratorResult<T>) => void;
  private ended = false;

  push(item: T): void {
    if (this.ended) throw new Error("The input has ended");
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = undefined;
      wake({ value: item, done: false });
    } else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiting = resolve; });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/**
 * Claude Code's AskUserQuestion, answered by the person: each question in turn, and the answers
 * handed back as the tool's `answers` input (question text to the chosen label, as Claude Code
 * reads them). A dismissed question is a refusal, so Claude carries on rather than waiting.
 */
export async function askUserQuestion(ask: AskUser, input: Record<string, unknown>, toolCallId: string): Promise<PermissionResult> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers: Record<string, string> = {};
  for (const entry of questions) {
    if (typeof entry !== "object" || entry === null) continue;
    const { question, options, multiSelect } = entry as { question?: unknown; options?: unknown; multiSelect?: unknown };
    if (typeof question !== "string" || !question.trim()) continue;
    const labels = (Array.isArray(options) ? options : [])
      .map((option) => (typeof option === "string" ? option : typeof option === "object" && option !== null ? (option as { label?: unknown }).label : undefined))
      .filter((label): label is string => typeof label === "string" && label.trim() !== "");
    const answer = await ask({ question, options: labels, multiSelect: multiSelect === true && labels.length > 1, toolCallId });
    if (answer === null) return { behavior: "deny", message: "The person dismissed the question without answering. Carry on with your best judgment and say what you assumed." };
    answers[question] = answer;
  }
  return { behavior: "allow", updatedInput: { ...input, answers } };
}
