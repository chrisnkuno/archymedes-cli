import type { ArchymedesAgent, ContextUsage } from "@archymedes/core/cli/agent";
import type { CostLedger } from "@archymedes/core/cli/cost";
import { goalContinuation, goalPrompt } from "@archymedes/core/cli/goal";
import { addMemory, clearMemories, forgetMemory, loadMemories, type MemoryKind } from "@archymedes/core/cli/memory";

/**
 * The session commands a drawing client asks for over `_archymedes/session/command`: the data
 * behind `/cost`, `/diff`, `/undo` and `/todos`, with presentation left to the client. Each answer
 * is plain data or plain text — never terminal escapes — because the client draws it.
 */

export type SessionCommandResult =
  | { kind: "text"; text: string }
  | { kind: "diff"; patch: string }
  | { kind: "todos"; items: Array<{ text: string; status: string }> }
  /** The turns that can be rewound to, oldest first: `index` is what `rewind` and `diff turn` take. */
  | { kind: "turns"; turns: Array<{ index: number; label: string; createdAt: number }> }
  /** `/review`: findings worst first, and a sentence on the change as a whole. */
  | { kind: "review"; target: string; findings: Array<{ file: string; line?: number; severity: string; title: string; body: string }>; overall: string }
  /** `/fork`: the new session the conversation was copied into, for the client to open. */
  | { kind: "forked"; id: string; title: string }
  /** `/goal`: the turn to send (`prompt`), or the verdict after one (`goal-check`). */
  | { kind: "goal"; status: "met" | "impossible" | "continue"; reason: string; next?: string }
  | { kind: "error"; text: string };

export async function runSessionCommand(
  command: string,
  argument: string,
  session: { agent: ArchymedesAgent; ledger: CostLedger },
): Promise<SessionCommandResult> {
  switch (command) {
    case "cost":
      return { kind: "text", text: session.ledger.formatReport() };
    case "diff": {
      const turn = /^turn\s+(\d+)$/.exec(argument.trim());
      if (turn) {
        const patch = await session.agent.turnPatch(Number(turn[1]));
        return patch.trim() ? { kind: "diff", patch } : { kind: "text", text: "That turn changed no files." };
      }
      const patch = argument === "stat" ? await session.agent.diffStat() : await session.agent.diffPatch();
      if (!patch.trim()) return { kind: "text", text: "Nothing changed since the last checkpoint." };
      return argument === "stat" ? { kind: "text", text: patch } : { kind: "diff", patch };
    }
    case "undo": {
      const scope = argument === "code" || argument === "conversation" ? argument : argument === "" ? "both" : null;
      if (scope === null) return { kind: "error", text: `/undo takes no argument, "code", or "conversation" — not "${argument}".` };
      const restored = await session.agent.undo(scope);
      if (!restored) return { kind: "text", text: "Nothing to undo." };
      const verb = scope === "code" ? "Reverted the files for" : scope === "conversation" ? "Rewound the conversation before" : "Reverted";
      return { kind: "text", text: `${verb} "${restored.label}".` };
    }
    case "goal-prompt":
      return { kind: "goal", status: "continue", reason: "", next: goalPrompt(argument) };
    case "goal-check": {
      const verdict = await session.agent.checkGoal(argument);
      return { kind: "goal", ...verdict, ...(verdict.status === "continue" ? { next: goalContinuation(argument, verdict.reason) } : {}) };
    }
    case "context":
      return { kind: "text", text: formatContextUsage(await session.agent.contextUsage()) };
    case "compact": {
      const result = await session.agent.compactNow(argument);
      if (!result) return { kind: "text", text: "Too little conversation to summarize yet." };
      const saved = Math.max(result.tokensBefore - result.tokensAfter, 0);
      return { kind: "text", text: `Summarized the earlier conversation: ${result.messagesBefore} messages → ${result.messagesAfter}, about ${saved.toLocaleString("en-US")} tokens freed.${argument.trim() ? ` Kept in focus: ${argument.trim()}.` : ""}` };
    }
    case "review": {
      const result = await session.agent.review(argument);
      return "error" in result ? { kind: "error", text: result.error } : { kind: "review", ...result };
    }
    case "turns":
      return { kind: "turns", turns: session.agent.listCheckpoints().map((checkpoint, index) => ({ index, label: checkpoint.label, createdAt: checkpoint.createdAt })) };
    case "rewind": {
      const [position = "", scopeWord = ""] = argument.trim().split(/\s+/);
      const index = Number(position);
      const scope = scopeWord === "code" || scopeWord === "conversation" ? scopeWord : scopeWord === "" ? "both" : null;
      if (!/^\d+$/.test(position) || scope === null) return { kind: "error", text: `/rewind takes a turn number and optionally "code" or "conversation" — not "${argument}".` };
      const restored = await session.agent.rewind(index, scope);
      if (!restored) return { kind: "error", text: `No turn ${index} to rewind to.` };
      const what = scope === "code" ? "the files" : scope === "conversation" ? "the conversation" : "the files and the conversation";
      return { kind: "text", text: `Rewound ${what} to before "${restored.label}".` };
    }
    case "todos": {
      const items = session.agent.todos.map((item) => ({ text: item.text, status: item.status }));
      return items.length > 0 ? { kind: "todos", items } : { kind: "text", text: "No plan yet." };
    }
    case "memory":
      return memoryCommand(argument, session.agent.workspaceLabel);
    case "tools": {
      const { tools } = await session.agent.inspectTools();
      const lines = tools.map((tool) => `${tool.name.padEnd(24)} ${tool.requiresApproval ? "asks first  " : "            "}${tool.description.split(/(?<=\.)\s/)[0]}`);
      return { kind: "text", text: `${tools.length} tools\n${lines.join("\n")}` };
    }
    default:
      return { kind: "error", text: `Unknown session command "${command}".` };
  }
}

