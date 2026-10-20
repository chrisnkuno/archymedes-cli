import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BoundedAgentRuntime, type AgentRuntimeEvent, type AgentTool, type AgentToolCall, type AgentTurnProvider, type ThinkingEffort } from "../agent-runtime";
import type { ModelPriceCatalog } from "../model-cost";
import { addModelUsage, emptyModelUsage, type ModelUsage } from "../providers/model";
import type { WorkspaceArtifactStore } from "./artifacts";
import type { ArchymedesWorkspace } from "./backends";
import { ARCHYMEDES_CAPABILITIES, capabilitiesForMode, type ArchymedesMode } from "./permissions";
import { requiredString } from "./tool-args";

/**
 * Sub-agents: bounded runs of the same model, each with a role, that the main agent hands work to.
 *
 * They exist for two reasons, and each role is shaped by one of them:
 *
 * - **Context.** A broad search reads twenty files to find the three that matter. Done in the main
 *   conversation, all twenty stay in its context for the rest of the session; done by an `explore`
 *   sub-agent, only its report does. The read-only roles (`explore`, `plan`, `review`) exist for
 *   this, and because they cannot write or ask for approval, several run at once.
 * - **Independence.** A second opinion is worth something only if it was not formed by the same
 *   reasoning it checks. `review` and `verify` start from the brief and the code, never from the
 *   main agent's conversation, so they catch what it talked itself past.
 *
 * Depth is one: no sub-agent is ever given a delegation tool. Budget is reserved from the parent's
 * turn before a sub-agent starts, never refilled. Approval goes through the parent's ledger, so a
 * write inside a sub-agent asks exactly as it would at the top level.
 *
 * A project or person adds roles as Markdown files with front matter, in `.archymedes/agents/` or
 * `~/.config/archymedes/agents/` (see `parseSubagentFile`). A file may replace a built-in role by
 * using its name.
 */

export type SubagentProfile = {
  name: string;
  /** For the main agent, in its tool schema on every request: what this role is for, in a few words. */
  description: string;
  /** Read-only roles get only effect-free, parallel-safe tools, run in plan mode, and run concurrently. */
  readOnly: boolean;
  /** The role's own instructions, added to the sub-agent's system prompt. */
  instructions: string;
  effort: ThinkingEffort;
  maxIterations: number;
  maxToolCalls: number;
  /** When set, only these tools (a custom role's `tools:`). */
  tools?: readonly string[];
  /** Tools this role never gets, on top of those no sub-agent gets. */
  without?: readonly string[];
  /** "built-in", or the file the role was read from. */
  source: string;
};

/** The two delegation tools; neither is ever offered to a sub-agent. */
export const DELEGATION_TOOLS = new Set(["delegate_task", "delegate_readonly_task"]);

/**
 * Tools no sub-agent gets, whatever its role. The todo list is the main agent's plan for the
 * person, and two writers would interleave it; a sub-agent's question would reach the person
 * without the context that makes it answerable; memory and deployment are decisions the main
 * agent makes with the person, not side effects of a sub-task.
 */
const NEVER_DELEGATED = new Set([...DELEGATION_TOOLS, "todo_write", "todo_read", "ask_user", "remember", "deploy_app"]);

const WRITE_TOOLS = ["write_file", "edit_file", "notebook_edit"];

