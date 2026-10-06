/**
 * Jev (TypeSafe System One) post-turn verdict.
 *
 * Jev is not a chat model and cannot drive an agent turn — it answers typed questions
 * (choice/score/noul) about a piece of text, with probabilities. This module is the
 * "intervene later" half: the CLI's own model does the work first, then Jev judges what
 * happened. The verdict is advisory — displayed with its probabilities, never a block —
 * because a probabilistic judge with a false positive must not strand a session.
 *
 * The wire contract follows the TypeSafe API: `POST /v1/systemone` with a Bearer key,
 * `{ state, model, questions }` in, `{ model, answers, usage }` out. No credential ever
 * enters an error message, a journal record, or a session snapshot: the key lives in the
 * call options alone.
 */

export const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 30_000;
/** Upper bound on the state sent for judgment. A turn summary, not a transcript dump. */
export const JEV_MAX_STATE_CHARS = 4_000;

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> };

export type JevUsage = { inputTokens: number; outputTokens: number };

export type JevResponse = { model: string; answers: Record<string, JevAnswer>; usage: JevUsage };

/** An HTTP failure whose status remains visible to the caller's fail-open policy. */
export class JevError extends Error {
  readonly retryable: boolean;
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "JevError";
    this.retryable = status === 429 || status >= 500;
  }
}

/**
 * The questions every post-turn verdict asks, in one place.
 *
 * TypeSafe's own guidance is that questions and thresholds are the part humans must
 * review, so they live as constants rather than being constructed at each call site.
 * `outcome` reads where the turn landed; `sensitive_action` is the second opinion that
 * stands beside the rule-based safety screen, with a probability instead of a regex.
 */
export const TURN_VERDICT_QUESTIONS: Record<string, JevQuestion> = {
  outcome: {
    type: "choice",
    instructions: "What is the state of this coding-agent turn?",
    criteria: {
      complete: "The task described was finished; nothing important is left undone",
      follow_up: "Progress was made but something still needs doing or verifying",
      blocked: "The turn is stuck: an error, refusal, or missing input stops it",
    },
  },
  sensitive_action: {
    type: "noul",
    instructions: "The turn took or proposed a sensitive action: deleting data, touching credentials, deploying or publishing, spending money, or contacting people outside the workspace",
  },
};

/** What the transcript shows: a verdict with probabilities, or an honest admission of none. */
export type JevTurnVerdict =
  | {
    status: "verdict";
    model: string;
    outcome: string;
    outcomeProbabilities: Record<string, number>;
    sensitiveAction: number;
    usage: JevUsage;
  }
  | { status: "unavailable"; reason: string };

/**
 * The question asked before an effectful tool runs.
 *
 * A fixed choice, because the tool list is dynamic and a choice needs fixed options:
 * `proceed` means this tool fits, `reconsider` means a different tool would fit better,
 * `stop` means no tool should run here. Advisory — it annotates the approval prompt,
 * it never denies on its own.
 */
export const TOOL_CHECK_QUESTIONS: Record<string, JevQuestion> = {
  tool_fit: {
    type: "choice",
    instructions: "Is this the right tool call for the task?",
    criteria: {
      proceed: "This tool call fits the task and looks safe to run",
      reconsider: "A different tool or different arguments would fit the task better",
      stop: "No tool should run here: the call looks mistaken, unsafe, or unrelated to the task",
    },
  },
};

/** The second opinion the approval gate consults, or undefined when Jev is unavailable. */
export type JevToolCheck = {
  fit: string;
  fitProbabilities: Record<string, number>;
  model: string;
};

/**
 * The most the judge may say about a call's arguments.
 *
 * Arguments can carry file contents and secrets; the judge needs to know *which* tool
 * with *what shape* of input, not the data itself. Bounded and documented rather than
 * complete.
 */
export const JEV_MAX_ARGS_CHARS = 1_500;

export function toolCheckState(input: { taskHint: string; toolName: string; toolDescription: string; toolArguments: unknown }): string {
  const args = JSON.stringify(input.toolArguments ?? {});
  return [
    `Task: ${input.taskHint.trim() || "(no task description)"}`,
    `Proposed tool: ${input.toolName} — ${input.toolDescription}`,
    `Arguments: ${args.length > JEV_MAX_ARGS_CHARS ? `${args.slice(0, JEV_MAX_ARGS_CHARS)}…(truncated)` : args}`,
  ].join("\n").slice(0, JEV_MAX_STATE_CHARS);
}