/** `/context` as a small table: each part, its share of the window, and what is left. */
export function formatContextUsage(usage: ContextUsage): string {
  const used = usage.parts.reduce((sum, part) => sum + part.tokens, 0);
  const free = Math.max(usage.window - usage.reservedForAnswer - used, 0);
  const number = (value: number) => value.toLocaleString("en-US");
  const share = (value: number) => `${((value / Math.max(usage.window, 1)) * 100).toFixed(1).padStart(5)}%`;
  const width = Math.max(...usage.parts.map((part) => part.label.length), "kept for the answer".length);
  const row = (label: string, value: number) => `${label.padEnd(width)}  ${number(value).padStart(9)}  ${share(value)}`;
  return [
    `${number(used)} of ${number(usage.window)} tokens in use (${share(used).trim()}); about ${number(free)} free`,
    "",
    ...usage.parts.filter((part) => part.tokens > 0).map((part) => row(part.label, part.tokens)),
    row("kept for the answer", usage.reservedForAnswer),
    row("free", free),
    "",
    "Estimates. /compact [focus] summarizes the conversation to free room.",
  ].join("\n");
}

const MEMORY_KINDS: readonly MemoryKind[] = ["preference", "convention", "decision", "lesson", "fact"];

/**
 * `/memory` — list what the agent remembers, or `add [user] [kind] <text>`, `forget <n>`, `clear`.
 * Project scope by default: what is learned about this folder belongs to it; `user` is for habits.
 */
async function memoryCommand(argument: string, root: string): Promise<SessionCommandResult> {
  const environment = process.env;
  const [verb = "", ...rest] = argument.trim().split(/\s+/);
  try {
    if (verb === "" || verb === "list") {
      const entries = await loadMemories(root, environment);
      if (entries.length === 0) return { kind: "text", text: "Nothing remembered yet. /memory add <text> saves a fact for this project." };
      return { kind: "text", text: entries.map((entry) => `${entry.scope === "user" ? "user   " : "project"} ${entry.index}. [${entry.kind}${entry.pinned ? ", pinned" : ""}] ${entry.text}`).join("\n") };
    }
    if (verb === "add") {
      const scope = rest[0] === "user" ? "user" : "project";
      if (rest[0] === "user" || rest[0] === "project") rest.shift();
      const kind = MEMORY_KINDS.find((candidate) => candidate === rest[0]);
      if (kind) rest.shift();
      const change = await addMemory(scope, rest.join(" "), root, environment, kind ? { kind } : {});
      return { kind: "text", text: change.changed ? `Remembered (${scope}).` : "Already remembered, or nothing to add." };
    }
    if (verb === "forget") {
      const scope = rest[0] === "user" ? "user" : "project";
      const index = Number(rest[rest.length - 1]);
      if (!Number.isInteger(index)) return { kind: "error", text: "/memory forget [user] <number> — see /memory for the numbers." };
      const change = await forgetMemory(scope, index, root, environment);
      return { kind: "text", text: change.removed ? `Forgot: ${change.removed.text}` : `No ${scope} memory numbered ${index}.` };
    }
    if (verb === "clear") {
      const scope = rest[0] === "user" ? "user" : "project";
      return { kind: "text", text: (await clearMemories(scope, root, environment)).changed ? `Cleared ${scope} memory.` : `${scope} memory was already empty.` };
    }
    return { kind: "error", text: `/memory takes list, add <text>, forget <n> or clear — not "${verb}".` };
  } catch (error) {
    return { kind: "error", text: error instanceof Error ? error.message : String(error) };
  }
}
