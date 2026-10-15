import type { AgentMessage } from "../agent-runtime";

/**
 * `/goal <condition>`: the agent keeps taking turns until the condition holds, as Claude Code's
 * `/goal` does. The interface drives the turns; after each one it asks for a verdict here. The
 * verdict is a separate, tool-less reading of the recent conversation — not the working model's own
 * "I'm done", which is the claim a goal exists to check.
 */

export type GoalStatus = "met" | "impossible" | "continue";

export type GoalVerdict = { status: GoalStatus; reason: string };

/** How much recent conversation the judge reads, at most. */
export const GOAL_EVIDENCE_CHARS = 24_000;

/** The first turn toward a goal, as the working model is asked it. */
export function goalPrompt(condition: string): string {
  return `Work until this condition is fully met: ${condition}\n\nKeep going on your own across steps; verify the condition yourself (run the checks that prove it) before you stop. If it cannot be met, say exactly why.`;
}

/** A following turn, with what the judge said is still missing. */
export function goalContinuation(condition: string, missing: string): string {
  return `Continue toward the goal: ${condition}\n\nNot met yet: ${missing}`;
}

export function goalJudgePrompt(condition: string, messages: readonly AgentMessage[]): string {
  return [
    "You judge whether a coding agent has met a goal, from its conversation. You do not do the work.",
    `The goal: ${condition}`,
    'Answer with JSON only: {"status":"met"|"impossible"|"continue","reason":"one sentence"}.',
    '"met" only when the conversation shows evidence the condition holds now (a passing run, the output, the file) — not merely the agent saying so. "impossible" only when the agent has shown it cannot be done in this environment. Otherwise "continue", and the reason says what is still missing.',
    "",
    "<conversation>",
    recentEvidence(messages),
    "</conversation>",
  ].join("\n");
}

/** The newest messages that fit, oldest first, tool output included: that is where evidence is. */
export function recentEvidence(messages: readonly AgentMessage[], limit = GOAL_EVIDENCE_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "system" || !message.content.trim()) continue;
    const who = message.role === "tool" ? `tool ${message.name}` : message.role;
    const text = message.content.length > 4_000 ? `${message.content.slice(0, 2_000)}\n…\n${message.content.slice(-2_000)}` : message.content;
    const line = `[${who}] ${text}`;
    if (used + line.length > limit && lines.length > 0) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join("\n\n");
}

/** Reads the judge; anything unreadable is "continue", so a garbled verdict never ends a goal early. */
export function parseGoalVerdict(text: string): GoalVerdict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as { status?: unknown; reason?: unknown };
      const status = value.status === "met" || value.status === "impossible" ? value.status : "continue";
      const reason = typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : status === "continue" ? "the verdict gave no reason" : "";
      return { status, reason };
    } catch {
      // fall through
    }
  }
  return { status: "continue", reason: text.trim().slice(0, 300) || "the verdict could not be read" };
}
