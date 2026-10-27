import type { ThinkingEffort } from "./agent-runtime";

/**
 * Predicting how hard the model needs to think before each call.
 *
 * Reasoning is paid for in seconds. Measured on real free-model sessions it is worth it on some calls
 * and wasted on others: a model that has just been told a test failed has something to work out, while
 * one that has just written the file it planned only has to say "now run the tests". A fixed effort
 * gets one of those wrong; this decides per call, from signals the runtime already holds, instantly
 * and without a network round trip (a round trip per call would cost more than the thinking it saves).
 *
 * The answer is a *request*, not a promise: a provider that does not accept an effort ignores it.
 */

export type ToolOutcome = {
  tool: string;
  isError: boolean;
  /** The error was a fix-the-arguments mistake (wrong path, unknown parameter), not a failed piece of work. */
  shallow?: boolean;
  /** A passing verification this call produced, by strength. */
  verified?: "check" | "tests" | "smoke" | "behavior";
};

export type EffortSignals = {
  /** 1-based model call within this run. */
  iteration: number;
  /** The task, as the person wrote it. */
  objective: string;
  /** What the tools returned since the previous model call. Empty on the first call. */
  lastResults: readonly ToolOutcome[];
  /** Model calls in a row whose results included a substantive failure. */
  consecutiveFailures: number;
  /** A strong verification has passed and nothing has been edited since. */
  greenSinceEdit: boolean;
  /**
   * Something has failed in substance and no strong verification has passed since: the model is
   * debugging, and everything it reads or decides in that state is about finding the cause.
   */
  unresolvedFailure?: boolean;
  /** Jev's read of the task, when it has answered. Only ever nudges the floor or ceiling. */
  difficultyHint?: Difficulty;
};

export type Difficulty = "routine" | "involved" | "hard";

/**
 * `effort: undefined` means "no opinion": send no effort and let the provider's own default apply.
 * That is the answer whenever thinking matters, because measured on real runs the default is the best
 * a model does on hard work (see `predictEffort`): the policy exists to save time where that is
 * safe, not to second-guess the model where it is not.
 */
export type EffortDecision = { effort: ThinkingEffort | undefined; reason: string };

