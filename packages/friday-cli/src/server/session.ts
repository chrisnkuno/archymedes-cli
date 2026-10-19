import type { AcpApprovalRequest, AcpSession, JsonValue } from "@archymedes/core/cli/acp";
import { ArchymedesAgent, type ArchymedesEvent } from "@archymedes/core/cli/agent";
import { LocalWorkspace, type ArchymedesWorkspace } from "@archymedes/core/cli/backends";
import { CostLedger } from "@archymedes/core/cli/cost";
import { createLspEditDiagnostics } from "@archymedes/core/cli/edit-diagnostics";
import type { ArchymedesMode, PermissionDecision } from "@archymedes/core/cli/permissions";
import type { AskUser } from "@archymedes/core/cli/tools";
import { listSessions, loadSession, type SessionRecord } from "@archymedes/core/cli/session";
import { forkSession } from "@archymedes/core/cli/session-fork";
import { acquireSessionLease, sessionHolder, type SessionLease } from "@archymedes/core/cli/session-lease";
import { reasoningFromEnvironment } from "@archymedes/core/effort-policy";
import { createExaClient } from "@archymedes/core/providers/exa";
import { createWebSearch } from "@archymedes/core/providers/web-search";
import { runSessionCommand } from "./session-commands";
import { claudeIsDefault, claudeModel, claudeRuntime, learnClaudeModels } from "../engines/claude/backend";
import { CLAUDE_PROVIDER } from "../engines/claude/identity";
import { ClaudeSession } from "../engines/claude/session";
import { codexEnvironment, codexIsDefault, codexModel, codexReadiness, learnCodexModels } from "../engines/codex/backend";
import { CODEX_PROVIDER } from "../engines/codex/identity";
import { CodexSession } from "../engines/codex/session";
import { jevOptionsFromEnvironment } from "../setup/jev";
import { resolveSessionProvider } from "../setup/session-provider";

/**
 * One ACP session, on whichever engine runs it: Archymedes's own agent (any model provider), or
 * the person's Claude Code (their Claude subscription).
 *
 * The client sees one session with one id throughout. Switching engines (`setModel` to or from
 * "claude") builds the other engine first, from this one's transcript, and only then retires this
 * one: a switch that cannot happen (Claude not signed in, a provider without a key) leaves the
 * session exactly as it was.
 */

/** Which engine runs a session: Archymedes's own agent, or the person's Claude Code or Codex. */
export type EngineKind = "archymedes" | "claude" | "codex";

export type SessionEngine = AcpSession & {
  readonly kind: EngineKind;
  /** The transcript as a session record, to hand to the next engine. */
  snapshot(): SessionRecord;
};

export type SessionContext = {
  root: string;
  environment: Record<string, string | undefined>;
  /** `--provider`/`--model` from the command line. */
  provider?: string;
  model?: string;
  mode: ArchymedesMode;
  onEvent: (event: ArchymedesEvent) => void;
  approve: (request: AcpApprovalRequest) => Promise<PermissionDecision>;
  /** Questions to the person, when the client can show them (`ask_user`; Claude's AskUserQuestion). */
  ask?: AskUser;
  createWorkspace?: () => Promise<{ workspace: ArchymedesWorkspace } | { error: string }>;
  warn?: (message: string) => void;
  /** For tests: how a Claude engine is built. */
  claude?: (context: SessionContext, record: SessionRecord | undefined, mode: ArchymedesMode, model: string | undefined) => Promise<SessionEngine>;
  /** For tests: how a Codex engine is built. */
  codex?: (context: SessionContext, record: SessionRecord | undefined, mode: ArchymedesMode, model: string | undefined) => Promise<SessionEngine>;
};

