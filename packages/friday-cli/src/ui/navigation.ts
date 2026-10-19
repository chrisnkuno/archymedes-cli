import type { Suggestion as EngineSuggestion } from "@archymedes/core/cli/suggestions";
import { defaultSignals, suggest as suggestFromSignals, type SessionSignals, type SuggestionCategory } from "@archymedes/core/cli/suggestions";
import { note, type SectionStyle } from "../render/sections";
import { clipTo } from "../text/text-width";
import { UNICODE_GLYPHS } from "../text/glyphs";

/**
 * The handful worth learning first.
 *
 * Every other command in this file is grouped by *what it is for*, which is the right question
 * once you know your way around and the wrong one on day one: forty rows sorted into six honest
 * categories still reads as forty rows. What a newcomer needs is not a better taxonomy, it is a
 * much shorter list — the few commands they will actually reach for before they have a reason to
 * look for any of the others.
 *
 * Chosen by necessity rather than by popularity. Each of these answers a question that *will* come
 * up in a first session and that nothing else in the interface answers:
 *
 * - `/help` — where is everything (the way back out of being lost)
 * - `/mode` — may it write to my files, or only read (the question people ask before trusting it)
 * - `/diff` — what did it just change
 * - `/undo` — take that back (the safety net; without it, nothing above is safe to try)
 * - `/model` — run this on something else
 * - `/cost` — what is this costing me
 * - `/exit` — leave, knowing the session is saved
 *
 * Deliberately not a ranking of everything: a list where the seventh item is "essential" is a list
 * whose first item is not. Additions should have to displace something.
 */
export const ESSENTIAL_COMMANDS: readonly string[] = ["/help", "/history", "/model", "/mode", "/diff", "/undo", "/settings", "/exit"];

/** Whether a command is one of the few a first session actually needs. */
export function isEssential(command: string): boolean {
  return ESSENTIAL_COMMANDS.includes(command);
}

/**
 * Everything the suggester is allowed to know, in the CLI's own vocabulary.
 *
 * A projection of `SessionSignals` from the core package rather than a second set of rules: the
 * rules now live in one place and the desktop reads the same ones. What stays here is the mapping —
 * this is where a terminal's idea of "what happened" becomes the surface-neutral signals the engine
 * takes, and where a suggestion comes back as the slash command a reader can actually type.
 */
export type NavContext = {
  mode: "plan" | "build" | "auto" | "defender";
  /** Turns completed in this session. Zero means nothing has happened yet. */
  turns: number;
  /** Files the agent has touched since the last checkpoint. */
  changedFiles: number;
  openTodos: number;
  runningJobs: number;
  tabs: number;
  sandbox: boolean;
  providerConfigured: boolean;
  /** True once the session has spent anything worth looking at. */
  hasSpend: boolean;
  /** Findings the last scan reported, if one has run. */
  openFindings?: number;
  /** How the last turn ended, if one has — what makes a hint after a failure a way out of *that* failure. */
  lastStatus?: SessionSignals["lastStatus"];
  /** The error text from the last failure, so recovery can be specific rather than "try again". */
  lastError?: string | null;
  /** Fraction of a session budget spent, when one is set. */
  budgetFraction?: number;
  /** Commands used this session, most recent first. */
  recent: readonly string[];
};

/** The CLI context as the engine's signals. Commands used count as suggestions taken. */
export function navSignals(context: NavContext): SessionSignals {
  return defaultSignals({
    mode: context.mode,
    turns: context.turns,
    changedFiles: context.changedFiles,
    openTodos: context.openTodos,
    runningJobs: context.runningJobs,
    tabs: context.tabs,
    sandbox: context.sandbox,
    providerConfigured: context.providerConfigured,
    hasSpend: context.hasSpend,
    taken: context.recent,
    ...(context.openFindings !== undefined ? { openFindings: context.openFindings } : {}),
    ...(context.lastStatus !== undefined ? { lastStatus: context.lastStatus } : {}),
    ...(context.lastError !== undefined ? { lastError: context.lastError } : {}),
    ...(context.budgetFraction !== undefined ? { budgetFraction: context.budgetFraction } : {}),
  });
}

export type Suggestion = {
  command: string;
  /** Why *now* — shown beside the command, because a suggestion without a reason teaches nothing. */
  reason: string;
};

/**
 * What to do next, given where the session actually is — as commands this terminal can run.
 *
 * A thin projection of the shared engine: it asks for the categories a prompt should carry (a
 * blocking setup problem, a way out of a failure, the next ordinary step) and drops the ambient
 * teaching hints, which have their own quieter moment in `suggestHints`. Anything without a slash
 * command — "open a project", "try that again" — is filtered out by the engine itself, because it
 * has no desktop-free spelling here.
 */
export function suggestNext(context: NavContext, limit = 3): Suggestion[] {
  return fromEngine(context, ["blocked", "recovery", "next"], limit);
}