export const BUILT_IN_SUBAGENTS: readonly SubagentProfile[] = [
  {
    name: "explore",
    description: "find where/how something works (files, symbols, callers); one area each, several at once",
    readOnly: true,
    instructions: [
      "You are an exploration sub-agent. Search wide first (grep_files, glob_files, find_symbol, repo_map), several searches in one turn, then read only the parts that answer the brief.",
      "Every claim cites path:line. Say what you looked for and did not find, so the reader knows it is absent rather than missed. Stop as soon as the brief is answered.",
    ].join("\n"),
    effort: "low",
    maxIterations: 20,
    maxToolCalls: 60,
    source: "built-in",
  },
  {
    name: "plan",
    description: "files, order, risks and checks for a change across several files",
    readOnly: true,
    instructions: [
      "You are a planning sub-agent. Read the code the change touches and the code that calls it, then write the plan: each step names the file and the function, in the order to do them.",
      "Name the risks (callers that break, behaviour that changes, tests that must change) and how to verify the whole change. Prefer the smallest change that does what the brief asks; follow the conventions already in the code.",
    ].join("\n"),
    effort: "medium",
    maxIterations: 20,
    maxToolCalls: 60,
    source: "built-in",
  },
  {
    name: "review",
    description: "independent bug review of changed code, before you report it done",
    readOnly: true,
    instructions: [
      "You are a review sub-agent. You did not write this code; check it rather than trust it. Look at the change (git_diff) and at what calls it.",
      "Report only real defects: a concrete input or state, and the wrong result it produces, with path:line. No style notes, no praise, no speculation you have not checked. If you find nothing, say so plainly.",
    ].join("\n"),
    effort: "medium",
    maxIterations: 20,
    maxToolCalls: 60,
    source: "built-in",
  },
  {
    name: "general",
    description: "an independent, fully specified piece of work, edits included",
    readOnly: false,
    instructions: [
      "You are a sub-agent doing one well-defined piece of a larger task. Do exactly the brief: read before you edit, keep to its scope, and verify what you changed (run the relevant test or check).",
      "Do not touch files outside the brief; if the brief cannot be done as written, stop and say why rather than doing something else.",
    ].join("\n"),
    effort: "medium",
    maxIterations: 25,
    maxToolCalls: 80,
    source: "built-in",
  },
  {
    name: "verify",
    description: "run tests/build/typecheck and report failures; never edits",
    readOnly: false,
    instructions: [
      "You are a verification sub-agent. Find how this project checks itself (package scripts, Makefile, CI config), run the checks the brief asks for, and read the failures.",
      "You cannot edit files. Report each failure with the command, its exit code, the exact error and the path:line it points at, and say which failures look related to the brief and which were there before.",
    ].join("\n"),
    effort: "low",
    maxIterations: 15,
    maxToolCalls: 40,
    without: WRITE_TOOLS,
    source: "built-in",
  },
];

/** The default role for each delegation tool, when the call names none. */
const DEFAULT_ROLE = { readOnly: "explore", writable: "general" } as const;

const REPORT_CONTRACT = [
  "You have no memory of the conversation that sent you: the brief below is everything you know, and your final message is the only thing the agent that sent you will see.",
  "Write that message as a report: the answer or outcome first, then the evidence (path:line, commands with their exit codes), then anything you could not do and why. No preamble, and no narration of the steps you took.",
].join("\n");

const AGENTS_DIRECTORY = ".archymedes/agents";
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const EFFORTS: readonly ThinkingEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * One role from a Markdown file:
 *
 * ```
 * ---
 * name: migrations
 * description: Writes and checks database migrations.
 * tools: read_file, grep_files, write_file, run_command
 * readonly: false
 * effort: medium
 * ---
 * The instructions, as the body.
 * ```
 *
 * `name` and `description` are required; a read-only role is limited to effect-free tools whatever
 * `tools` lists. Throws with the file in the message, so a role that never loaded is not a mystery.
 */
