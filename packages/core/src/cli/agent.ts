import { attachMentionedImages, objectiveWithImageProblems, withoutImageData } from "./image-attachments";
import { HostedRecoveryStore } from "./hosted-recovery";
import { mergeRoutingReceipts } from "../providers/routing-receipt";
import type { RoutingPlan } from "../providers/routing-plan";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { access } from "node:fs/promises";
import { agentMessagePromptParts, BoundedAgentRuntime, type AgentMessage, type AgentRuntimeEvent, type AgentRuntimeResult, type AgentTool, type AgentTurnProvider } from "../agent-runtime";
import { affordableOutputTokens, approximateInputTokens, priceActualModelUsage, type ModelPriceCatalog } from "../model-cost";
import type { ModelUsage } from "../providers/model";
import type { ExaSearchClient } from "../providers/exa";
import { CheckpointStore, type Checkpoint, type GitRunner } from "./checkpoints";
import { capabilitiesForMode, PermissionLedger, type ApprovalPrompt, type ArchymedesMode } from "./permissions";
import { loadMemories, memoryPromptBlock, recallMemories, recalledMemoryKey } from "./memory";
import { probeEnvironment, type EnvironmentReport } from "./environment";
import { buildArchymedesSystemPrompt, collectProjectContext, type ProjectContext } from "./prompt";
import { assertTurnTransition, EventJournal, readEventJournal, runtimeEventForJournal, type TurnStatus } from "./protocol";
import {
  atSafeBoundary,
  buildCompactedMessages,
  COMPACTION_INSTRUCTION,
  compactionUrgency,
  newSessionId,
  planCompaction,
  saveSession,
  appendSessionStep,
  loadSession,
  STANDING_CONSTRAINTS_HEADING,
  titleFromObjective,
  type CompactionBoundary,
  type CompactionUrgency,
  type SessionRecord,
  type StandingConstraints,
} from "./session";
import { loadLocalExternalTooling, type LocalExternalTooling } from "./external-tools";
import type { HookGateOutcome } from "../hooks";
import { NestedInstructionTracker } from "./nested-instructions";
import { createArchymedesTools, scanWorkspaceForSecrets, TodoList, type DelegateResult, type DelegateRunner, type PlacedSecretFinding, type TodoItem } from "./tools";
import type { Expense } from "./cost";
import { predictAgentUsage, type AgentCostPrediction } from "./cost";
import { LocalWorkspace, type ArchymedesWorkspace } from "./backends";
import { WorkspaceArtifactStore } from "./artifacts";
import type { ReadResult, WorkspaceLimits } from "./workspace";
import { DEFAULT_OUTPUT_CEILING } from "../providers/model-capabilities";
import { DefenderBrain } from "./defender-brain";
import { toolProfileForObjective, toolsForProfile } from "./tool-profile";
import { leanToolset, restoreFullHistory, stubEarlierToolResults, tokenSaverBudgets } from "./token-saver";
import { createJevJudge, requestJevVerdict, turnVerdictState, verdictFromResponse, type JevFetch, type JevTurnVerdict, type TurnEvidence } from "./jev";

/**
 * Archymedes CLI's agent: the hosted `BoundedAgentRuntime`, hosted locally instead.
 *
 * This is the whole architectural bet of the CLI. The runtime that drives the hosted product —
 * with its capability scoping, approval gate, budget ceiling, parallel-safe tool execution and
 * context accounting — is not reimplemented here. It is given local tools, a local approval
 * prompt, and git checkpoints instead of a disposable container. Everything the hosted worker
 * proves about safety and cost applies unchanged, and a fix to either host benefits both.
 */

export type ArchymedesAgentOptions = {
  /** Local project directory: where sessions and checkpoints live, whatever the backend is. */
  root: string;
  model: AgentTurnProvider;
  prices: ModelPriceCatalog;
  mode: ArchymedesMode;
  approve: ApprovalPrompt;
  /**
   * Where files are read and written. Defaults to the local project; pass an `E2BWorkspace` to
   * keep the work off this machine entirely.
   */
  workspace?: ArchymedesWorkspace;
  search?: ExaSearchClient;
  git?: GitRunner;
  limits?: WorkspaceLimits;
  /** Reported as the session unfolds: tool calls, model turns, checkpoints. */
  onEvent?: (event: ArchymedesEvent) => void;
  /** Reported when a tool spends money outside the model, so the ledger sees the whole bill. */
  onExpense?: (expense: Expense) => void;
  budgets?: Partial<ArchymedesBudgets>;
  /**
   * Jev (TypeSafe System One) second opinion, consulted after each turn and before each
   * effectful tool call. Absent means off: no key, no calls, no behavior change. A blank
   * key is treated the same as absent, so half-configuration degrades to off rather than
   * to a failure on every turn.
   */
  jev?: { apiKey: string; model?: string; timeoutMs?: number; fetchImpl?: JevFetch; /** Auto-correct on a bad verdict (default true; `ARCHYMEDES_JEV_REVIEW=off` disables). */ review?: boolean };
  /**
   * Called after a successful `edit_file`/`write_file` with the edited path; whatever it returns
   * is appended to that tool result as "Diagnostics after edit:", so the model sees an error it
   * just introduced. Bounded by `EDIT_DIAGNOSTICS_TIMEOUT_MS` and fail-open: a hook that throws,
   * stalls or returns nothing leaves the result unchanged. Absent means off. The CLI wires
   * `createLspEditDiagnostics` (cli/edit-diagnostics.ts) here for a local workspace.
   */
  afterEdit?: (path: string) => Promise<string | undefined>;
};

/** The two delegation tools; neither is ever offered to the sub-agent it creates. */
const DELEGATION_TOOLS = new Set(["delegate_task", "delegate_readonly_task"]);
const EDIT_DIAGNOSTIC_TOOLS = new Set(["edit_file", "write_file"]);
export const EDIT_DIAGNOSTICS_TIMEOUT_MS = 3_000;
const EDIT_DIAGNOSTICS_MAX_LINES = 20;

/**
 * Wraps the built-in edit tools so a successful edit's result carries the file's diagnostics.
 *
 * Done here rather than in `tools.ts` because what reports diagnostics depends on where the
 * workspace is (a language server on this machine cannot see an E2B sandbox), which only the
 * front end constructing the agent knows.
 */