const HARD_TASK = /\b(debug|fail(?:s|ed|ing|ure|ures)?|bugs?|broken|crash\w*|not working|doesn'?t work|find out|diagnos\w*|root[- ]cause|why (?:is|does|did|are|do|won'?t|isn'?t)|refactor\w*|architect\w*|design\w*|migrat\w*|security|vulnerab\w*|performance|optimi[sz]\w*|race condition|deadlock|investigat\w*|figure out|rewrite|algorithm|concurren\w*|memory leak|flaky|intermittent)\b/i;
const CHATTER = /^\s*(?:hi|hello|hey|yo|thanks?|thank you|ok(?:ay)?|cool|nice|good (?:morning|evening)|how are you)\b/i;

/** How demanding the task reads, from its own words. Cheap and deterministic. */
export function classifyObjective(objective: string): "trivial" | "routine" | "hard" {
  const text = objective.trim();
  if (HARD_TASK.test(text) || text.length > 700) return "hard";
  if (text.length <= 48 && (CHATTER.test(text) || !/[./\\]|\b(?:file|function|test|bug|fix|add|create|write|build|run|install|update|change|remove|delete|implement)\b/i.test(text))) return "trivial";
  return "routine";
}

/** Mistakes the model fixes by reading the message: they need a correction, not thought. */
const SHALLOW_ERROR = /does not exist|has no parameter|is a directory|not found in|no such file|escapes the workspace|requires |must be |is not available|oldText|identical|too large|outside the|unknown (?:application|tool)|looks like a binary/i;

export function isShallowToolError(content: string): boolean {
  return SHALLOW_ERROR.test(content.slice(0, 600));
}

const READ_ONLY = new Set(["read_file", "list_files", "glob_files", "grep_files", "find_symbol", "scan_secrets", "application_status", "web_fetch", "web_search"]);
const EDITING = new Set(["write_file", "edit_file", "notebook_edit"]);

const ORDER: ThinkingEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const rank = (effort: ThinkingEffort) => ORDER.indexOf(effort);
const atLeast = (effort: ThinkingEffort, floor: ThinkingEffort) => (rank(effort) >= rank(floor) ? effort : floor);
const atMost = (effort: ThinkingEffort, ceiling: ThinkingEffort) => (rank(effort) <= rank(ceiling) ? effort : ceiling);

/**
 * The policy, in the order it is applied. It lowers the effort only where thinking is wasted, and
 * otherwise sends none, so the model uses its own default:
 *
 * 1. The first call plans the whole piece of work. Chatter needs none and an ordinary request a
 *    little; anything that reads as debugging, design or refactoring gets the provider's default.
 * 2. After a failed piece of work (a test run that exits non-zero, a build that breaks) the model has
 *    to understand why: default, and it stays at default while the failure is open, including while it
 *    reads code, because that is debugging.
 * 3. After a mistake in the arguments (wrong path, unknown parameter) it only has to correct them: low.
 * 4. After results that went fine it is mostly acting: editing and running ordinary commands needs
 *    almost none, reading files a little (the default while something is still broken or the task is
 *    hard), and writing the summary after a green test run needs none.
 *
 * Why not simply choose "medium" or "high" for the hard parts: measured on the same debugging task,
 * a model at its default took 9-20 calls (54-92 s); forced to "minimal" it took 14-49 (72-202 s); and a
 * policy that picked "low" for reads and "medium" for failures took 15-29 (87-255 s). On a routine task
 * the same lowering made it faster. So: save time on the routine, stay out of the way on the hard.
 *
 * Jev's difficulty reading, when it has arrived, moves the floor up (it says the task is hard) or the
 * ceiling down (it says the task is routine); it never overrides evidence from the run itself.
 */
export function predictEffort(signals: EffortSignals): EffortDecision {
  const decision = decide(signals);
  const hint = signals.difficultyHint;
  // A hard task never gets less than "low" while things go fine; "no opinion" already means the default.
  if (hint === "hard" && signals.iteration > 1 && signals.consecutiveFailures === 0 && !signals.greenSinceEdit && decision.effort !== undefined) {
    const raised = atLeast(decision.effort, "low");
    return raised === decision.effort ? decision : { effort: raised, reason: `${decision.reason}; Jev says the task is hard` };
  }
  if (hint === "routine" && signals.consecutiveFailures === 0 && !signals.unresolvedFailure) {
    const capped = decision.effort === undefined ? "low" as const : atMost(decision.effort, "low");
    return capped === decision.effort ? decision : { effort: capped, reason: `${decision.reason}; Jev says the task is routine` };
  }
  return decision;
}

function decide(s: EffortSignals): EffortDecision {
  if (s.iteration <= 1 || s.lastResults.length === 0) {
    const kind = classifyObjective(s.objective);
    if (kind === "hard") return { effort: undefined, reason: "a task that reads as debugging, design or refactoring: the model's own default" };
    if (kind === "trivial") return { effort: "minimal", reason: "a short, simple message" };
    return { effort: s.difficultyHint === "hard" ? undefined : "low", reason: "an ordinary request: plan briefly" };
  }
  const substantive = s.lastResults.filter((result) => result.isError && !result.shallow);
  if (substantive.length > 0) {
    return { effort: undefined, reason: s.consecutiveFailures >= 2 ? `${s.consecutiveFailures} failures in a row: work out what is really wrong` : `${substantive[0].tool} failed: understand why` };
  }
  if (s.lastResults.some((result) => result.isError)) return { effort: "low", reason: "a mistake in the arguments: correct it" };
  if (s.greenSinceEdit) return { effort: "minimal", reason: "verified: summarize" };
  if (s.lastResults.some((result) => READ_ONLY.has(result.tool))) {
    if (s.unresolvedFailure) return { effort: undefined, reason: "reading code while something is still broken: find the cause" };
    if (classifyObjective(s.objective) === "hard") return { effort: undefined, reason: "reading code for a hard task: understand it" };
    return { effort: "low", reason: "reading: take it in" };
  }
  if (s.lastResults.every((result) => EDITING.has(result.tool))) return { effort: "minimal", reason: "edits went through: continue the plan" };
  return { effort: "low", reason: "routine step succeeded" };
}

/**
 * `ARCHYMEDES_REASONING`: `auto`, a fixed level, or undefined for each provider's own default.
 * `xhigh` and `max` (Claude Code's and Codex's deepest levels) are `high` here, the deepest this
 * engine sends, so choosing more never quietly means the default. Anything else is ignored.
 */
export function reasoningFromEnvironment(environment: Record<string, string | undefined>): "auto" | "minimal" | "low" | "medium" | "high" | undefined {
  const value = environment.ARCHYMEDES_REASONING?.trim().toLowerCase();
  if (value === "xhigh" || value === "max") return "high";
  return value === "auto" || value === "minimal" || value === "low" || value === "medium" || value === "high" ? value : undefined;
}
