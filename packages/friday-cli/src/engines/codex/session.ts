import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentRuntimeResult } from "@archymedes/core/agent-runtime";
import { toolCallTitle, type AcpApprovalRequest, type JsonValue } from "@archymedes/core/cli/acp";
import type { ArchymedesEvent } from "@archymedes/core/cli/agent";
import { CheckpointStore, type GitRunner } from "@archymedes/core/cli/checkpoints";
import type { AskUser } from "@archymedes/core/cli/tools";
import type { ArchymedesMode, PermissionDecision } from "@archymedes/core/cli/permissions";
import { loadSession, newSessionId, saveSession, titleFromObjective, type SessionRecord } from "@archymedes/core/cli/session";

import { handoffPreface, markSeen, prefaceFrom } from "../handoff";
import { CODEX_LABEL, CODEX_PROVIDER } from "./identity";
import { CodexRpc, asRecord, spawnCodexAppServer, type CodexTransport } from "./rpc";
import { CodexTranslator, codexErrorText, unwrapShell } from "./translate";
import type { SessionCommandResult } from "../contract";

/**
 * One Archymedes session run by the person's own Codex, through `codex app-server`.
 *
 * The process starts when the session opens (its first `initialize` can take many seconds) and stays
 * for the session: each turn is one `turn/start` on the same thread, so Codex's prompt cache stays
 * warm. It plugs into what Archymedes has rather than beside it:
 * - approvals: Codex's approval requests become the interface's approval dialog;
 * - modes: plan is Codex's read-only sandbox with no escalation; build asks for anything not known
 *   to be safe; auto lets Codex run inside its workspace sandbox and ask only to leave it;
 * - undo: Archymedes's own checkpoints, taken before every turn, put the files back;
 * - steering: a message sent mid-turn is `turn/steer`ed into it;
 * - sessions: saved as an Archymedes session with `codexThread`, so `/resume` resumes Codex's own
 *   thread; a conversation from another engine is told to Codex once (handoff.ts).
 *
 * If Codex exits, the next turn starts it again and resumes the same thread.
 */

type Turn = { resolve: (result: Pick<AgentRuntimeResult, "status" | "summary">) => void; prompt: string; cancelled: boolean; id?: string; steers: string[] };

type Started = { rpc: CodexRpc; threadId: string; stderr: () => string };

export type CodexSessionOptions = {
  root: string;
  executable: string;
  environment: Record<string, string | undefined>;
  mode: ArchymedesMode;
  /** A model id from Codex's list; undefined is Codex's own default. */
  model?: string;
  record?: SessionRecord;
  onEvent: (event: ArchymedesEvent) => void;
  approve: (request: AcpApprovalRequest) => Promise<PermissionDecision>;
  /** Codex's request_user_input, put to the person; absent, those questions go unanswered. */
  ask?: AskUser;
  save?: (record: SessionRecord) => Promise<unknown>;
  warn?: (message: string) => void;
  onModels?: (models: string[]) => void;
  /** The reasoning effort for the next turn, in Codex's words (`codexEffort`); undefined is Codex's default. */
  effort?: () => string | undefined;
  /** For tests: the app-server's stdio. */
  transport?: () => CodexTransport & { stderr?: () => string };
  git?: GitRunner;
};

