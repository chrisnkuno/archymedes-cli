import { clip, heading, note, rule, type SectionStyle, type Tone } from "./sections";
import { UNICODE_GLYPHS } from "../text/glyphs";

/**
 * One place to see where the task stands: what was asked, the plan against it, what changed, what
 * was verified, and what is still in the way.
 *
 * The transcript answers "what just happened" turn by turn; this answers "are we there yet" for the
 * whole session. Every row names the command that produced it or that acts on it, so the view is a
 * set of handles rather than a status readout — a failing check points at nothing to do unless you
 * already know which command re-runs it.
 *
 * Pure, like `completion-card.ts` and the rest of `sections.ts`: it takes a snapshot and a style
 * and returns a string, so it is checked by comparing text.
 */

export type TaskPlanItem = { text: string; status: "pending" | "in_progress" | "done" | (string & {}) };
export type TaskChangedFile = { path: string; added: number; removed: number };
export type TaskCheck = { kind: string; passed: boolean };

export type TaskViewInput = {
  /** The opening request for the session, shown verbatim (clipped to width). */
  request?: string;
  plan: readonly TaskPlanItem[];
  files: readonly TaskChangedFile[];
  checks: readonly TaskCheck[];
  /** The most recent turn's status, so an unfinished or failed turn shows up as a blocker. */
  lastTurnStatus?: string;
};

const STATUS_MARK: Record<string, string> = { done: "done", in_progress: "wip", pending: "todo" };

function planMark(status: string): string {
  return (STATUS_MARK[status] ?? status.replace(/_/g, " ")).slice(0, 4);
}

/** The rows that stand between the current state and a finished, verified task. */
export function taskBlockers(input: TaskViewInput): string[] {
  const blockers: string[] = [];
  const open = input.plan.filter((item) => item.status !== "done").length;
  if (open > 0) blockers.push(`${open} plan step${open === 1 ? "" : "s"} open  -> /todos`);
  const failing = input.checks.filter((check) => !check.passed).map((check) => check.kind);
  if (failing.length > 0) blockers.push(`${failing.join(", ")} failing  -> re-run and /diff`);
  if (input.lastTurnStatus === "failed") blockers.push("last turn failed  -> /retry or /continue");
  if (input.lastTurnStatus === "needs_verification") blockers.push("last turn unverified  -> run the checks");
  return blockers;
}

export function renderTaskView(input: TaskViewInput, style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(24, style.width);
  const cell = { ...style, width };
  const middot = glyphs.middot;

  // Every line is clipped before it goes out: `heading` and `note` do not wrap, and a section
  // header carrying two or three command handles is exactly what overflows a narrow pane.
  const head = (text: string, level: 1 | 3, tone?: Tone) => heading(clip(text, width - 2, glyphs), level, cell, tone);
  const row = (text: string, tone?: Tone) => note(clip(text, width - 4, glyphs), cell, tone);

  const blockers = taskBlockers(input);
  const badge = blockers.length > 0
    ? `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`
    : input.plan.length > 0 || input.files.length > 0
      ? "on track"
      : "";
  const close = badge ? `\n${rule(cell, { label: badge })}` : "";

  const out: string[] = [head("task", 1, blockers.length > 0 ? "warn" : "accent")];

  const nothing = !input.request && input.plan.length === 0 && input.files.length === 0 && input.checks.length === 0;
  if (nothing) {
    out.push(row("nothing recorded yet — this fills in as the task moves"));
    return out.join("\n") + close;
  }

  if (input.request) {
    out.push(head("request", 3));
    out.push(row(input.request.replace(/\s+/g, " ").trim()));
  }

  if (input.plan.length > 0) {
    out.push(head(`plan ${middot} /todos`, 3));
    for (const item of input.plan.slice(0, 12)) {
      out.push(row(`${planMark(item.status).padEnd(4)} ${item.text}`, item.status === "done" ? "good" : "neutral"));
    }
    if (input.plan.length > 12) out.push(row(`${glyphs.ellipsis} ${input.plan.length - 12} more`));
  }

  if (input.files.length > 0) {
    const totalAdded = input.files.reduce((sum, file) => sum + file.added, 0);
    const totalRemoved = input.files.reduce((sum, file) => sum + file.removed, 0);
    out.push(head(`changed ${middot} /diff ${middot} /undo`, 3));
    for (const file of input.files.slice(0, 8)) {
      out.push(row(`${file.path}  +${file.added} ${glyphs.minus}${file.removed}`));
    }
    const more = input.files.length > 8 ? ` ${middot} ${input.files.length - 8} more` : "";
    out.push(row(`${input.files.length} file${input.files.length === 1 ? "" : "s"} ${middot} +${totalAdded} ${glyphs.minus}${totalRemoved}${more}`));
  }

  if (input.checks.length > 0) {
    out.push(head("verified", 3));
    out.push(row(
      input.checks.map((check) => `${check.kind} ${check.passed ? "passed" : "failed"}`).join(` ${middot} `),
      input.checks.some((check) => !check.passed) ? "bad" : "good",
    ));
  }

  if (blockers.length > 0) {
    out.push(head("blockers", 3, "warn"));
    for (const blocker of blockers) out.push(row(`! ${blocker}`, "bad"));
  }

  return out.join("\n") + close;
}
