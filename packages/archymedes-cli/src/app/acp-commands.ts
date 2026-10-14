import type { ArchymedesAgent } from "@archymedes/core/cli/agent";
import type { CostLedger } from "@archymedes/core/cli/cost";
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