/** Reads one System One response as a pre-tool second opinion. */
export function toolCheckFromResponse(response: JevResponse): JevToolCheck | undefined {
  const fit = response.answers.tool_fit;
  if (!fit || fit.type !== "choice") return undefined;
  return { fit: fit.choice, fitProbabilities: fit.probabilities, model: response.model };
}

/**
 * What the approval gate holds: enough to ask, nothing that can spend.
 *
 * `checkTool` resolves to a second opinion or to undefined when Jev is unreachable,
 * misconfigured, or answered without one — the gate treats undefined as "no opinion"
 * and carries on with its rules and the human. Never rejects: a judge that throws
 * would turn every approval into a failure.
 */
export type JevJudge = {
  checkTool(input: { taskHint: string; toolName: string; toolDescription: string; toolArguments: unknown }): Promise<JevToolCheck | undefined>;
};

export function createJevJudge(options: {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: JevFetch;
}): JevJudge {
  return {
    async checkTool(input) {
      try {
        const response = await requestJevVerdict({
          apiKey: options.apiKey,
          ...(options.model ? { model: options.model } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          state: toolCheckState(input),
          questions: TOOL_CHECK_QUESTIONS,
        });
        return toolCheckFromResponse(response);
      } catch {
        return undefined;
      }
    },
  };
}

export type JevFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function probabilities(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    const scored = probability(item);
    if (scored === undefined || key.length === 0 || key.length > 128) return undefined;
    entries[key] = scored;
  }
  return entries;
}