export async function openSession(context: SessionContext, resumeSessionId?: string): Promise<AcpSession> {
  let record: SessionRecord | undefined;
  let notice: string | undefined;
  let lease: SessionLease | undefined;
  if (resumeSessionId) {
    // "latest" is the most recent session in this project that no other terminal has open, as
    // `--resume` means on the command line.
    const listed = resumeSessionId === "latest" ? await listSessions(context.root, 50) : [];
    const id = resumeSessionId === "latest" ? await newestFree(context.root, listed) ?? listed[0]?.id : resumeSessionId;
    record = id ? (await loadSession(context.root, id)) ?? undefined : undefined;
    if (!record) throw new Error(resumeSessionId === "latest" ? `No earlier session in ${context.root}` : `No stored session ${resumeSessionId} in ${context.root}`);
    const taken = await acquireSessionLease(context.root, record.id);
    if ("lease" in taken) {
      lease = taken.lease;
    } else {
      // Open in another terminal: carry on in a copy of it, so the two never write one conversation
      // or share what was allowed in it.
      const original = record;
      record = await forkSession(original, undefined, { freshApprovals: true });
      notice = `"${original.title}" is open in another terminal (pid ${taken.heldBy.pid}), so this is a copy of it: ${record.id}. Approvals start fresh here.`;
    }
  }
  const mode = context.mode;
  const kind = startingEngine(context, record);
  let engine: SessionEngine;
  try {
    engine = kind === "claude"
      ? await (context.claude ?? claudeEngine)(context, record, record?.mode ?? mode, context.provider === CLAUDE_PROVIDER ? context.model : claudeModel(context.environment))
      : kind === "codex"
        ? await (context.codex ?? codexEngine)(context, record, record?.mode ?? mode, context.provider === CODEX_PROVIDER ? context.model : codexModel(context.environment))
        : await archymedesEngine(context, { record, mode, provider: context.provider, model: context.model, resume: record?.id });
  } catch (error) {
    await lease?.release();
    throw error;
  }
  if (!lease) {
    // A new session, or the copy: an id nobody else can have open yet.
    const taken = await acquireSessionLease(context.root, engine.id);
    if ("lease" in taken) lease = taken.lease;
  }
  return new SwitchingSession(engine, context, mode, lease, notice);
}

/** The newest listed session no other terminal holds. */
async function newestFree(root: string, sessions: ReadonlyArray<{ id: string }>): Promise<string | undefined> {
  for (const session of sessions) if (!(await sessionHolder(root, session.id))) return session.id;
  return undefined;
}

/** The sessions listed, each marked when another terminal has it open. */
export async function withOpenElsewhere<T extends { id: string }>(root: string, sessions: readonly T[]): Promise<Array<T & { openElsewhere?: boolean }>> {
  return Promise.all(sessions.map(async (session) => {
    const holder = await sessionHolder(root, session.id);
    return holder && holder.pid !== process.pid ? { ...session, openElsewhere: true } : session;
  }));
}

/** The engine a provider id names. */
export function engineFor(provider: string | undefined): EngineKind {
  return provider === CLAUDE_PROVIDER ? "claude" : provider === CODEX_PROVIDER ? "codex" : "archymedes";
}

/** The engine asked for, else the one the stored session ran on, else the default for new ones. */
export function startingEngine(context: Pick<SessionContext, "provider" | "environment">, record: SessionRecord | undefined): EngineKind {
  if (context.provider) return engineFor(context.provider);
  if (record) return engineFor(record.modelSelection?.provider);
  if (claudeIsDefault(context.environment)) return "claude";
  return codexIsDefault(context.environment) ? "codex" : "archymedes";
}

class SwitchingSession implements AcpSession {
  constructor(
    private engine: SessionEngine,
    private readonly context: SessionContext,
    private mode: ArchymedesMode,
    /** This terminal's hold on the session (session-lease.ts), released when it closes. */
    private readonly lease?: SessionLease,
    /** Said once, with the session's first description: why it is not the one asked for. */
    private notice?: string,
  ) {}

  get id(): string { return this.engine.id; }
  send(prompt: string) { return this.engine.send(prompt); }
  cancel(): void { this.engine.cancel(); }
  async dispose(): Promise<void> {
    try {
      await this.engine.dispose();
    } finally {
      await this.lease?.release();
    }
  }
  history() { return this.engine.history?.() ?? []; }
  info(): Record<string, JsonValue> {
    const info = this.engine.info?.() ?? {};
    const notice = this.notice;
    this.notice = undefined;
    return notice ? { ...info, notice } : info;
  }
  steer(text: string): boolean { return this.engine.steer?.(text) ?? false; }

  async command(command: string, argument: string): Promise<JsonValue> {
    // Forking copies the record, whichever engine wrote it; the client then opens the copy.
    if (command === "fork") {
      const fork = await forkSession(this.engine.snapshot());
      return { kind: "forked", id: fork.id, title: fork.title };
    }
    if (!this.engine.command) throw new Error("This session has no commands");
    return this.engine.command(command, argument);
  }

  async setMode(mode: ArchymedesMode): Promise<void> {
    await this.engine.setMode(mode);
    this.mode = mode;
  }