export function parseSubagentFile(displayPath: string, raw: string): SubagentProfile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${displayPath}: needs front matter between --- lines`);
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (field) fields.set(field[1].toLowerCase().replace(/[-_]/g, ""), field[2].trim().replace(/^["']|["']$/g, ""));
  }
  const name = fields.get("name") ?? "";
  if (!NAME.test(name)) throw new Error(`${displayPath}: "name" must be lowercase letters, digits and dashes`);
  const description = fields.get("description") ?? "";
  if (!description) throw new Error(`${displayPath}: "description" is required`);
  const effort = (fields.get("effort") ?? "medium") as ThinkingEffort;
  if (!EFFORTS.includes(effort)) throw new Error(`${displayPath}: "effort" must be one of ${EFFORTS.join(", ")}`);
  const tools = fields.get("tools")?.replace(/^\[|\]$/g, "").split(",").map((tool) => tool.trim()).filter(Boolean);
  const readOnly = /^(true|yes)$/i.test(fields.get("readonly") ?? "");
  const bounded = (key: string, fallback: number, ceiling: number) => {
    const value = Number(fields.get(key));
    return Number.isInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
  };
  return {
    name,
    description,
    readOnly,
    instructions: match[2].trim(),
    effort,
    maxIterations: bounded("maxiterations", readOnly ? 20 : 25, 40),
    maxToolCalls: bounded("maxtoolcalls", readOnly ? 60 : 80, 150),
    ...(tools && tools.length > 0 ? { tools } : {}),
    source: displayPath,
  };
}

/**
 * The built-in roles, then the person's (`<configDirectory>/agents`), then the project's
 * (`.archymedes/agents`, through the workspace so it works in a sandbox too); a later one with the
 * same name replaces the earlier. A file that does not parse is reported in `problems` and left out.
 */
export async function loadSubagentProfiles(workspace: ArchymedesWorkspace, configDirectory?: string): Promise<{ profiles: SubagentProfile[]; problems: string[] }> {
  const byName = new Map(BUILT_IN_SUBAGENTS.map((profile) => [profile.name, profile]));
  const problems: string[] = [];
  const add = (displayPath: string, raw: string) => {
    try {
      const profile = parseSubagentFile(displayPath, raw);
      byName.set(profile.name, profile);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  };
  if (configDirectory) {
    const directory = path.join(configDirectory, "agents");
    const names = await fs.readdir(directory).catch(() => [] as string[]);
    for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
      const raw = await fs.readFile(path.join(directory, name), "utf8").catch(() => null);
      if (raw !== null) add(path.join(directory, name), raw);
    }
  }
  const files = await workspace.listConfigFiles(AGENTS_DIRECTORY).catch(() => [] as string[]);
  for (const file of files.filter((entry) => entry.endsWith(".md") && !entry.slice(AGENTS_DIRECTORY.length + 1).includes("/")).sort()) {
    const read = await workspace.readFile(file).catch(() => null);
    if (read) add(file, read.content);
  }
  return { profiles: [...byName.values()], problems };
}

/** What a sub-agent may call: the parent's tools, cut down by role. */
export function toolsForSubagent(profile: SubagentProfile, parentTools: readonly AgentTool[], readOnlyCapabilities: readonly string[]): AgentTool[] {
  return parentTools.filter((tool) => {
    if (NEVER_DELEGATED.has(tool.name)) return false;
    if (profile.without?.includes(tool.name)) return false;
    if (profile.tools && !profile.tools.includes(tool.name)) return false;
    if (profile.readOnly) return tool.effect === "none" && tool.parallelSafe && readOnlyCapabilities.includes(tool.capabilityId);
    return true;
  });
}

/**
 * When to delegate, for the main agent's system prompt. Sent only when a delegation tool is
 * offered. The rules are about cost as much as benefit: a sub-agent starts from nothing, so a task
 * the main agent can finish in one or two calls is cheaper done directly.
 */
export function delegationGuidance(toolNames: readonly string[], lean = false): string {
  const readOnly = toolNames.includes("delegate_readonly_task");
  const writable = toolNames.includes("delegate_task");
  if (!readOnly && !writable) return "";
  if (lean) {
    return "- Sub-agents: delegate only broad searches (delegate_readonly_task, several at once, one area each) or a fully specified independent piece; do one- or two-call work yourself.";
  }
  return [
    "Sub-agents (only their report enters your context; the brief is all they know: goal, area, what you know, what to report):",
    ...(readOnly ? [
      "- explore: a search that would take you several rounds. Send several delegate_readonly_task calls in one turn, one area each; they run at once.",
      "- plan before a change across files you have not read; review after substantial edits, then fix what it finds before reporting done.",
    ] : []),
    ...(writable ? ["- delegate_task: general for an independent, fully specified piece while you do the rest; verify to run the checks."] : []),
    "- Do one- or two-call lookups yourself, and check a report's claims before relying on them.",
  ].join("\n");
}

/** What a sub-agent did, for the tool result the main agent reads. */
export type DelegateResult = { report: string; status: string; iterations: number; toolCallsExecuted: number };
export type DelegateOptions = {
  readOnly?: boolean;
  /** A role's name; the tool's default role when absent. */
  agent?: string;
  /** The delegation call, so the sub-agent's work can be shown under it. */
  toolCallId?: string;
};
export type DelegateRunner = (task: string, options?: DelegateOptions) => Promise<DelegateResult>;

/** The delegation tools, with the roles each may run listed in its schema. */
export function delegationTools(delegate: DelegateRunner, profiles: readonly SubagentProfile[] = BUILT_IN_SUBAGENTS): AgentTool[] {
  const roles = (readOnly: boolean) => profiles.filter((profile) => profile.readOnly === readOnly);
  // Built-in roles are explained once, in the system prompt (`delegationGuidance`); a custom
  // role's description travels with the schema, since nothing else says what it is for.
  const describe = (readOnly: boolean) => roles(readOnly).map((profile) => (profile.source === "built-in" ? profile.name : `${profile.name} (${profile.description})`)).join(", ");
  const schema = (readOnly: boolean) => ({
    type: "object" as const,
    properties: {
      task: { type: "string" as const, description: "Self-contained brief" },
      agent: { type: "string" as const, enum: roles(readOnly).map((profile) => profile.name), description: `Role (default ${readOnly ? DEFAULT_ROLE.readOnly : DEFAULT_ROLE.writable})` },
    },
    required: ["task"],
    additionalProperties: false,
  });
  const execute = (readOnly: boolean) => async (args: Record<string, unknown>, context: { toolCallId?: string }) => {
    const task = requiredString(args.task, "task");
    const agent = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim() : undefined;
    const result = await delegate(task, { readOnly, ...(agent ? { agent } : {}), ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}) });
    const note = result.status === "completed" ? "" : `\n\n[${readOnly ? "read-only " : ""}sub-agent ended: ${result.status}, ${result.iterations} iteration(s), ${result.toolCallsExecuted} tool call(s)]`;
    return { content: `${result.report}${note}` };
  };
  const tools: AgentTool[] = [];
  if (roles(false).length > 0) {
    tools.push({
      name: "delegate_task",
      description: `Sub-agent with your tools and mode; returns its report. Roles: ${describe(false)}.`,
      inputSchema: schema(false),
      capabilityId: ARCHYMEDES_CAPABILITIES.planning,
      effect: "none",
      requiresApproval: false,
      // Not parallel-safe despite effect:"none": its own calls may write and ask for approval.
      parallelSafe: false,
      execute: execute(false),
    });
  }
  if (roles(true).length > 0) {
    tools.push({
      name: "delegate_readonly_task",
      description: `Read-only sub-agent; several in one turn run at once. Roles: ${describe(true)}.`,
      inputSchema: schema(true),
      capabilityId: ARCHYMEDES_CAPABILITIES.planning,
      effect: "none",
      requiresApproval: false,
      // Parallel-safe because the runner gives this sub-agent plan mode and only the tools that
      // are themselves effect-free and parallel-safe: no approval prompt can fire and nothing is written.
      parallelSafe: true,
      execute: execute(true),
    });
  }
  return tools;
}

/**
 * A sub-agent's activity, shown under the delegation call that started it. Only what a viewer
 * needs (its calls, their outcome, its usage); never journaled, since the report is the record.
 */
export type SubagentEvent = {
  type: "subagent";
  parentToolCallId: string;
  agent: string;
  event: Extract<AgentRuntimeEvent, { type: "tool_call" | "tool_result" | "model_turn" | "provider_retry" }>;
};

/** What a sub-agent needs from the session that runs it. */
export type SubagentHost = {
  mode(): ArchymedesMode;
  /** The session's model, wrapped for crash recovery under `label`. */
  model(label: string): AgentTurnProvider;
  prices: ModelPriceCatalog;
  artifacts: WorkspaceArtifactStore;
  systemPrompt(mode: ArchymedesMode, toolNames: string[]): Promise<string>;
  budgets(): { maxIterations: number; maxToolCalls: number; maxToolCallsPerTurn: number; maxToolResultChars: number; maxTotalToolResultChars: number; maxOutputTokens: number; maxRwf: number };
  isCancelled(): boolean;
  approve(call: AgentToolCall, tool: AgentTool): Promise<boolean | "approved" | "denied" | "pending">;
  signal(): AbortSignal | undefined;
  sessionId(): string;
  emit?(event: SubagentEvent): void;
  /** Whether a run in this mode builds test first; a writing sub-agent is held to it like the session. */
  testFirst?(mode: ArchymedesMode): boolean;
};

/** How many sub-agents run at once; more wait their turn. A provider's rate limit is the real ceiling. */
const MAX_CONCURRENT = 4;
/** A sub-agent's tool result is shown as a line, not read: this much of it is sent to the viewer. */
const VIEWER_RESULT_CHARS = 240;

/**
 * The sub-agents of one session: their roles, what they have spent this turn, and the runner the
 * delegation tools call.
 */
export class Subagents {
  private spentRwf = 0;
  private inFlightRwf = 0;
  private usage: ModelUsage = emptyModelUsage();
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  profiles: readonly SubagentProfile[] = BUILT_IN_SUBAGENTS;

  constructor(private readonly host: SubagentHost) {}

  /** A new turn: what sub-agents spent is counted per turn and folded into that turn's total. */
  startTurn(): void {
    this.spentRwf = 0;
    this.usage = emptyModelUsage();
  }

  get spent(): { rwf: number; usage: ModelUsage } {
    return { rwf: this.spentRwf, usage: this.usage };
  }

  /**
   * The closure the delegation tools call. The sub-agents' tools are the parent's, known only once
   * the parent's list is built, so `setTools` supplies them before any call can run.
   */
  runner(remainingRwf: () => number): { runner: DelegateRunner; setTools: (tools: AgentTool[]) => void } {
    let parentTools: AgentTool[] = [];
    const runner: DelegateRunner = async (task, options = {}) => {
      const readOnly = options.readOnly === true;
      const name = options.agent ?? (readOnly ? DEFAULT_ROLE.readOnly : DEFAULT_ROLE.writable);
      const profile = this.profiles.find((candidate) => candidate.name === name);
      if (!profile) throw new Error(`No sub-agent role '${name}'. Roles: ${this.profiles.map((candidate) => candidate.name).join(", ")}`);
      // A read-only call runs concurrently with its siblings, so it may only run a read-only role;
      // a writable role picked through it would write beside them unasked.
      if (readOnly && !profile.readOnly) throw new Error(`'${name}' can change files; run it with delegate_task`);
      await this.acquire();
      try {
        return await this.run(task, profile, parentTools, remainingRwf, options.toolCallId);
      } finally {
        this.release();
      }
    };
    return { runner, setTools: (tools) => { parentTools = tools; } };
  }

  private async run(task: string, profile: SubagentProfile, parentTools: AgentTool[], remainingRwf: () => number, parentToolCallId?: string): Promise<DelegateResult> {
    const host = this.host;
    const mode = host.mode();
    const capabilities = capabilitiesForMode(mode);
    const readOnlyCapabilities = capabilities.filter((id) => capabilitiesForMode("plan").includes(id));
    const tools = toolsForSubagent(profile, parentTools, readOnlyCapabilities);
    const base = await host.systemPrompt(profile.readOnly ? "plan" : mode, tools.map((tool) => tool.name));
    const systemPrompt = [base, profile.instructions, REPORT_CONTRACT].filter(Boolean).join("\n\n");
    const budgets = host.budgets();
    // A read-only sub-agent usually runs beside siblings, so it reserves a quarter of what is left
    // rather than half: three started together must all find something left. What concurrent
    // siblings already hold is not "left".
    const share = profile.readOnly ? 4 : 2;
    const reservation = Math.max(0, Math.min(remainingRwf() - this.inFlightRwf, budgets.maxRwf / share));
    this.inFlightRwf += reservation;
    const emit = (event: AgentRuntimeEvent) => {
      if (!parentToolCallId || !host.emit) return;
      if (event.type === "tool_result") {
        host.emit({ type: "subagent", parentToolCallId, agent: profile.name, event: { type: "tool_result", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, effect: event.effect, content: event.content.slice(0, VIEWER_RESULT_CHARS) } });
      } else if (event.type === "tool_call" || event.type === "model_turn" || event.type === "provider_retry") {
        host.emit({ type: "subagent", parentToolCallId, agent: profile.name, event });
      }
    };
    try {
      const runtime = new BoundedAgentRuntime({
        model: host.model(`delegate:${randomUUID()}`),
        tools,
        prices: host.prices,
        artifacts: host.artifacts,
        control: {
          heartbeat: async () => {},
          isCancellationRequested: async () => host.isCancelled(),
          isToolCallApproved: (call, tool) => host.approve(call, tool),
          persistEvent: async (event) => emit(event),
        },
      });
      const result = await runtime.execute({
        taskId: `${host.sessionId()}_delegate`,
        runId: host.sessionId(),
        stepId: `delegate_${randomUUID()}`,
        objective: task,
        history: [],
        systemPrompt,
        allowedCapabilityIds: profile.readOnly ? readOnlyCapabilities : capabilities,
        maxIterations: Math.min(profile.maxIterations, budgets.maxIterations),
        maxToolCalls: Math.min(profile.maxToolCalls, budgets.maxToolCalls),
        maxToolCallsPerTurn: budgets.maxToolCallsPerTurn,
        maxToolResultChars: budgets.maxToolResultChars,
        maxTotalToolResultChars: budgets.maxTotalToolResultChars,
        maxOutputTokens: budgets.maxOutputTokens,
        effort: profile.effort,
        modelReservationRwf: reservation,
        safetyIdentifier: `archymedes_cli_${host.sessionId()}_delegate`.slice(0, 64),
        signal: host.signal(),
        testFirst: !profile.readOnly && host.testFirst?.(mode) === true,
      });
      this.spentRwf += result.actualModelRwf;
      this.usage = addModelUsage(this.usage, result.usage);
      return { report: result.summary, status: result.status, iterations: result.iterations, toolCallsExecuted: result.toolCallsExecuted };
    } finally {
      this.inFlightRwf -= reservation;
    }
  }

  private async acquire(): Promise<void> {
    if (this.running < MAX_CONCURRENT) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else this.running -= 1;
  }
}
