import type { ColorDepth } from "./banner";
import type { GlyphSet } from "./glyphs";
import type { SectionStyle } from "./sections";
import { box } from "./tui";
import { renderTaskView } from "./task-view";

/**
 * The read-only "where do things stand" commands — `/todos` and `/task` — as pure functions.
 *
 * This is the first extraction out of the REPL loop in `archymedes.ts`, and the safest kind: these
 * handlers only *read*. They never call the model, move the cost ledger, write a checkpoint, or
 * change the mode. Pulling them behind an explicit context (rather than the loop's dozens of
 * closed-over locals) is the seam every later handler extraction hangs off; doing it with the two
 * that cannot have side effects keeps the first step boring. The caller still owns output and the
 * "type /help" hint — everything here returns a string and touches nothing.
 */

export type InspectPlanItem = { text: string; status: "pending" | "in_progress" | "done" };

export type InspectContext = {
  /** From `sectionStyle()` — width, colour depth, glyphs and palette for the section renderers. */
  style: SectionStyle;
  glyphs: GlyphSet;
  depth: ColorDepth;
  /** `agent.todos`. */
  plan: readonly InspectPlanItem[];
  /** The session's opening request, or undefined before the first turn. */
  request?: string;
  /** Session-cumulative per-file line deltas, `[path, {added, removed}]`. */
  files: readonly (readonly [string, { added: number; removed: number }])[];
  /** Session-cumulative latest verification outcome per class, `[kind, passed]`. */
  checks: readonly (readonly [string, boolean])[];
  /** The last turn's status — only meaningful once a turn has actually run. */
  lastTurnStatus?: string;
  /** True once at least one turn has run, so a default status is not shown as a blocker. */
  turnsTaken: boolean;
};

/** `/todos`: the agent's plan, or null when there is no plan yet (the caller says so and hints). */
export function renderTodos(context: InspectContext): string | null {
  if (context.plan.length === 0) return null;
  const mark = { pending: context.glyphs.circleEmpty, in_progress: context.glyphs.circleHalf, done: context.glyphs.circleFull } as const;
  return box(
    context.plan.map((todo) => `${mark[todo.status]} ${todo.text}`),
    { depth: context.depth, title: "todos", glyphs: context.glyphs, palette: context.style.palette },
  );
}

/** `/task`: the whole-session review — request, plan, changes, verification, blockers. */
export function renderTask(context: InspectContext): string {
  return renderTaskView({
    request: context.request,
    plan: context.plan.map((todo) => ({ text: todo.text, status: todo.status })),
    files: [...context.files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, delta]) => ({ path, added: delta.added, removed: delta.removed })),
    checks: context.checks.map(([kind, passed]) => ({ kind, passed })),
    lastTurnStatus: context.turnsTaken ? context.lastTurnStatus : undefined,
  }, context.style);
}