export function withEditDiagnostics(tools: AgentTool[], afterEdit: ((path: string) => Promise<string | undefined>) | undefined): AgentTool[] {
  if (!afterEdit) return tools;
  return tools.map((tool) => {
    if (!EDIT_DIAGNOSTIC_TOOLS.has(tool.name) || (tool.provenance && tool.provenance.kind !== "built-in")) return tool;
    return {
      ...tool,
      async execute(args, context) {
        const result = await tool.execute(args, context);
        if (result.isError) return result;
        const data = result.data as { path?: unknown } | undefined;
        const edited = typeof data?.path === "string" ? data.path : typeof args.path === "string" ? args.path : undefined;
        if (!edited) return result;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const report = await Promise.race([
          afterEdit(edited).catch(() => undefined),
          new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), EDIT_DIAGNOSTICS_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
        const lines = (report ?? "").split(/\r?\n/).filter((line) => line.trim());
        if (lines.length === 0) return result;
        const shown = lines.slice(0, EDIT_DIAGNOSTICS_MAX_LINES);
        if (lines.length > EDIT_DIAGNOSTICS_MAX_LINES) shown.push(`… ${lines.length - EDIT_DIAGNOSTICS_MAX_LINES} more`);
        return { ...result, content: `${result.content}\n\nDiagnostics after edit:\n${shown.join("\n")}` };
      },
    };
  });
}

export type ArchymedesEvent =
  | { type: "runtime"; event: AgentRuntimeEvent }
  | { type: "checkpoint"; checkpoint: Checkpoint }
  // `urgency` and `boundary` say *why* the transcript was compacted here rather than later, which
  // is the only interesting thing about a compaction from outside: at 70% because the work reached
  // a clean stopping point, or at 90% because it had to be.
  | { type: "compaction"; tokensBefore: number; messagesBefore: number; messagesAfter: number; urgency?: CompactionUrgency; boundary?: CompactionBoundary }
  /**
   * Jev's post-turn verdict: where the turn landed, with probabilities.
   *
   * Advisory by design — displayed, never enforced — and fail-open: when Jev is
   * unreachable the event still fires as `unavailable`, so the transcript says so
   * instead of silently skipping the check it promised.
   */
  | { type: "jev-verdict"; verdict: JevTurnVerdict }
  /**
   * The judge's verdict disagreed with the turn's status, so the agent is
   * re-invoked once with the evidence attached. Bounded by one correction
   * per turn, so a judge that always says blocked cannot loop.
   */
  | { type: "jev-review"; outcome: string; probability: number; reason: string };

export type ArchymedesBudgets = {
  maxIterations: number;
  maxToolCalls: number;
  maxToolCallsPerTurn: number;
  maxToolResultChars: number;
  maxTotalToolResultChars: number;
  maxOutputTokens: number;
  /** RWF ceiling for one turn of work, mirroring the hosted product's reservation model. */
  maxRwf: number;
  contextLimit: number;
};

export const DEFAULT_ARCHYMEDES_BUDGETS: ArchymedesBudgets = {
  // Long repository tasks routinely need more than the old 200-call ceiling. These remain hard
  // bounded at the runtime validator's limits and the monetary reservation still caps every model
  // turn, so increasing capacity does not grant unbounded execution or spending.
  maxIterations: 100,
  maxToolCalls: 500,
  maxToolCallsPerTurn: 16,
  maxToolResultChars: 40_000,
  maxTotalToolResultChars: 400_000,
  // Raised from 8,000 because that ceiling was being hit in ordinary work — a long file written in
  // one go, a full plan, or a thinking model whose hidden reasoning shares this same budget. Hitting
  // it is now recoverable (the runtime resumes a `length` turn rather than failing it), but each
  // resumption costs a round trip and re-sends the whole transcript, so the cheaper fix is to let
  // the common case finish in one reply. Well inside every current model's own output limit, and
  // costed only when actually used: the runtime clamps each call to what the remaining budget can
  // afford, so a higher ceiling spends nothing on a short answer.
  maxOutputTokens: 16_000,
  maxRwf: 20_000,
  // The floor, not the answer. A session whose provider reports what its model can hold replaces
  // both this and `maxOutputTokens` with the model's own figures (see the constructor): 200,000 is
  // a fifth of a current Opus or Sonnet window, and compacting at 70% of it threw away a
  // transcript that had not come close to filling anything.
  contextLimit: 200_000,
};

export type ArchymedesTurnResult = AgentRuntimeResult & { checkpoint?: Checkpoint };

/** Which half of a checkpoint to restore. "both" is the historical, sole behaviour of `/undo`. */
export type RestoreScope = "code" | "conversation" | "both";

/** Closes a turn that was saved mid-way and never finished, so the next request is well formed. */
export const INTERRUPTED_TURN_NOTE = "(This turn was interrupted before I replied. The tool results above were recorded; anything after them did not happen. I will check the current state before relying on it.)";

export class ArchymedesAgent {
  private readonly todoList = new TodoList();
  /**
   * A directory's own AGENTS.md, surfaced the first time a tool reaches it. Reads through
   * `this.workspace`, so it works on every backend — the files the agent is working on are the ones
   * whose rules should reach it, whether they live on this machine or in a sandbox.
   */
  private readonly nestedInstructions: NestedInstructionTracker | undefined;
  /**
   * Skills, hooks, plugins and MCP servers discovered from `.archymedes/`, also through `this.workspace`
   * and so also backend-independent. Lazily loaded and memoized on first turn rather than in the
   * constructor — construction stays synchronous, and a session that never sends a turn never pays
   * for discovery or spawns an MCP server it will never use.
   */
  private externalTooling: Promise<LocalExternalTooling | undefined> | null = null;
  private readonly workspace: ArchymedesWorkspace;
  private readonly permissions: PermissionLedger;
  private readonly checkpoints: CheckpointStore;
  private recovery: HostedRecoveryStore;
  private ownershipReady: Promise<void> | undefined;
  /**
   * Where tool results too large for the transcript are written.
   *
   * Through the workspace, so a sandboxed session's artifacts land in the sandbox where the
   * agent's own `read_file` can reach them — an artifact on a host the agent cannot see is a
   * handle to nothing.
   */
  private readonly artifacts: WorkspaceArtifactStore;
  private readonly budgets: ArchymedesBudgets;
  private messages: AgentMessage[] = [];
  /** Memory already carried by this transcript; incremental recall prevents quadratic repetition. */
  private readonly recalledMemoryKeys = new Set<string>();
  /**
   * The request that opened this session, kept whole.
   *
   * Not read back off `messages` on demand, because compaction rewrites the front of the
   * transcript: after one summary the first user message is the constraints block, and after two
   * the original wording is gone entirely. It is the thing every later turn is still in service
   * of, so it is held here and restated at every compaction.
   */
  private openingObjective: string | null = null;
  private context: ProjectContext | null = null;
  /**
   * What is actually installed where commands run, probed once and reused.
   *
   * Per session rather than per turn, unlike `context`: an AGENTS.md can change between turns and
   * must be re-read, but a toolchain does not appear mid-session, and re-probing it would spend a
   * dozen process launches on every message the user sends.
   */
  private environment: Promise<EnvironmentReport> | null = null;
  private cancelled = false;
  /** The active exchange's cancellation reaches provider I/O and local process trees immediately. */
  private turnAbort: AbortController | null = null;
  /**
   * Whether the session's pre-session hook has already run.
   *
   * Fired once per session rather than once per turn: it gates the session itself, so a second
   * firing would re-run a script whose whole purpose was to run before the first turn.
   */
  private sessionHookFired = false;
  private session: SessionRecord;
  private journal: EventJournal;
  private activeTurnId: string | null = null;
  private activeTransition: ((to: TurnStatus, durable?: boolean) => Promise<void>) | null = null;
  /** What `delegate_task` sub-runs have spent this turn — folded into the turn's own total once it finishes. See `createDelegateRunner`. */
  private delegatedRwf = 0;
  /**
   * Reserved by delegations still running. Read-only delegations run concurrently, and each one
   * sizes its reservation from what is left; without subtracting what siblings already hold, two
   * started together would each see the whole remainder and could jointly reserve twice it.
   */
  private delegatedInFlightRwf = 0;
  private delegatedUsage: ModelUsage = emptyModelUsage();
  private readonly defenderBrain: DefenderBrain;
  /** Jev second-opinion configuration, normalized: undefined means the judge is off. Never persisted — the key lives in memory alone. */
  private readonly jev: NonNullable<ArchymedesAgentOptions["jev"]> | undefined;

  /**
   * The budgets the model itself implies, before anything the caller set.
   *
   * A method rather than a constructor-time constant because a provider can learn its model's real
   * limits after the session starts — free mode reads a concrete model's context only with the
   * live catalog, on its first request — so it is re-read at every turn (`refreshModelBudgets`).
   */
  private modelBudgets(): Partial<ArchymedesBudgets> {
    const capabilities = this.options.model.capabilities;
    if (!capabilities) return {};
    // A rationed provider (free mode) asks for lean budgets; see `token-saver.ts`.
    if (this.options.model.tokenSaver) return tokenSaverBudgets(capabilities);
    return {
      contextLimit: capabilities.contextWindow,
      maxOutputTokens: Math.min(capabilities.maxOutputTokens, DEFAULT_OUTPUT_CEILING),
      // Tool-result allowances scale with the window for the same reason the window does: 40,000
      // characters is a sixteenth of a 200K context and a sixtieth of a 1M one, and a fixed
      // number means a bigger model reads *less* of a large file than a smaller one. The shares
      // are chosen to reproduce today's 40,000 / 400,000 exactly at a 200K window, so nothing
      // changes for a model that really is that size.
      maxToolResultChars: Math.round(capabilities.contextWindow * 0.2),
      maxTotalToolResultChars: capabilities.contextWindow * 2,
    };
  }

  /**
   * Re-derives the model's budgets at a turn boundary, keeping the caller's explicit limits and the
   * spend ceiling `setModelSpendLimit` may have moved since the session started.
   */
  private refreshModelBudgets(): void {
    const { maxRwf: _maxRwf, ...callerLimits } = this.options.budgets ?? {};
    Object.assign(this.budgets, this.modelBudgets(), callerLimits);
  }

  /** The environment report for this session, probed on first use and cached. Never throws: a session that cannot describe its environment still runs, just without the section. */
  private loadEnvironment(): Promise<EnvironmentReport | undefined> {
    this.environment ??= probeEnvironment(this.workspace);
    return this.environment.catch(() => undefined);
  }

  constructor(private readonly options: ArchymedesAgentOptions) {
    // Model-derived first, caller-supplied last: a session runs against what its model can really
    // do, while an explicit budget from the caller still overrides everything — that is the whole
    // reason `--budget` and the embedder's own options exist.
    this.budgets = { ...DEFAULT_ARCHYMEDES_BUDGETS, ...this.modelBudgets(), ...options.budgets };
    this.workspace = options.workspace ?? new LocalWorkspace(options.root, options.limits);
    this.nestedInstructions = new NestedInstructionTracker(this.workspace);
    this.artifacts = new WorkspaceArtifactStore(this.workspace);
    this.defenderBrain = new DefenderBrain(path.join(options.root, ".archymedes", "security-brain"));
    this.checkpoints = new CheckpointStore(options.root, path.join(options.root, ".archymedes", `checkpoint-index-${randomUUID()}`), options.git);
    this.session = {
      schemaVersion: 2,
      revision: 0,
      id: newSessionId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      root: options.root,
      title: "Untitled session",
      messages: [],
      mode: options.mode,
      modelSelection: options.model.selection,
      recalledMemoryKeys: [],
      approvals: {},
      totalRwf: 0,
    };
    this.journal = new EventJournal(options.root, this.session.id);
    this.recovery = new HostedRecoveryStore(options.root, this.session.id);
    // A blank key counts as absent: half-configuration degrades to off, not to a failure.
    this.jev = options.jev && options.jev.apiKey.trim() ? options.jev : undefined;
    this.permissions = new PermissionLedger(options.mode, async (request) => {
      const turnId = this.activeTurnId ?? "turn_unbound";
      await this.activeTransition?.("waiting_approval", true);
      await this.journal.append({
        type: "approval_requested",
        turnId,
        request: {
          toolCallId: request.call.id,
          toolName: request.tool.name,
          summary: request.summary,
          actionDigest: request.actionDigest,
          scopeKey: request.scopeKey,
          policyVersion: request.policyVersion,
          effect: request.tool.effect,
          capabilityId: request.tool.capabilityId,
        },
      }, { durable: true });
      const decision = await options.approve(request);
      await this.journal.append({ type: "approval_decided", turnId, actionDigest: request.actionDigest, decision }, { durable: true });
      if (decision === "allow" || decision === "allow_always" || decision === "allow_pattern") await this.activeTransition?.("running", true);
      return decision;
    }, this.jev ? createJevJudge(this.jev) : undefined);
  }

  get sessionId(): string {
    return this.session.id;
  }

  /** A detached view of this session's completed hosted calls. */
  get routingReceipts() { return mergeRoutingReceipts(this.session.routingReceipts); }

  /**
   * A self-contained handoff record for rebuilding this session around another model or mode.
   *
   * Handoffs used to close the agent and then re-read this record from disk. That made a transient
   * read/integrity failure indistinguishable from an empty conversation: the replacement agent
   * silently started a new thread. The live agent is the authority for its current transcript, so
   * capture it before retirement and pass it directly to the replacement.
   */
  snapshot(): SessionRecord {
    return structuredClone(this.session);
  }

  /**
   * A transcript that ends in tool results had its turn cut off before the model replied: a process
   * that died after a mid-turn save, or a turn that failed after one. The note keeps roles
   * alternating for providers that require it and tells the model what happened. Returns whether
   * anything changed.
   */
  private closeInterruptedTurn(): boolean {
    if (this.messages.at(-1)?.role !== "tool") return false;
    this.messages = [...this.messages, { role: "assistant", content: INTERRUPTED_TURN_NOTE, internal: true }];
    this.session = { ...this.session, messages: this.messages };
    return true;
  }

  /** Restores a previous session's transcript and standing approvals. */
  resume(record: SessionRecord): void {
    if (this.ownershipReady) throw new Error("Relinquish the current agent before resuming another session");
    this.session = { ...record, routingReceipts: mergeRoutingReceipts(record.routingReceipts), mode: this.options.mode, modelSelection: this.options.model.selection };
    this.messages = [...record.messages];
    this.closeInterruptedTurn();
    this.recalledMemoryKeys.clear();
    for (const key of record.recalledMemoryKeys ?? []) this.recalledMemoryKeys.add(key);
    // A resumed session may already have been compacted, in which case the earliest surviving user
    // message is Archymedes's own constraints block or summary rather than anything the user typed.
    // Those are skipped by their headings; if nothing is left, the session title is the best
    // remaining record of what was asked.
    this.openingObjective =
      record.messages.find(
        (message) =>
          message.role === "user" &&
          !message.internal &&
          !message.content.startsWith(STANDING_CONSTRAINTS_HEADING) &&
          !message.content.startsWith("[Earlier conversation, summarized]"),
      )?.content ?? (record.title === "Untitled session" ? null : record.title);
    this.permissions.restore(record.approvals ?? {});
    this.journal = new EventJournal(this.options.root, record.id);
    this.recovery = new HostedRecoveryStore(this.options.root, record.id);
  }

  /** Own the journal before any model call, tool effect or session mutation. */
  async acquireOwnership(): Promise<void> {
    this.ownershipReady ??= (async () => {
      await this.journal.open();
      const current = await loadSession(this.options.root, this.session.id);
      const exists = current || await access(path.join(this.options.root, ".archymedes", "sessions", `${this.session.id}.json`)).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
      if (!current && (exists || this.session.revision > 0)) {
        await this.journal.close();
        throw new Error("Session snapshot is missing, corrupt or incompatible; refusing to start work.");
      }
      if (current && current.revision !== this.session.revision) {
        await this.journal.close();
        throw new Error("Session changed since it was loaded; resume it again before writing.");
      }
    })();
    await this.ownershipReady;
  }

  private async recordHostedUsage(): Promise<void> {
    const responses = this.recovery.responses();
    if (!responses.length) return;
    const events = await readEventJournal(this.options.root, this.session.id);
    const recorded = new Set(events.flatMap(({ payload }) => payload.type === "runtime" && payload.event.type === "model_turn" && payload.event.requestId ? [payload.event.requestId] : []));
    for (const { requestId, turn } of responses) {
      if (recorded.has(requestId)) continue;
      await this.journal.append({ type: "runtime", turnId: `recovered_${requestId}`, event: {
        type: "model_turn", requestId, iteration: 0, responseId: turn.responseId,
        model: turn.model, toolCallCount: turn.toolCalls.length, usage: turn.usage,
      } }, { durable: true });
      recorded.add(requestId);
    }
  }

  /** Reconcile old identities before allowing any replacement hosted work. Never replay tools. */
  async recoverPending(signal?: AbortSignal): Promise<boolean> {
    if (this.turnAbort && signal !== this.turnAbort.signal) throw new Error("Cannot recover while a turn is running");
    await this.acquireOwnership();
    const recovered = await this.recovery.recover(this.options.model, this.session, signal);
    if (!recovered) return false;
    await this.recordHostedUsage();
    await saveSession(recovered);
    this.session = recovered;
    this.messages = [...recovered.messages];
    await this.recovery.cleanup(recovered.hostedRecoveryBatchId);
    return true;
  }

  cancel(): void {
    this.cancelled = true;
    this.turnAbort?.abort();
  }

  /** Updates the amount this next exchange may spend; used by the CLI's session-wide cap. */
  setModelSpendLimit(remaining: number): void {
    if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error("remaining model spend must be a non-negative integer");
    this.budgets.maxRwf = remaining;
  }

  /** Where this agent is reading and writing — a directory, or a sandbox id. */
  /**
   * The limits this session is actually running under.
   *
   * Worth exposing rather than keeping private: they are no longer constants a reader can look up
   * in this file — they depend on which model the session opened with — and both the CLI's own
   * reporting and any embedder deciding how much to send need the same answer the runtime uses.
   */
  get budgetSnapshot(): Readonly<ArchymedesBudgets> {
    return this.budgets;
  }

  get workspaceLabel(): string {
    return this.workspace.label;
  }

  get workspaceKind(): ArchymedesWorkspace["kind"] {
    return this.workspace.kind;
  }

  /** The agent's current plan, for `/todos` — a read-only snapshot, empty before the first turn. */
  get todos(): TodoItem[] {
    return this.todoList.list();
  }

  /** What changed since the last checkpoint, for `/diff`. */
  diffPatch(): Promise<string> {
    return this.checkpoints.diffPatch();
  }

  diffStat(): Promise<string> {
    return this.checkpoints.diffStat();
  }

  /**
   * The project's files, root-relative — for a file browser, on whichever backend is in use.
   *
   * Goes through `this.workspace`, so a sandboxed session lists the sandbox's files rather than the
   * host's. Read-only and free: no model turn and no approval, the same as `scanSecrets`.
   */
  listFiles(pattern = "**/*"): Promise<string[]> {
    return this.workspace.glob(pattern);
  }

  /**
   * One file's contents, for looking at rather than for changing.
   *
   * The same guarantees as `listFiles`, and for the same reason: through `this.workspace`, so a
   * sandboxed session shows the sandbox's copy and not the host's — reading the local disk here
   * would show a file the agent is not working on, which is worse than showing nothing. Read-only,
   * no model turn, no approval, and the workspace's own root confinement and size limits apply, so
   * this cannot be pointed outside the project.
   */
  readFile(path: string, options: { offset?: number; limit?: number } = {}): Promise<ReadResult> {
    return this.workspace.readFile(path, options);
  }

  /** The deterministic secret scan, run directly against the workspace — for `/scan`. No model turn, no approval: same read-only guarantee as the `scan_secrets` tool it shares its logic with. */
  scanSecrets(include?: string): Promise<PlacedSecretFinding[]> {
    return scanWorkspaceForSecrets(this.workspace, include);
  }

  /** Releases the backend. For E2B that stops the sandbox; locally it does nothing. */
  async dispose(): Promise<void> {
    await this.relinquish();
    // The session's closing hook runs before anything is torn down: it is the last chance a project
    // has to observe the session, and a hook that cannot run because disposal already happened is
    // a hook that never ran. Never throws — disposal must complete regardless of what a hook does.
    const tooling = await this.externalTooling;
    if (tooling && this.sessionHookFired) {
      await tooling.hooks.runPostSession(this.session.id).catch(() => undefined);
    }
    await this.workspace.dispose();
    // Kills any MCP server process this session actually started. A tooling load that never
    // happened (no turn was ever sent) is `null`, and disposing nothing is correct.
    await tooling?.dispose();
    await this.defenderBrain.close();
    // Clean up orphaned recovery files from crashed processes that never resumed.
    // Best-effort: a failure here must not prevent disposal from completing.
    await this.recovery.cleanupOrphaned(this.options.root).catch(() => undefined);
  }

  private loadExternalTooling(): Promise<LocalExternalTooling | undefined> {
    // Every backend, not only local: discovery reads through the workspace, so a `.archymedes` directory
    // committed to a repository is found in an E2B or Docker session exactly as it is on this
    // machine. (`nestedInstructions` above is still local-only — it reads `node:fs` directly.)
    this.externalTooling ??= loadLocalExternalTooling(this.workspace);
    return this.externalTooling;
  }

  /**
   * Closes this front end's journal before a mode/model/settings handoff without destroying the
   * shared workspace. This prevents abandoned file handles while keeping an E2B sandbox alive.
   */
  async relinquish(): Promise<void> {
    await this.journal.close();
  }

  listCheckpoints(): Checkpoint[] {
    return this.checkpoints.list();
  }

  /**
   * What this session can actually call, and which hook scripts would run — for `/tools`.
   *
   * Built by the same `createArchymedesTools` call a real turn uses, rather than a second list assembled
   * for display: a "what is loaded" answer that is computed differently from what actually loads is
   * the one kind of answer that is worse than none. Scoped to the mode's capabilities for the same
   * reason — plan mode genuinely cannot call the write tools, so listing them would be a lie.
   */
  async inspectTools(): Promise<{ tools: AgentTool[]; hooks: { preToolUse: string[]; postToolUse: string[] }; providerIds: string[] }> {
    const context = await collectProjectContext(this.options.root);
    const externalTooling = await this.loadExternalTooling();
    const delegate = this.createDelegateRunner(context, () => this.budgets.maxRwf);
    const tools = await createArchymedesTools({
      workspace: this.workspace,
      todos: this.todoList,
      search: this.options.search,
      onExpense: this.options.onExpense,
      instructions: this.nestedInstructions,
      externalToolProviders: externalTooling?.providers,
      hooks: externalTooling?.hooks,
      delegate: delegate.runner,
      // The *local* root, never the workspace: a fact learned during a remote sandbox session must
      // outlive that container, and `.archymedes/memory.md` inside a disposable sandbox does not.
      memoryRoot: this.options.root,
      defenderBrain: this.defenderBrain,
    });
    const capabilities = capabilitiesForMode(this.options.mode);
    const hookScripts = await externalTooling?.hooks.list();
    return {
      tools: tools.filter((tool) => capabilities.includes(tool.capabilityId)),
      hooks: { preToolUse: hookScripts?.["pre-tool-use"] ?? [], postToolUse: hookScripts?.["post-tool-use"] ?? [] },
      providerIds: externalTooling?.providers.map((provider) => `${provider.kind}:${provider.id}`) ?? [],
    };
  }

  /** Token-based preflight using the actual system prompt, history and tool schemas for this mode. */
  async estimateNextTurn(objective: string): Promise<AgentCostPrediction> {
    const { initialInputTokens } = await this.prospectiveRequest(objective);
    return predictAgentUsage({ initialInputTokens, objective, mode: this.options.mode });
  }

  /**
   * Asks the provider where the next turn would be routed, without running it.
   *
   * Only the hosted exchange can answer this, so a direct-provider session returns null rather than
   * inventing a local ranking. The size it plans against is the same figure `estimateNextTurn`
   * predicts cost from — one assembly, so the preflight and the turn cannot drift apart — and the
   * conversation itself never leaves the machine for a question this cheap.
   */
  async planNextTurn(objective: string, signal?: AbortSignal): Promise<RoutingPlan | null> {
    const provider = this.options.model as AgentTurnProvider & {
      plan?: (input: { estimatedInputTokens: number; maxOutputTokens: number; usesTools?: boolean; signal?: AbortSignal }) => Promise<RoutingPlan | null>;
    };
    if (typeof provider.plan !== "function") return null;
    const { initialInputTokens, toolCount } = await this.prospectiveRequest(objective);
    return await provider.plan({
      estimatedInputTokens: Math.max(1, initialInputTokens),
      maxOutputTokens: this.budgets.maxOutputTokens,
      usesTools: toolCount > 0,
      ...(signal ? { signal } : {}),
    });
  }

  /** What the next turn would send: its assembled size and how many tools it would carry. */
  private async prospectiveRequest(objective: string): Promise<{ initialInputTokens: number; toolCount: number }> {
    const context = await collectProjectContext(this.options.root);
    const externalTooling = await this.loadExternalTooling();
    const delegate = this.createDelegateRunner(context, () => this.budgets.maxRwf);
    const tools = await createArchymedesTools({
      workspace: this.workspace,
      todos: this.todoList,
      search: this.options.search,
      onExpense: this.options.onExpense,
      instructions: this.nestedInstructions,
      externalToolProviders: externalTooling?.providers,
      hooks: externalTooling?.hooks,
      delegate: delegate.runner,
      // The *local* root, never the workspace: a fact learned during a remote sandbox session must
      // outlive that container, and `.archymedes/memory.md` inside a disposable sandbox does not.
      memoryRoot: this.options.root,
      defenderBrain: this.defenderBrain,
    });
    const capabilities = capabilitiesForMode(this.options.mode);
    // Assembled exactly as `send` will, token saver included, so the estimate is of the real request.
    const tokenSaver = this.options.model.tokenSaver === true;
    const profiled = toolsForProfile(
      tools.filter((tool) => capabilities.includes(tool.capabilityId)),
      toolProfileForObjective(objective, this.options.mode),
    );
    const scoped = tokenSaver ? leanToolset(profiled, this.options.mode, objective) : profiled;
    delegate.setTools(scoped.filter((tool) => !DELEGATION_TOOLS.has(tool.name)));
    const systemPrompt = buildArchymedesSystemPrompt(context, this.options.mode, scoped.map((tool) => tool.name), this.workspace, await this.loadEnvironment(), { lean: tokenSaver });
    const toolSchemas = JSON.stringify(scoped.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })));
    const initialInputTokens = approximateInputTokens([
      systemPrompt,
      ...(tokenSaver ? stubEarlierToolResults(this.messages) : this.messages).filter((message) => message.role !== "system").flatMap(agentMessagePromptParts),
      objective,
      toolSchemas,
    ]).expectedInputTokens;
    return { initialInputTokens, toolCount: scoped.length };
  }

  /**
   * Restores the last checkpoint — code, conversation, or both.
   *
   * The three scopes answer three different regrets: "the edit was wrong but the plan we discussed
   * to get there was fine" (code), "the model went down a conversational dead end but the files
   * are untouched or already fixed by hand" (conversation), and "start this turn over completely"
   * (both, the default and the only thing `/undo` did before this).
   *
   * A conversation restore is written back to the session file immediately, not left to catch up
   * on the next `send()` — someone who undoes and then closes Archymedes without sending another turn
   * must not find the untruncated transcript still on disk.
   */
  async undo(scope: RestoreScope = "both"): Promise<Checkpoint | undefined> {
    if (this.turnAbort) throw new Error("Cannot undo while a turn is running");
    await this.acquireOwnership();
    const checkpoint = this.checkpoints.latest();
    if (!checkpoint) return undefined;
    if (scope === "code" || scope === "both") {
      if (!(await this.checkpoints.restore(checkpoint.tree))) return undefined;
    }
    if (scope === "conversation" || scope === "both") {
      this.messages = this.messages.slice(0, checkpoint.messageCount);
      this.session = { ...this.session, messages: this.messages, updatedAt: Date.now() };
      await saveSession(this.session);
    }
    return checkpoint;
  }

  /**
   * Builds the closure `delegate_task` calls to run one bounded sub-agent.
   *
   * The sub-agent's own tool list is not known yet when this closure is created — it is the
   * outer tool list, once built, minus `delegate_task` itself. `setTools` is called once that list
   * exists; `execute` is only ever invoked later, during the run, by which point it always has. The
   * indirection is what keeps this to one `createArchymedesTools` call instead of two.
   *
   * Depth is bounded structurally, not by a counter: the sub-agent's tool set never includes
   * `delegate_task`, so it cannot spawn a further sub-agent no matter what it is asked to do.
   *
   * `readOnly` (the `delegate_readonly_task` tool) runs the sub-agent in plan mode with only the
   * tools that are effect-free *and* parallel-safe — the same test the runtime applies before it
   * runs calls concurrently. Such a sub-agent never reaches the approval gate (effect-free tools
   * are approved without asking), never writes, and never touches the shared todo list, which is
   * what makes several of them safe to run at once. Their budget reservations account for each
   * other through `delegatedInFlightRwf`.
   *
   * Approval, cancellation and mode are all inherited from the parent session — the same
   * `PermissionLedger`, so every effectful call inside the sub-agent is gated exactly as it would
   * be if the top-level agent had called it directly, and cancelling the parent turn stops it too.
   * What is not inherited is live event streaming: a sub-agent's own tool calls are not pushed to
   * `onEvent`, so the transcript shows `delegate_task` as one call with one final report, not a
   * nested play-by-play.
   */
  private createDelegateRunner(context: ProjectContext, remainingRwf: () => number): { runner: DelegateRunner; setTools: (tools: AgentTool[]) => void } {
    let subTools: AgentTool[] = [];
    const capabilities = capabilitiesForMode(this.options.mode);
    const readOnlyCapabilities = capabilities.filter((id) => capabilitiesForMode("plan").includes(id));
    const runner: DelegateRunner = async (task: string, runOptions?: { readOnly?: boolean }): Promise<DelegateResult> => {
      const readOnly = runOptions?.readOnly === true;
      const tools = readOnly
        ? subTools.filter((tool) => tool.effect === "none" && tool.parallelSafe && readOnlyCapabilities.includes(tool.capabilityId))
        : subTools;
      const systemPrompt = buildArchymedesSystemPrompt(context, readOnly ? "plan" : this.options.mode, tools.map((tool) => tool.name), this.workspace, await this.loadEnvironment(), { lean: this.options.model.tokenSaver === true });
      // Never more than half of whatever is left of the turn's own budget on one delegation, so a
      // model that delegates several times in a row cannot spend the whole turn's budget on the
      // first one and leave nothing for the rest of its own work. What concurrent siblings have
      // already reserved is not "left".
      const reservation = Math.max(0, Math.min(remainingRwf() - this.delegatedInFlightRwf, this.budgets.maxRwf / 2));
      this.delegatedInFlightRwf += reservation;
      try {
        const runtime = new BoundedAgentRuntime({
          model: this.recovery.wrap(this.options.model, () => this.session, this.options.prices, `delegate:${randomUUID()}`),
          tools,
          prices: this.options.prices,
          artifacts: this.artifacts,
          control: {
            heartbeat: async () => {},
            isCancellationRequested: async () => this.cancelled,
            isToolCallApproved: (call, tool) => this.permissions.decide(call, tool),
            persistEvent: async () => {},
          },
        });
        const result = await runtime.execute({
          taskId: `${this.session.id}_delegate`,
          runId: this.session.id,
          stepId: `delegate_${randomUUID()}`,
          objective: task,
          history: [],
          systemPrompt,
          allowedCapabilityIds: readOnly ? readOnlyCapabilities : capabilities,
          maxIterations: Math.min(15, this.budgets.maxIterations),
          maxToolCalls: Math.min(40, this.budgets.maxToolCalls),
          maxToolCallsPerTurn: this.budgets.maxToolCallsPerTurn,
          maxToolResultChars: this.budgets.maxToolResultChars,
          maxTotalToolResultChars: this.budgets.maxTotalToolResultChars,
          maxOutputTokens: this.budgets.maxOutputTokens,
          // A delegated sub-task is the textbook cheap-effort case: it is bounded, self-contained and
          // reports back in prose. Lower effort also means fewer, more consolidated tool calls and
          // less preamble, which is most of what a sub-agent's cost actually is.
          effort: "low",
          modelReservationRwf: reservation,
          safetyIdentifier: `archymedes_cli_${this.session.id}_delegate`.slice(0, 64),
          signal: this.turnAbort?.signal,
        });
        this.delegatedRwf += result.actualModelRwf;
        this.delegatedUsage = addModelUsage(this.delegatedUsage, result.usage);
        return { report: result.summary, status: result.status, iterations: result.iterations, toolCallsExecuted: result.toolCallsExecuted };
      } finally {
        this.delegatedInFlightRwf -= reservation;
      }
    };
    return { runner, setTools: (tools) => { subTools = tools; } };
  }

  /**
   * Runs one turn: the user says something, the agent works until it has an answer.
   *
   * The transcript persists across turns, which is what makes a follow-up like "now do the same
   * for the other module" mean anything.
   */
  async send(objective: string): Promise<ArchymedesTurnResult> {
    if (!objective.trim()) throw new Error("A request is required");
    if (this.turnAbort) throw new Error("A turn is already running in this session");
    this.cancelled = false;
    const turnAbort = new AbortController();
    this.turnAbort = turnAbort;
    // What actually ran this turn, for the judge to read afterwards. Reset every turn:
    // the verdict after turn two must not contain turn one's history. Declared outside
    // the try, which the post-turn verdict is: it reads what the turn ran, after
    // the fact, once the workspace is already disarmed.
    const turnEvidence: TurnEvidence[] = [];
    try {
      await this.recoverPending(turnAbort.signal);
      turnAbort.signal.throwIfAborted();
    } catch (error) {
      this.turnAbort = null;
      throw error;
    }
    const turnId = `turn_${randomUUID()}`;
    this.activeTurnId = turnId;
    let turnStatus: TurnStatus = "queued";
    const transition = async (to: TurnStatus, durable = false) => {
      assertTurnTransition(turnStatus, to);
      await this.journal.append({ type: "turn_status", turnId, from: turnStatus, to }, { durable });
      turnStatus = to;
    };
    this.activeTransition = transition;
    let turnResult: ArchymedesTurnResult;
    let priorCount = 0;
    try {
      // Recording start is ordered but not fsynced: no side effect has happened yet, so forcing a
      // disk barrier here would add latency without improving recovery. Tool calls and approvals
      // do use durable barriers before they can affect the world.
      if (this.options.model.recoveryScope) {
        this.session.title = this.session.title === "Untitled session" ? titleFromObjective(objective) : this.session.title;
        await saveSession(this.session);
      }
      await transition("running");

      this.openingObjective ??= objective;

      // The session's own hooks gate the turn before any model call, tool or checkpoint: a
      // pre-session hook fires once (it gates the session itself), then a pre-turn hook fires
      // every turn. A block refuses the turn outright — the same contract a pre-tool-use hook
      // applies to a tool call, one level up.
      const gate = await this.runTurnGate(objective);
      if (gate.blocked) {
        await transition("blocked", true);
        return this.blockedTurnResult(gate.reason);
      }

      // Repository instructions and cheap world-state signals are refreshed at every user turn.
      // A long-lived session must not keep following an AGENTS.md that changed three turns ago.
      this.context = await collectProjectContext(this.options.root);

      // `delegate_task` reserves against what is left of *this turn's* budget once compaction (below)
      // has taken its share — known only after this point, so the callback reads it through a
      // variable set once it is, rather than the closure capturing today's zero forever.
      this.delegatedRwf = 0;
      this.delegatedUsage = emptyModelUsage();
      let compactionActualRwf = 0;
      const delegate = this.createDelegateRunner(this.context, () => Math.max(0, this.budgets.maxRwf - compactionActualRwf - this.delegatedRwf));

      const externalTooling = await this.loadExternalTooling();
      const tools = await createArchymedesTools({
        workspace: this.workspace,
        todos: this.todoList,
        search: this.options.search,
        onExpense: this.options.onExpense,
        instructions: this.nestedInstructions,
        externalToolProviders: externalTooling?.providers,
        hooks: externalTooling?.hooks,
        delegate: delegate.runner,
        memoryRoot: this.options.root,
        defenderBrain: this.defenderBrain,
      });
      const capabilities = capabilitiesForMode(this.options.mode);
      // Token saver (free mode): leaner budgets, prompt, tool set and history; see `token-saver.ts`.
      const tokenSaver = this.options.model.tokenSaver === true;
      this.refreshModelBudgets();
      const profiled = toolsForProfile(
        tools.filter((tool) => capabilities.includes(tool.capabilityId)),
        toolProfileForObjective(objective, this.options.mode),
      );
      const scoped = withEditDiagnostics(tokenSaver ? leanToolset(profiled, this.options.mode, objective) : profiled, this.options.afterEdit);
      delegate.setTools(scoped.filter((tool) => !DELEGATION_TOOLS.has(tool.name)));
      /**
       * Durable memory, recalled against this turn's objective and prepended to the prompt.
       *
       * Done here rather than in each front end, which is the whole point of the move: the CLI had
       * its own recall wiring and the desktop had none, so the same agent knew the user's
       * conventions in a terminal and had never heard of them in a window. One agent, one memory.
       *
       * Recall is lexical and bounded — it selects a few kilobytes at most — so a memory file that
       * grows for a year does not quietly become the largest thing in every request.
       */
      const memories = await loadMemories(this.options.root, process.env).catch(() => []);
      const recalled = memories.length > 0
        ? recallMemories(memories, objective, { exclude: this.recalledMemoryKeys }).entries
        : [];
      for (const entry of recalled) this.recalledMemoryKeys.add(recalledMemoryKey(entry));
      /**
       * The system prompt is the cached prefix, so nothing turn-specific may live in it.
       *
       * Recalled memory used to be appended here, and it is selected by lexical overlap with *this
       * turn's objective* — so a different question produced a different system block, and because
       * a prompt cache is a strict prefix match over tools → system → messages, one changed
       * sentence at the top invalidated the cache for the entire transcript beneath it. On a long
       * conversation that turned a 0.1x cache read into a 1.25x cache write, every single turn.
       *
       * The memory itself is just as useful attached to the turn that asked for it, where it costs
       * a cache miss on nothing but itself.
       */
      const systemPrompt = buildArchymedesSystemPrompt(this.context, this.options.mode, scoped.map((tool) => tool.name), this.workspace, await this.loadEnvironment(), { lean: tokenSaver });
      const memoryBlock = memoryPromptBlock(recalled);
      const attached = await attachMentionedImages(this.workspace, objective);
      const requested = objectiveWithImageProblems(objective, attached.problems);
      const turnObjective = memoryBlock ? `${memoryBlock}\n\n${requested}` : requested;

      // Snapshot before the agent can touch anything, so `/undo` returns to the state the user saw
      // when they typed. Taken per turn rather than per tool call: a turn is the unit a person
      // actually thinks in, and forty checkpoints for one request is a list nobody can navigate.
      // Checkpoints snapshot the local git tree, so they mean nothing for a remote sandbox: the
      // machine's files were never touched, and the sandbox is disposable by construction.
      let checkpoint: Checkpoint | undefined;
      if (this.options.mode !== "plan" && this.workspace.kind === "local") {
        // `this.messages.length` here, before this turn's own exchange is appended below, is
        // exactly the cut point a conversation-only or combined restore needs: "back to what the
        // user saw when they typed this turn's objective."
        checkpoint = await this.checkpoints.capture(titleFromObjective(objective), turnId, this.messages.length);
        if (checkpoint) this.options.onEvent?.({ type: "checkpoint", checkpoint });
      }

      const compaction = await this.compactIfNeeded(turnId, objective, turnAbort.signal, tokenSaver);
      compactionActualRwf = compaction.actualRwf;
      // Fresh per turn: a judge reading the previous turn's task would misjudge this one's tools.
      this.permissions.setTaskHint(objective);
      const runtime = new BoundedAgentRuntime({
        model: this.recovery.wrap(this.options.model, () => this.session, this.options.prices, "main"),
        tools: scoped,
        prices: this.options.prices,
        artifacts: this.artifacts,
        control: {
          heartbeat: async () => {},
          isCancellationRequested: async () => this.cancelled,
          isToolCallApproved: (call, tool) => this.permissions.decide(call, tool),
          // Saved after every completed tool step, not only when the turn ends: a crash or SIGKILL
          // mid-turn used to leave `--resume` without the request or the tool work already done.
          // Appended to the session's step journal (only the new messages), not a full rewrite —
          // the full snapshot is written at turn end, so per-step cost no longer grows with the session.
          checkpointMessages: async (messages) => {
            this.messages = withoutImageData(fullTranscript(messages));
            this.session = { ...this.session, messages: this.messages, title: this.session.title === "Untitled session" ? titleFromObjective(objective) : this.session.title, updatedAt: Date.now() };
            await appendSessionStep(this.session);
          },
          persistEvent: async (event) => {
            if (event.type === "tool_result") {
              const data = event.data;
              turnEvidence.push({
                tool: event.toolName,
                ...(typeof data?.command === "string" ? { command: data.command } : {}),
                ...(typeof data?.exitCode === "number" ? { exitCode: data.exitCode } : {}),
                ...(typeof data?.verificationKind === "string" ? { kind: data.verificationKind } : {}),
                isError: event.isError,
              });
            }
            this.options.onEvent?.({ type: "runtime", event });
            if (event.type !== "assistant_delta") {
              await this.journal.append(
                { type: "runtime", turnId, event: runtimeEventForJournal(event) },
                { durable: event.type === "tool_call" && event.effect !== "none" },
              );
            }
          },
        },
      });

      // The runtime owns one exchange; the CLI owns the conversation. Native messages preserve
      // provider tool-call structure and prompt caching across turns.
      const priorHistory = this.messages.filter((message) => message.role !== "system");
      priorCount = priorHistory.length;
      // Earlier turns' tool output goes to the model as stubs; the saved transcript keeps it whole.
      const sentHistory = tokenSaver ? stubEarlierToolResults(priorHistory) : priorHistory;
      const fullTranscript = (messages: readonly AgentMessage[]) => tokenSaver ? restoreFullHistory(messages, priorHistory, sentHistory) : [...messages];
      const result = await runtime.execute({
        taskId: this.session.id,
        runId: this.session.id,
        stepId: `turn_${this.messages.length}`,
        // Carries this turn's recalled memory with it, so the cached system prefix stays byte-stable.
        objective: turnObjective,
        images: attached.images,
        history: sentHistory,
        systemPrompt,
        allowedCapabilityIds: capabilities,
        maxIterations: this.budgets.maxIterations,
        maxToolCalls: this.budgets.maxToolCalls,
        maxToolCallsPerTurn: this.budgets.maxToolCallsPerTurn,
        maxToolResultChars: this.budgets.maxToolResultChars,
        maxTotalToolResultChars: this.budgets.maxTotalToolResultChars,
        maxOutputTokens: this.budgets.maxOutputTokens,
        modelReservationRwf: Math.max(0, this.budgets.maxRwf - compaction.actualRwf),
        safetyIdentifier: `archymedes_cli_${this.session.id}`.slice(0, 64),
        signal: turnAbort.signal,
      });

      const combinedUsage = addModelUsage(compaction.usage, addModelUsage(result.usage, this.delegatedUsage));
      const combinedRwf = compaction.actualRwf + result.actualModelRwf + this.delegatedRwf;
      // Post-turn hooks run after the answer exists and cannot change it — a non-zero exit only
      // appends a warning to the summary, exactly as a post-tool-use hook appends one to a result.
      const hookWarnings = await this.runPostTurn(objective, result);
      const turnSummary = hookWarnings.length > 0
        ? `${result.summary}\n\n--- post-turn hook warnings ---\n${hookWarnings.join("\n")}`
        : result.summary;
      this.messages = withoutImageData(fullTranscript(result.messages));
      this.session = {
        ...this.session,
        title: this.session.messages.length === 0 ? titleFromObjective(objective) : this.session.title,
        messages: this.messages,
        recalledMemoryKeys: [...this.recalledMemoryKeys],
        approvals: this.permissions.snapshot(),
        totalRwf: this.session.totalRwf + combinedRwf,
        routingReceipts: mergeRoutingReceipts(this.session.routingReceipts, result.routingReceipts, this.recovery.responses().flatMap(({ requestId, turn }) => turn.routingReceipt ? [{ ...turn.routingReceipt, taskId: turn.routingReceipt.taskId ?? requestId }] : [])),
        hostedRecoveryBatchId: this.recovery.settledBatchId() ?? this.session.hostedRecoveryBatchId,
        updatedAt: Date.now(),
      };
      const terminalStatus = runtimeStatusToTurnStatus(result.status);
      await transition(terminalStatus, true);
      await this.recordHostedUsage();
      await saveSession(this.session);
      await this.recovery.cleanup(this.session.hostedRecoveryBatchId);
      turnResult = { ...result, messages: fullTranscript(result.messages), summary: turnSummary, usage: combinedUsage, actualModelRwf: combinedRwf, checkpoint };
    } catch (error) {
      if (isActiveTurnStatus(turnStatus)) {
        await transition("failed", true).catch(() => undefined);
      }
      if (this.closeInterruptedTurn()) await saveSession(this.session).catch(() => undefined);
      throw error;
    } finally {
      if (this.turnAbort === turnAbort) this.turnAbort = null;
      this.activeTurnId = null;
      this.activeTransition = null;
    }
    // The model has acted, the turn is saved and disarmed; now the judge speaks. Awaiting
    // the verdict here keeps transcript order (verdict line before the next prompt), but the
    // turn is already over: Ctrl+C during judgment exits instead of aborting finished work,
    // and whatever Jev says — or its silence — changes nothing already decided.
    const verdict = await this.maybeJevVerdict({ objective, priorCount, messages: turnResult.messages, evidence: turnEvidence });
    if (this.shouldAutoReview(verdict, turnResult)) {
      const probability = verdict && verdict.status === "verdict" ? (verdict.outcomeProbabilities[verdict.outcome] ?? 0) : 0;
      this.options.onEvent?.({ type: "jev-review", outcome: verdict && verdict.status === "verdict" ? verdict.outcome : "unknown", probability, reason: "judge disagreed with the turn's status" });
      this.jevCorrectionDepth += 1;
      try {
        return await this.send(await this.correctivePrompt(objective, verdict as JevTurnVerdict & { status: "verdict" }, turnEvidence));
      } finally {
        this.jevCorrectionDepth -= 1;
      }
    }
    return turnResult;
  }

  /**
   * Asks Jev for a post-turn verdict and reports it as an event.
   *
   * Runs after the turn is saved, so a slow or failing judge can delay the transcript
   * line but never the work itself. Skipped entirely without a key. Fail-open: a judge
   * outage emits `unavailable` rather than throwing, because the turn it judges already
   * finished — failing it after the fact would rewrite history, not protect anyone.
   */
  private async maybeJevVerdict(input: { objective: string; priorCount: number; messages: readonly AgentMessage[]; evidence?: readonly TurnEvidence[] }): Promise<JevTurnVerdict | undefined> {
    if (!this.jev) return undefined;
    const toolNames: string[] = [];
    let assistantText = "";
    for (const message of input.messages.slice(input.priorCount)) {
      if (message.role !== "assistant") continue;
      if (message.content.trim()) assistantText = message.content;
      if ("toolCalls" in message) for (const call of message.toolCalls) toolNames.push(call.name);
    }
    try {
      const response = await requestJevVerdict({
        apiKey: this.jev.apiKey,
        ...(this.jev.model ? { model: this.jev.model } : {}),
        ...(this.jev.timeoutMs !== undefined ? { timeoutMs: this.jev.timeoutMs } : {}),
        ...(this.jev.fetchImpl ? { fetchImpl: this.jev.fetchImpl } : {}),
        state: turnVerdictState({ objective: input.objective, assistantText, toolNames, ...(input.evidence ? { evidence: input.evidence } : {}) }),
      });
      const verdict = verdictFromResponse(response);
      this.options.onEvent?.({ type: "jev-verdict", verdict });
      return verdict;
    } catch (error) {
      // The message carries no credential: requestJevVerdict never puts the key in one.
      const reason = error instanceof Error ? error.message : String(error);
      const verdict = { status: "unavailable", reason: reason.slice(0, 200) } as const;
      this.options.onEvent?.({ type: "jev-verdict", verdict });
      return verdict;
    }
  }

  /**
   * A verdict of `follow_up`/`blocked` on a turn that closed `completed` means the
   * runtime's own evidence and the judge's read disagree — and on the benchmark run
   * the runtime was the wrong one (`ls` credited as a behavior verification while
   * `bun test` failed 17/17). Rather than printing the disagreement and leaving it,
   * re-invoke the model once with the evidence attached. Bounded two ways: one
   * correction per user turn, and only when the review is not disabled. The second
   * verdict stands — the judge gets heard, not obeyed.
   */
  private shouldAutoReview(verdict: JevTurnVerdict | undefined, turnResult: ArchymedesTurnResult): boolean {
    if (!verdict || verdict.status !== "verdict") return false;
    if (this.jevCorrectionDepth > 0) return false;
    if (this.cancelled) return false;
    if (this.options.jev?.review === false) return false;
    if (turnResult.status !== "completed") return false;
    if (verdict.outcome === "complete") return false;
    return (verdict.outcomeProbabilities[verdict.outcome] ?? 0) >= 0.5;
  }

  private jevCorrectionDepth = 0;

  private async correctivePrompt(objective: string, verdict: JevTurnVerdict & { status: "verdict" }, evidence: readonly TurnEvidence[]): Promise<string> {
    const failures = evidence.filter((entry) => entry.exitCode !== undefined && entry.exitCode !== 0).slice(-6);
    const failureLine = failures.length > 0
      ? `Failing commands from the last turn: ${failures.map((entry) => `\`${entry.command ?? entry.tool}\` exited ${entry.exitCode}`).join("; ")}.`
      : "The last turn produced no passing verification evidence.";
    return [
      `Jev (second-opinion judge) marked the previous turn as "${verdict.outcome}" (confidence ${(verdict.outcomeProbabilities[verdict.outcome] ?? 0).toFixed(2)}). ${failureLine}`,
      "Diagnose first: read the failing output instead of rewriting whole files. Make the smallest fix that addresses the failure, then re-run the verification commands until they pass. Original task: " + objective,
    ].join("\n\n");
  }

  /**
   * The pre-session hook (once) and the pre-turn hook (every turn), in that order.
   *
   * Both run through the workspace, so a hook committed to a repository gates a turn identically on
   * a local, E2B or Docker session. A block refuses the turn before any model call, tool or
   * checkpoint — the cheapest point at which a project can say no.
   */
  private async runTurnGate(objective: string): Promise<HookGateOutcome> {
    const hooks = (await this.loadExternalTooling())?.hooks;
    if (!hooks) return { blocked: false };
    if (!this.sessionHookFired) {
      this.sessionHookFired = true;
      const sessionOutcome = await hooks.runPreSession(this.session.id);
      if (sessionOutcome.blocked) return sessionOutcome;
    }
    return hooks.runPreTurn(objective);
  }

  /** The post-turn hook, after the answer exists. Never throws — a broken hook must not fail the turn it follows. */
  private async runPostTurn(objective: string, result: AgentRuntimeResult): Promise<string[]> {
    const hooks = (await this.loadExternalTooling())?.hooks;
    if (!hooks) return [];
    return hooks.runPostTurn(objective, { status: result.status, summary: result.summary });
  }

  /** The turn result a blocked pre-hook produces: nothing ran, and the reason leads the summary. */
  private blockedTurnResult(reason: string): ArchymedesTurnResult {
    return {
      status: "blocked",
      summary: `Blocked by hook: ${reason}`,
      messages: this.messages,
      usage: emptyModelUsage(),
      actualModelRwf: 0,
      iterations: 0,
      toolCallsExecuted: 0,
    };
  }

  /**
   * Summarizes the transcript when it approaches the context limit.
   *
   * Uses the same model that does the work, with no tools: compaction is a reading task, and a
   * summarizer holding an `edit_file` tool is a summarizer that will eventually use it.
   */
  private async compactIfNeeded(turnId: string, objective: string, signal?: AbortSignal, tokenSaver = false): Promise<{ usage: ModelUsage; actualRwf: number }> {
    // Compaction happens between turns, which is already the cleanest boundary a session has: the
    // previous exchange concluded, no tool call is outstanding. `atSafeBoundary` still asks,
    // because "concluded" is not the same as "finished" — an agent that left an item in progress
    // on its own plan is mid-task no matter where the turn ended, and the detail behind that item
    // is exactly what a summary would drop.
    const boundary = atSafeBoundary(this.messages, { workInProgress: this.todoList.list().some((item) => item.status === "in_progress") })
      ? "safe"
      : "mid-task";
    // A token-saving session measures and summarizes the transcript as it is actually sent — earlier
    // tool output stubbed — so a file read three turns ago neither forces a summary nor is resent
    // whole inside the request that writes one.
    const basis = tokenSaver ? stubEarlierToolResults(this.messages) : this.messages;
    const urgency = compactionUrgency(basis, { contextLimit: this.budgets.contextLimit, outputBudget: this.budgets.maxOutputTokens });
    const plan = planCompaction(basis, { contextLimit: this.budgets.contextLimit, outputBudget: this.budgets.maxOutputTokens, boundary });
    if (!plan) return { usage: emptyModelUsage(), actualRwf: 0 };
    const before = this.messages.length;

    const maximumOutputTokens = affordableOutputTokens(
      [...plan.toSummarize.map((message) => message.content), COMPACTION_INSTRUCTION],
      Math.min(this.budgets.maxOutputTokens, 4_000),
      this.budgets.maxRwf,
      this.options.prices,
    );
    if (maximumOutputTokens < 1) return { usage: emptyModelUsage(), actualRwf: 0 };

    const turn = await this.recovery.wrap(this.options.model, () => this.session, this.options.prices, "compaction").complete({
      // Summarizing is reading, not reasoning. Thinking tokens bill as output and share the output
      // budget, so paying for deep reasoning to compress a transcript spends money on the one call
      // in the session that produces nothing the user asked for. Providers whose model does not
      // take the setting ignore it.
      effort: "low",
      messages: [...plan.toSummarize, { role: "user", content: COMPACTION_INSTRUCTION }],
      tools: [],
      maxOutputTokens: maximumOutputTokens,
      safetyIdentifier: `archymedes_cli_${this.session.id}`.slice(0, 64),
      signal,
    });
    const actualRwf = priceActualModelUsage(turn.usage.inputTokens, turn.usage.outputTokens, this.options.prices);
    if (actualRwf > this.budgets.maxRwf) throw new Error("Compaction usage exceeds the approved model budget");
    if (!turn.content.trim()) return { usage: turn.usage, actualRwf };

    this.messages = buildCompactedMessages(turn.content, plan, this.standingConstraints(objective));
    this.options.onEvent?.({ type: "compaction", tokensBefore: 0, messagesBefore: before, messagesAfter: this.messages.length, urgency, boundary });
    await this.journal.append({ type: "compaction", turnId, messagesBefore: before, messagesAfter: this.messages.length, actualRwf });
    return { usage: turn.usage, actualRwf };
  }

  /**
   * The session's governing facts, read from live state at the moment of compaction.
   *
   * Every field here is fetched from the thing that actually enforces it — the permission ledger,
   * the configured mode, the agent's own plan — rather than from the transcript being summarized.
   * That is what makes the block incapable of drifting: it cannot preserve a stale approval,
   * because it never reads the old one.
   */
  private standingConstraints(objective: string): StandingConstraints {
    return {
      mode: this.options.mode,
      objective: this.openingObjective ?? objective,
      approvals: this.permissions.snapshot(),
      openTodos: this.todoList.list().filter((item) => item.status !== "done").map((item) => item.text),
    };
  }
}

function emptyModelUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

function addModelUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

function runtimeStatusToTurnStatus(status: AgentRuntimeResult["status"]): TurnStatus {
  if (status === "needs_approval") return "waiting_approval";
  return status;
}

function isActiveTurnStatus(status: TurnStatus): boolean {
  return status === "queued" || status === "running" || status === "waiting_approval";
}