function parseAnswer(name: string, value: unknown): JevAnswer {
  if (!isRecord(value)) throw new JevError(200, `Jev answer "${name}" is not an object`);
  const kind = value.type;
  if (kind === "noul") {
    const noul = probability(value.noul);
    if (noul === undefined) throw new JevError(200, `Jev answer "${name}" has no noul probability`);
    return { type: "noul", noul };
  }
  if (kind === "choice") {
    const options = probabilities(value.probabilities);
    const confidence = probability(value.confidence);
    if (typeof value.choice !== "string" || !options || confidence === undefined) throw new JevError(200, `Jev answer "${name}" is not a complete choice`);
    return { type: "choice", choice: value.choice, confidence, probabilities: options };
  }
  if (kind === "score") {
    const options = probabilities(value.probabilities);
    const confidence = probability(value.confidence);
    if (typeof value.score !== "number" || !Number.isFinite(value.score) || !options || confidence === undefined) throw new JevError(200, `Jev answer "${name}" is not a complete score`);
    const legend: Record<string, string> = {};
    if (isRecord(value.legend)) {
      for (const [key, item] of Object.entries(value.legend)) {
        if (typeof item !== "string") throw new JevError(200, `Jev answer "${name}" has a non-text legend`);
        legend[key] = item;
      }
    }
    return { type: "score", score: value.score, confidence, legend, probabilities: options };
  }
  throw new JevError(200, `Jev answer "${name}" has an unknown question type`);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function parseJevResponse(body: unknown): JevResponse {
  if (!isRecord(body)) throw new JevError(200, "Jev returned a body that is not an object");
  if (typeof body.model !== "string" || !body.model) throw new JevError(200, "Jev returned no model version");
  if (!isRecord(body.answers)) throw new JevError(200, "Jev returned no answers");
  const answers: Record<string, JevAnswer> = {};
  for (const [name, value] of Object.entries(body.answers)) answers[name] = parseAnswer(name, value);
  const usage = isRecord(body.usage) ? body.usage : undefined;
  const inputTokens = usage ? nonNegativeInteger(usage.input_tokens) : undefined;
  const outputTokens = usage ? nonNegativeInteger(usage.output_tokens) : undefined;
  if (inputTokens === undefined || outputTokens === undefined) throw new JevError(200, "Jev returned no measured token usage");
  return { model: body.model, answers, usage: { inputTokens, outputTokens } };
}

export async function requestJevVerdict(options: {
  apiKey: string;
  model?: string;
  state: string;
  questions?: Record<string, JevQuestion>;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: JevFetch;
}): Promise<JevResponse> {
  if (!options.apiKey.trim()) throw new JevError(401, "TYPESAFE_API_KEY is required for a Jev verdict");
  const state = options.state.trim();
  if (!state) throw new JevError(400, "Jev needs a non-empty turn summary to judge");
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? JEV_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  // Wrapped rather than cast: the global fetch already satisfies the structural Fetch
  // shape, and the double cast reaching for it is a budgeted type escape.
  const fetchImpl: JevFetch = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  let response: Awaited<ReturnType<JevFetch>>;
  try {
    response = await fetchImpl(JEV_API_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        state: state.slice(0, JEV_MAX_STATE_CHARS),
        model: options.model?.trim() || JEV_DEFAULT_MODEL,
        questions: options.questions ?? TURN_VERDICT_QUESTIONS,
      }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new JevError(503, error instanceof Error ? `Jev request failed: ${error.message}`.slice(0, 300) : "Jev request failed");
  }
  if (!response.ok) {
    throw new JevError(response.status, response.status === 401
      ? "TypeSafe rejected the key. Update TYPESAFE_API_KEY in archymedes settings."
      : response.status === 402
        ? "TypeSafe account quota is exhausted."
        : response.status === 429
          ? "Jev rate limit reached; the turn stands without a verdict."
          : `Jev returned HTTP ${response.status}; the turn stands without a verdict.`);
  }
  try {
    return parseJevResponse(await response.json());
  } catch (error) {
    if (error instanceof JevError) throw error;
    throw new JevError(200, "Jev returned a body that could not be read as a verdict");
  }
}

/** One observed tool execution, for the judge's "what actually ran" picture. */
export type TurnEvidence = {
  tool: string;
  command?: string;
  exitCode?: number;
  /** The verification rung the runtime credited the command with, when it passed. */
  kind?: string;
  isError: boolean;
};

/**
 * The state Jev judges: what was asked, what the model said last, and which tools it
 * reached for — bounded and free of tool outputs.
 *
 * Tool outputs are deliberately absent. They are the largest part of a transcript and the
 * likeliest to carry secrets; a verdict needs to know the turn *ran tests*, not their
 * full output. What leaves the machine is a summary, and it only leaves at all when a
 * key is configured.
 */
export function turnVerdictState(input: { objective: string; assistantText: string; toolNames: readonly string[]; evidence?: readonly TurnEvidence[] }): string {
  const tools = input.toolNames.length > 0 ? `Tools used: ${[...new Set(input.toolNames)].join(", ")}.` : "No tools used.";
  const lines = [
    `Task: ${input.objective.trim()}`,
    `Final answer: ${input.assistantText.trim()}`,
    tools,
  ];
  if (input.evidence && input.evidence.length > 0) {
    // The most recent executions say the most about where the turn landed: a judge
    // reading "17 file writes, ls" but not "the last `bun test` exited 1" learns
    // stability from the wrong row. Bounded hard — twelve lines is a verdict's worth.
    const recent = input.evidence.slice(-12);
    lines.push(`Execution evidence: ${recent.map((event) => {
      const what = event.command ? `"${event.command.slice(0, 80)}"` : event.tool;
      const verdict = event.exitCode !== undefined ? `exit ${event.exitCode}` : event.isError ? "failed" : "ok";
      return `${event.command ? `${event.tool} ${what}` : event.tool} → ${verdict}${event.kind ? ` (${event.kind})` : ""}`;
    }).join("; ")}`);
  }
  return lines.join("\n").slice(0, JEV_MAX_STATE_CHARS);
}

/** Reads one System One response as the transcript's verdict shape. */
export function verdictFromResponse(response: JevResponse): JevTurnVerdict {
  const outcome = response.answers.outcome;
  const sensitive = response.answers.sensitive_action;
  if (!outcome || outcome.type !== "choice" || !sensitive || sensitive.type !== "noul") {
    return { status: "unavailable", reason: "Jev returned no turn verdict" };
  }
  return {
    status: "verdict",
    model: response.model,
    outcome: outcome.choice,
    outcomeProbabilities: outcome.probabilities,
    sensitiveAction: sensitive.noul,
    usage: response.usage,
  };
}