/**
 * The ambient half: a capability this session has not used that now applies.
 *
 * Kept apart from `suggestNext` on purpose. A next step is about the work in front of the reader
 * and is worth interrupting for; a teaching hint is not, and mixing the two would push the thing
 * they need under the thing they might one day like.
 */
export function suggestHints(context: NavContext, limit = 1): Suggestion[] {
  return fromEngine(context, ["discover"], limit);
}

function fromEngine(context: NavContext, categories: readonly SuggestionCategory[], limit: number): Suggestion[] {
  return suggestFromSignals(navSignals(context), { surface: "cli", limit, categories })
    .flatMap((suggestion) =>
      suggestion.action.kind === "command" ? [{ command: suggestion.action.command, reason: suggestion.reason }] : [],
    );
}

/**
 * The commands used this session, most recent first, without duplicates.
 *
 * In memory and session-scoped on purpose. Ranking by a history that outlives the session sounds
 * better and is worse: it makes the palette's order depend on work the user has since forgotten,
 * and the order of a menu that changes for reasons you cannot see is the definition of an interface
 * you cannot learn.
 */
export class CommandUsage {
  private readonly order: string[] = [];

  constructor(private readonly limit = 12) {}

  record(command: string): void {
    const name = command.trim().split(/\s+/)[0];
    if (!name.startsWith("/")) return;
    const existing = this.order.indexOf(name);
    if (existing >= 0) this.order.splice(existing, 1);
    this.order.unshift(name);
    if (this.order.length > this.limit) this.order.length = this.limit;
  }

  get recent(): readonly string[] {
    return this.order;
  }
}

/**
 * The suggestion block printed where a turn ends: what to do next, and one thing worth knowing.
 *
 * Two rows at most for the work itself, because a third is where a hint stops being read — and one
 * ambient row beneath it only when the situation was quiet enough not to need two. The ambient row
 * is the "everywhere" half of being suggestive: it is how `/memory`, `/files` and `/tab` get found
 * by someone who never opens `/help`, and it is deliberately the first thing dropped when the
 * session has something more urgent to say.
 */
export function renderSuggestions(
  context: NavContext,
  style: SectionStyle,
  options: { limit?: number; hints?: boolean } = {},
): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(16, style.width - 4);
  const limit = Math.max(0, options.limit ?? 2);
  const next = suggestNext(context, limit);
  // Ambient teaching only in the space a next step did not need. A hint printed *under* two things
  // the reader has to decide about is a third thing to skip past, and the row people learn to skip
  // is the row nothing can ever be taught in again.
  const hints = options.hints && next.length < limit ? suggestHints(context, 1) : [];
  const rows = [...next, ...hints];
  if (rows.length === 0) return "";
  return rows
    .map((suggestion) => note(clipTo(`${suggestion.command} ${glyphs.middot} ${suggestion.reason}`, width, glyphs), style))
    .join("\n");
}

/**
 * One quiet teaching line, for a moment when a command had nothing of its own to say.
 *
 * An empty result — no plan yet, nothing changed since the checkpoint — is a whole screen of
 * attention spent on a single dim sentence. It is the cheapest place in the product to teach
 * something, and the only cost of doing it there is a line nobody was reading anyway.
 */
export function renderHint(context: NavContext, style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const [hint] = suggestHints(context, 1);
  if (!hint) return "";
  return note(clipTo(`${hint.command} ${glyphs.middot} ${hint.reason}`, Math.max(16, style.width - 4), glyphs), style);
}

/**
 * The way out of a failure, printed under the error that caused it.
 *
 * An error message says what broke; this says what to do about it, which is a different sentence
 * and the one a reader actually needs. Nothing is printed when the failure is not one the rules
 * recognise — a made-up next step after a real error is worse than silence, because it costs a
 * detour to find out it was a guess.
 */
export function renderRecovery(context: NavContext, style: SectionStyle, limit = 2): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(16, style.width - 4);
  const rows = suggestNext(context, limit);
  if (rows.length === 0) return "";
  return rows
    .map((suggestion) => note(clipTo(`${suggestion.command} ${glyphs.middot} ${suggestion.reason}`, width, glyphs), style, "warn"))
    .join("\n");
}

/**
 * The model's extra suggestions, printed under the rules' own.
 *
 * Rendered differently on purpose: these are requests to *make*, not commands to run, and they are
 * guesses. The quote marks say the first thing and the mark says the second — a generated line that
 * looks exactly like a rule borrows credibility the rules earned by being checkable.
 */
export function renderAsks(suggestions: readonly EngineSuggestion[], style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(16, style.width - 4);
  return suggestions
    .flatMap((suggestion) =>
      suggestion.action.kind === "prompt"
        ? [note(clipTo(`~ "${suggestion.label}" ${glyphs.middot} ${suggestion.reason}`, width, glyphs), style)]
        : [],
    )
    .join("\n");
}
