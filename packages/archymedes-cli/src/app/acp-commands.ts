import type { ArchymedesAgent } from "@archymedes/core/cli/agent";
import type { CostLedger } from "@archymedes/core/cli/cost";

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
    default:
      return { kind: "error", text: `Unknown session command "${command}".` };
  }
}