/** Archymedes's modes, as Codex's approval policy and sandbox. */
export function codexPolicy(mode: ArchymedesMode, root: string): { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> } {
  if (mode === "plan") return { approvalPolicy: "never", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
  const workspace = { type: "workspaceWrite", writableRoots: [path.resolve(root)], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return { approvalPolicy: mode === "auto" ? "on-request" : "untrusted", sandbox: "workspace-write", sandboxPolicy: workspace };
}

export class CodexSession {
  readonly kind = "codex" as const;
  private readonly translator: CodexTranslator;
  private readonly checkpoints: CheckpointStore;
  private record: SessionRecord;
  private mode: ArchymedesMode;
  private model: string | undefined;
  private process?: Promise<Started>;
  private turn?: Turn;
  private preface: string;
  /** Tools refused for the rest of the session ("deny from now on"). */
  private readonly refused = new Set<string>();
  private disposed = false;

  constructor(private readonly options: CodexSessionOptions) {
    this.translator = new CodexTranslator(options.root);
    this.mode = options.mode;
    this.model = options.model;
    this.record = options.record ? structuredClone(options.record) : newRecord(options.root, options.mode);
    this.record.modelSelection = { provider: CODEX_PROVIDER, model: this.model ?? "default" };
    this.preface = handoffPreface(this.record, CODEX_PROVIDER, Boolean(this.record.codexThread));
    this.checkpoints = new CheckpointStore(options.root, path.join(options.root, ".archymedes", `checkpoint-index-${randomUUID()}`), options.git, () => this.record.id);
    void this.checkpoints.load(this.record.checkpoints ?? []);
  }

  get id(): string {
    return this.record.id;
  }

  /** Starts Codex now, so the first prompt does not wait for it. */
  async open(): Promise<void> {
    await this.start();
  }

  async send(prompt: string): Promise<Pick<AgentRuntimeResult, "status" | "summary">> {
    if (this.turn) throw new Error("A turn is already running in this session");
    if (this.disposed) throw new Error("This session is closed");
    let resolve!: Turn["resolve"];
    const done = new Promise<Pick<AgentRuntimeResult, "status" | "summary">>((settle) => { resolve = settle; });
    const turn: Turn = { resolve, prompt, cancelled: false, steers: [] };
    this.turn = turn;
    this.translator.begin();
    let started: Started;
    try {
      const [ready, checkpoint] = await Promise.all([this.start(), this.checkpoints.capture(titleFromObjective(prompt), `turn_${randomUUID()}`, this.record.messages.length)]);
      started = ready;
      if (checkpoint) this.options.onEvent({ type: "checkpoint", checkpoint });
    } catch (error) {
      this.turn = undefined;
      throw error;
    }
    if (turn.cancelled || this.turn !== turn) {
      this.endTurn(undefined);
      return done;
    }
    const policy = codexPolicy(this.mode, this.options.root);
    const text = this.preface ? `${this.preface}\n\n${prompt}` : prompt;
    const effort = this.options.effort?.();
    started.rpc.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: started.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.sandboxPolicy,
      ...(this.model ? { model: this.model } : {}),
      ...(effort ? { effort } : {}),
    }).then((response) => {
      if (this.turn !== turn) return;
      turn.id = response.turn?.id;
      if (turn.cancelled && turn.id) void started.rpc.request("turn/interrupt", { threadId: started.threadId, turnId: turn.id }).catch(() => undefined);
    }, (error: unknown) => this.endTurn(undefined, `Codex did not start the turn: ${message(error)}`));
    return done;
  }

  cancel(): void {
    const turn = this.turn;
    if (!turn || turn.cancelled) return;
    turn.cancelled = true;
    if (!turn.id) return; // interrupted as soon as Codex says which turn it is
    void this.process?.then(({ rpc, threadId }) => rpc.request("turn/interrupt", { threadId, turnId: turn.id })).catch(() => undefined);
  }

  /** A message for the running turn, steered into it; false when there is no turn Codex can take it into. */
  steer(text: string): boolean {
    const turn = this.turn;
    if (!turn?.id || turn.cancelled || !this.process) return false;
    const expectedTurnId = turn.id;
    turn.steers.push(text);
    void this.process
      .then(({ rpc, threadId }) => rpc.request("turn/steer", { threadId, expectedTurnId, input: [{ type: "text", text, text_elements: [] }] }))
      .catch(() => {
        turn.steers.splice(turn.steers.indexOf(text), 1);
        this.options.onEvent({ type: "steering_unread", messages: [text] });
      });
    return true;
  }

  async setMode(mode: ArchymedesMode): Promise<void> {
    // Applied with the next turn: `turn/start` carries the policy.
    this.mode = mode;
    this.record.mode = mode;
  }

  async setModel(_provider: string, model?: string): Promise<void> {
    this.model = !model || model === "default" ? undefined : model;
    this.record.modelSelection = { provider: CODEX_PROVIDER, model: this.model ?? "default" };
  }

  async command(command: string, argument: string): Promise<SessionCommandResult> {
    switch (command) {
      case "undo":
        return this.undo(argument);
      case "turns":
        return { kind: "turns", turns: this.checkpoints.list().map((checkpoint, index) => ({ index, label: checkpoint.label, createdAt: checkpoint.createdAt })) };
      case "rewind": {
        const [position = "", scope = ""] = argument.trim().split(/\s+/);
        if (!/^\d+$/.test(position) || (scope !== "" && scope !== "code")) return { kind: "error", text: "Codex keeps its own conversation: /rewind <n> code puts the files back to before that turn." };
        return this.restore(Number(position));
      }
      case "diff": {
        const turn = /^turn\s+(\d+)$/.exec(argument.trim());
        const patch = turn ? await this.checkpoints.turnPatch(Number(turn[1])) : await this.checkpoints.diffPatch();
        return patch.trim() ? { kind: "diff", patch } : { kind: "text", text: turn ? "That turn changed no files." : "Nothing changed since the last checkpoint." };
      }
      case "cost": {
        const totals = this.translator.totals;
        return { kind: "text", text: `Codex on your plan: ${totals.calls} model calls, ${totals.input.toLocaleString("en-US")} input tokens (${totals.cacheRead.toLocaleString("en-US")} cached), ${totals.output.toLocaleString("en-US")} output.` };
      }
      case "todos":
        return this.translator.todos.length > 0 ? { kind: "todos", items: this.translator.todos } : { kind: "text", text: "No plan yet." };
      case "compact": {
        const { rpc, threadId } = await this.start();
        await rpc.request("thread/compact/start", { threadId });
        return { kind: "text", text: "Codex is summarizing its conversation." };
      }
      case "tools":
        return { kind: "text", text: "Codex runs its own tools: shell commands, patches, web search and its MCP servers, inside its sandbox." };
      case "memory":
        return { kind: "text", text: "Codex keeps its own instructions (AGENTS.md); /memory is for Friday's models." };
      default:
        return { kind: "error", text: `/${command} is not available while Codex runs this session.` };
    }
  }

  history(): SessionRecord["messages"] {
    return this.record.messages;
  }

  info(): Record<string, JsonValue> {
    return {
      sessionId: this.record.id, provider: CODEX_PROVIDER, providerLabel: CODEX_LABEL,
      model: this.model ?? this.translator.model ?? "default", mode: this.mode,
      root: this.options.root, workspace: "local", workspaceLabel: this.options.root,
    };
  }

  /** The transcript as an Archymedes session, for handing to another engine. */
  snapshot(): SessionRecord {
    return structuredClone({ ...this.record, checkpoints: this.checkpoints.list() });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    const running = this.process;
    this.process = undefined;
    const started = await running?.catch(() => undefined);
    started?.rpc.close();
  }

  private start(): Promise<Started> {
    this.process ??= this.spawn().catch((error: unknown) => {
      this.process = undefined;
      throw error;
    });
    return this.process;
  }

  private async spawn(): Promise<Started> {
    const transport = this.options.transport?.() ?? spawnCodexAppServer(this.options.executable, this.options.root, this.options.environment);
    const stderr = () => transport.stderr?.() ?? "";
    let threadId = "";
    const rpc = new CodexRpc(transport, {
      onNotification: (method, params) => this.receive(method, params, threadId),
      onRequest: (method, params) => this.answer(method, params),
      onExit: (reason) => {
        this.endTurn(undefined, `Codex stopped (${reason}).${tail(stderr())}`);
        void this.process?.then((started) => { if (started.rpc === rpc) this.process = undefined; }, () => undefined);
      },
    });
    try {
      await rpc.request("initialize", { clientInfo: { name: "archymedes", title: "Friday", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } }, 120_000);
      rpc.notify("initialized");
      threadId = await this.thread(rpc);
    } catch (error) {
      rpc.close();
      throw new Error(`Codex did not start: ${message(error)}${tail(stderr())}`);
    }
    if (this.options.onModels) {
      rpc.request<{ data?: Array<{ id?: string; hidden?: boolean }> }>("model/list", {}).then(
        (listed) => this.options.onModels?.((listed.data ?? []).filter((model) => !model.hidden && model.id).map((model) => String(model.id))),
        () => undefined,
      );
    }
    return { rpc, threadId, stderr };
  }

  /** Resumes this session's Codex thread, or starts one (told what was said) when there is none. */
  private async thread(rpc: CodexRpc): Promise<string> {
    const policy = codexPolicy(this.mode, this.options.root);
    const common = { cwd: this.options.root, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, ...(this.model ? { model: this.model } : {}) };
    const resume = this.record.codexThread;
    if (resume) {
      try {
        const resumed = asRecord(await rpc.request("thread/resume", { threadId: resume, ...common, excludeTurns: true }));
        this.translator.model = typeof resumed.model === "string" ? resumed.model : this.translator.model;
        return resume;
      } catch (error) {
        this.options.warn?.(`archymedes: Codex thread ${resume} could not be resumed (${message(error)}); starting a new one`);
        delete this.record.codexThread;
        this.preface = prefaceFrom(this.record.messages);
      }
    }
    const started = asRecord(await rpc.request("thread/start", common));
    this.translator.model = typeof started.model === "string" ? started.model : undefined;
    const id = String(asRecord(started.thread).id ?? "");
    if (!id) throw new Error("Codex started no thread");
    this.record.codexThread = id;
    return id;
  }

  private receive(method: string, params: Record<string, unknown>, threadId: string): void {
    if (threadId && typeof params.threadId === "string" && params.threadId !== threadId) return; // another thread
    if (!this.turn) {
      this.translator.feed(method, params); // between turns: facts only, nothing to show
      return;
    }
    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      const error = asRecord(turn.error);
      this.endTurn({ status: String(turn.status ?? ""), ...(typeof error.message === "string" ? { error: error.message } : {}) });
      return;
    }
    for (const event of this.translator.feed(method, params)) this.options.onEvent(event);
  }

  private endTurn(result: { status?: string; error?: string } | undefined, error?: string): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    const { events, outcome } = this.translator.finish(result, { cancelled: turn.cancelled, ...(error ? { error } : {}) });
    for (const event of events) this.options.onEvent(event);
    if (outcome.status !== "failed" || outcome.text) this.preface = ""; // Codex has now seen it
    void this.remember(turn.prompt, outcome.text, turn.steers).finally(() => turn.resolve({ status: outcome.status, summary: outcome.summary }));
  }

  /** The turn, saved as Archymedes saves any session: the prompt, the reply, Codex's thread. */
  private async remember(prompt: string, reply: string, steers: readonly string[] = []): Promise<void> {
    const record = this.record;
    record.messages = [
      ...record.messages,
      { role: "user", content: prompt },
      ...steers.map((text) => ({ role: "user" as const, content: `[Sent while you were working] ${text}` })),
      ...(reply.trim() ? [{ role: "assistant" as const, content: reply }] : []),
    ];
    if (record.title === "Untitled session") record.title = titleFromObjective(prompt);
    record.checkpoints = this.checkpoints.list();
    markSeen(record, CODEX_PROVIDER);
    record.mode = this.mode;
    const save = this.options.save ?? saveSession;
    try {
      await save(record);
    } catch (failure) {
      const stored = /revision conflict/i.test(message(failure)) ? await loadSession(record.root, record.id).catch(() => null) : null;
      if (stored) {
        record.revision = stored.revision;
        await save(record).catch((retry: unknown) => this.options.warn?.(`archymedes: could not save the session: ${message(retry)}`));
      } else this.options.warn?.(`archymedes: could not save the session: ${message(failure)}`);
    }
  }

  /** Codex asks; the interface's approval dialog answers. */
  private async answer(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const command = unwrapShell(String(params.command ?? ""));
        const decision = await this.ask("run_command", String(params.itemId ?? params.approvalId ?? randomUUID()), { command }, params.reason);
        return { decision: decision === "allow" ? "accept" : decision === "allow_always" || decision === "allow_pattern" ? "acceptForSession" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const itemId = String(params.itemId ?? randomUUID());
        const decision = await this.ask("edit_file", itemId, { path: this.changeTarget(this.translator.pathsOf(itemId)) }, params.reason);
        return { decision: decision === "allow" ? "accept" : decision === "allow_always" || decision === "allow_pattern" ? "acceptForSession" : "decline" };
      }
      // Older Codex versions ask in the first protocol's words.
      case "execCommandApproval": {
        const argv = Array.isArray(params.command) ? params.command.map(String) : [String(params.command ?? "")];
        const decision = await this.ask("run_command", String(params.callId ?? randomUUID()), { command: unwrapShell(argv.join(" ")) }, params.reason);
        return { decision: decision === "allow" ? "approved" : decision === "allow_always" || decision === "allow_pattern" ? "approved_for_session" : { denied: { rejection: "The person refused this." } } };
      }
      case "applyPatchApproval": {
        const decision = await this.ask("edit_file", String(params.callId ?? randomUUID()), { path: this.changeTarget(Object.keys(asRecord(params.fileChanges)).map((file) => path.relative(this.options.root, file) || file)) }, params.reason);
        return { decision: decision === "allow" ? "approved" : decision === "allow_always" || decision === "allow_pattern" ? "approved_for_session" : { denied: { rejection: "The person refused this." } } };
      }
      // Codex's request_user_input (its plan mode asks this way): each question put to the person,
      // answered by question id. A dismissed one is an empty answer, which Codex reads as no input.
      case "item/tool/requestUserInput": {
        const answers: Record<string, { answers: string[] }> = {};
        for (const entry of Array.isArray(params.questions) ? params.questions : []) {
          const question = asRecord(entry);
          const text = String(question.question ?? "").trim();
          const id = String(question.id ?? text);
          if (!text) continue;
          const labels = (Array.isArray(question.options) ? question.options : []).map((option) => String(asRecord(option).label ?? "")).filter(Boolean);
          const answer = this.options.ask ? await this.options.ask({ question: text, options: labels, multiSelect: false, toolCallId: String(params.itemId ?? id) }) : null;
          answers[id] = { answers: answer === null ? [] : [answer] };
        }
        return { answers };
      }
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null };
      default:
        throw new Error(`Friday does not answer ${method}; change the mode to give Codex more room.`);
    }
  }

  /** "calc.py", "calc.py and 2 more", or a plain phrase when Codex did not say which files. */
  private changeTarget(paths: string[]): string {
    if (paths.length === 0) return "files in the project";
    return paths.length === 1 ? paths[0] : `${paths[0]} and ${paths.length - 1} more`;
  }

  private async ask(toolName: string, toolCallId: string, args: Record<string, unknown>, reason: unknown): Promise<PermissionDecision> {
    if (this.refused.has(toolName)) return "deny";
    const why = typeof reason === "string" && reason.trim() ? ` — ${reason.trim()}` : "";
    const decision = await this.options.approve({ toolName, toolCallId, summary: `${toolCallTitle(toolName, args)}${why}` });
    if (decision === "deny_always") this.refused.add(toolName);
    return decision;
  }

  private async undo(argument: string): Promise<SessionCommandResult> {
    if (argument === "conversation") return { kind: "text", text: "Codex keeps its conversation; /undo code puts back the files it changed." };
    if (argument !== "" && argument !== "code") return { kind: "error", text: `/undo takes no argument, "code", or "conversation" — not "${argument}".` };
    const count = this.checkpoints.list().length;
    return count === 0 ? { kind: "text", text: "Nothing to undo." } : this.restore(count - 1);
  }

  private async restore(index: number): Promise<SessionCommandResult> {
    if (this.turn) return { kind: "error", text: "Wait for the turn to finish, or stop it, before undoing." };
    const checkpoint = this.checkpoints.at(index);
    if (!checkpoint) return { kind: "error", text: `No turn ${index} to rewind to.` };
    if (!(await this.checkpoints.restore(checkpoint.tree))) return { kind: "error", text: "The files could not be put back." };
    await this.checkpoints.dropFrom(index);
    this.record.checkpoints = this.checkpoints.list();
    return { kind: "text", text: `Put the files back to before "${checkpoint.label}". Codex keeps its conversation: tell it what changed.` };
  }
}

function newRecord(root: string, mode: ArchymedesMode): SessionRecord {
  const now = Date.now();
  return { schemaVersion: 2, revision: 0, id: newSessionId(), createdAt: now, updatedAt: now, root, title: "Untitled session", messages: [], mode, approvals: {}, totalRwf: 0 };
}

function message(error: unknown): string {
  return error instanceof Error ? codexErrorText(error.message) : String(error);
}

function tail(stderr: string): string {
  const lines = stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ");
  return lines ? ` ${lines}` : "";
}