  async setModel(provider: string, model?: string): Promise<void> {
    const target = engineFor(provider);
    if (target === this.engine.kind) {
      if (!this.engine.setModel) throw new Error("This session cannot switch models");
      await this.engine.setModel(provider, model);
      return;
    }
    const record = this.engine.snapshot();
    const next = target === "claude"
      ? await (this.context.claude ?? claudeEngine)(this.context, record, this.mode, model)
      : target === "codex"
        ? await (this.context.codex ?? codexEngine)(this.context, record, this.mode, model)
        : await archymedesEngine({ ...this.context, createWorkspace: undefined }, { record, mode: this.mode, provider, model });
    const previous = this.engine;
    this.engine = next;
    await previous.dispose().catch((error: unknown) => this.context.warn?.(`archymedes: retiring the previous engine: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/** The person's Claude Code, started now so the first prompt finds it warm. */
async function claudeEngine(context: SessionContext, record: SessionRecord | undefined, mode: ArchymedesMode, model: string | undefined): Promise<SessionEngine> {
  if (context.createWorkspace) throw new Error("Claude runs Claude Code on this machine; it cannot work in a --sandbox workspace.");
  const runtime = await claudeRuntime({ environment: context.environment, processEnvironment: process.env as Record<string, string | undefined> });
  if ("error" in runtime) throw new Error(runtime.error);
  const { signedIn, ...start } = runtime;
  const session = new ClaudeSession({
    root: context.root, ...start, mode, record,
    ...(model && model !== "default" ? { model } : {}),
    onEvent: context.onEvent, approve: context.approve, ...(context.ask ? { ask: context.ask } : {}), warn: context.warn, onModels: learnClaudeModels,
  });
  // Claude Code starts while the sign-in is checked: the two take about the same time.
  const [auth, failed] = await Promise.all([signedIn, session.open().then(() => undefined, (error: unknown) => error)]);
  if (!auth.loggedIn) {
    await session.dispose();
    throw new Error("Claude is not ready: it needs signing in to Claude (claude auth login). Open Providers (alt+p) and choose Claude.");
  }
  if (failed) throw failed;
  return session;
}

/** The person's Codex, started now (its first start takes seconds) so the first prompt finds it warm. */
async function codexEngine(context: SessionContext, record: SessionRecord | undefined, mode: ArchymedesMode, model: string | undefined): Promise<SessionEngine> {
  if (context.createWorkspace) throw new Error("Codex runs on this machine in its own sandbox; it cannot work in a --sandbox workspace.");
  const readiness = await codexReadiness({ environment: context.environment, processEnvironment: process.env as Record<string, string | undefined> });
  if (!readiness.ready) throw new Error(`Codex is not ready: it needs ${readiness.missing}. Open Providers (alt+p) and choose Codex.`);
  const session = new CodexSession({
    root: context.root, executable: readiness.executable, environment: codexEnvironment(process.env as Record<string, string | undefined>), mode, record,
    ...(model && model !== "default" ? { model } : {}),
    onEvent: context.onEvent, approve: context.approve, ...(context.ask ? { ask: context.ask } : {}), warn: context.warn, onModels: learnCodexModels,
  });
  await session.open();
  return session;
}

/**
 * Archymedes's own agent on a model provider. A mode or model change within it rebuilds the agent
 * under the new capability set and carries the transcript across, exactly as `/mode` does in the
 * terminal: plan mode is a mode in which the write tools are not loaded, decided when they are built.
 */
async function archymedesEngine(
  context: SessionContext,
  start: { record?: SessionRecord; mode: ArchymedesMode; provider?: string; model?: string; resume?: string },
): Promise<SessionEngine> {
  const { root, environment, onEvent, approve } = context;
  // A record from another engine is continued under the provider asked for; a resumed Archymedes
  // session restores its own (free mode in particular).
  const first = await resolveSessionProvider(environment, { root, resume: start.resume, provider: start.provider, model: start.model });
  if ("error" in first) throw new Error(first.error);
  let resolved = first;
  // What the session spends, priced in the model's own currency (no FX here: the client shows the
  // provider's figure), recorded turn by turn as the terminal CLI's ledger is.
  const ledger = new CostLedger({ prices: resolved.prices, display: resolved.prices?.currency ?? "USD" });
  let mode = start.mode;
  const started = context.createWorkspace ? await context.createWorkspace() : { workspace: new LocalWorkspace(root) };
  if ("error" in started) throw new Error(started.error);
  const workspace = started.workspace;
  let agent = build(mode);
  if (start.record) agent.resume(start.record);

  function build(currentMode: ArchymedesMode): ArchymedesAgent {
    const built = new ArchymedesAgent({
      root,
      model: resolved.provider,
      prices: priceCatalogFor(resolved.prices),
      mode: currentMode,
      workspace,
      search: createExaClient(environment),
      webSearch: createWebSearch(environment),
      ...(context.ask ? { ask: context.ask } : {}),
      onEvent,
      jev: jevOptionsFromEnvironment(environment),
      ...(reasoningFromEnvironment(environment) ? { reasoning: reasoningFromEnvironment(environment) } : {}),
      // Language-server diagnostics appended to each edit result, as in the terminal session.
      afterEdit: acpEditDiagnostics(root, workspace, environment),
      approve: async (request) =>
        approve({ toolName: request.tool.name, summary: request.summary, toolCallId: request.call.id, ...(request.pattern ? { pattern: request.pattern } : {}) }),
    });
    // The interface opens the session well before the first prompt is finished: probe the
    // environment now, so the first turn does not wait ~240 ms on it before its first model call.
    built.warmUp();
    return built;
  }

  async function rebuild(change: () => void): Promise<void> {
    const carried = await loadSession(root, agent.sessionId);
    await agent.relinquish();
    change();
    agent = build(mode);
    if (carried) agent.resume(carried);
  }

  return {
    kind: "archymedes",
    get id() { return agent.sessionId; },
    async send(prompt) {
      const startedAt = Date.now();
      const result = await agent.send(prompt);
      ledger.record({ usage: result.usage, iterations: result.iterations, toolCalls: result.toolCallsExecuted, elapsedMs: Date.now() - startedAt });
      return result;
    },
    command: async (command, argument) => runSessionCommand(command, argument, { agent, ledger }),
    cancel: () => agent.cancel(),
    steer: (text) => agent.steer(text),
    async setMode(next) {
      if (next === mode) return;
      await rebuild(() => { mode = next; });
    },
    // Like a mode change: a new agent on the new model, carrying the transcript across. The choice
    // is checked before anything is torn down, so an unusable model leaves the session as it was.
    async setModel(provider, model) {
      const next = await resolveSessionProvider(environment, { root, provider, model });
      if ("error" in next) throw new Error(next.error);
      await rebuild(() => { resolved = next; });
      ledger.setPrices(next.prices);
    },
    dispose: () => agent.dispose(),
    history: () => agent.snapshot().messages,
    snapshot: () => agent.snapshot(),
    info: () => ({ sessionId: agent.sessionId, provider: resolved.spec.id, providerLabel: resolved.spec.label, model: resolved.model, mode, root, workspace: agent.workspaceKind, workspaceLabel: agent.workspaceLabel }),
  };
}

/**
 * The `afterEdit` hook for an ACP session: local workspaces only (a server on this machine cannot
 * see a sandbox's files), and `ARCHYMEDES_EDIT_DIAGNOSTICS=off` disables — the same rule
 * `friday.ts` applies to the terminal session.
 */
export function acpEditDiagnostics(
  root: string,
  workspace: unknown,
  environment: Record<string, string | undefined>,
): ((path: string) => Promise<string | undefined>) | undefined {
  if (!(workspace instanceof LocalWorkspace)) return undefined;
  if (environment.ARCHYMEDES_EDIT_DIAGNOSTICS?.trim().toLowerCase() === "off") return undefined;
  return createLspEditDiagnostics(root);
}

/**
 * The runtime's integer-unit price guard, from the provider's per-million rates.
 *
 * Deliberately the inexact form: the ACP path has no approved currency budget to enforce, so this
 * is only the runaway ceiling, and a catalog of 1/1 would make that ceiling meaningless.
 */
function priceCatalogFor(prices: { inputPerMillion: number; outputPerMillion: number; largeContext?: { aboveInputTokens: number; inputMultiplier: number; outputMultiplier: number } } | undefined) {
  if (!prices) return { inputRatePerMillion: 1, outputRatePerMillion: 1 };
  return {
    inputRatePerMillion: Math.max(1, Math.round(prices.inputPerMillion / 1_000_000)),
    outputRatePerMillion: Math.max(1, Math.round(prices.outputPerMillion / 1_000_000)),
    ...(prices.largeContext ? { largeContext: prices.largeContext } : {}),
  };
}
