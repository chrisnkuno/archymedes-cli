/**
 * How each free OpenRouter model actually behaves as an agent, measured rather than assumed.
 *
 * OpenRouter's listing says only whether a model accepts `tools`, and every free model that lists
 * it also produced well-formed structured calls when probed (2026-10-16, the 27 real tool schemas,
 * the request shape free-agent.ts sends): one call, a follow-up after a tool result, two calls in
 * one turn, and a plain-text answer once the work was done. What told the models apart was never
 * the call format. It was whether the model is served to this app at all, whether its upstream
 * accepts requests, how long it takes to say anything, and whether it is big enough to carry a task
 * across many turns (the wordcount task of benchmarks/speed/live/run-task.sh).
 *
 * So the fit is about those things, and it does two jobs: the router orders candidates by it
 * (and never sends a turn to a model only listed apps may use), and the model picker shows it, so
 * someone pinning a model knows what they are choosing. A pinned model is always honoured, whatever
 * its fit: the profile may be stale, and the person asked for it.
 *
 * Rows are measurements with a date, not opinions. A model not listed here is `unmeasured`, unless
 * its id names a chat-sized parameter count, which makes it chat-sized on the id alone.
 */
import { isSmallModel } from "./free-catalog";

export type FreeModelFit =
  /** Structured tool calls verified and answers quickly: what the router prefers. */
  | "agent"
  /** Verified calls, but the upstream refuses most requests (429/502): a fallback, not a first choice. */
  | "busy"
  /** Verified calls, but routinely a minute or more before the first token, or upstream timeouts. */
  | "slow"
  /** OpenRouter answers 403 "only available on agentic harnesses" unless the app is one it lists. */
  | "apps-only"
  /** Chat-sized: takes the first turn happily, then loses the thread over a multi-step task. */
  | "small"
  /** Not probed yet. Tried after the verified models, before the slow ones. */
  | "unmeasured";

export type FreeModelProfile = { fit: FreeModelFit; note: string };

/** When the rows below were measured (see the module comment for how). */
export const FREE_PROFILES_MEASURED = "2026-10-16";

const PROFILES: Readonly<Record<string, FreeModelProfile>> = {
  // Passed the end-to-end wordcount task (wall time in brackets) and every protocol probe.
  "nvidia/nemotron-3.5-super-vl:free": { fit: "agent", note: "tool calls verified; finished the test task in 78s" },
  "dots-studio/dots-3-note-preview:free": { fit: "agent", note: "tool calls verified; finished the test task in 104s" },
  "nvidia/nemotron-3-super-120b-a12b:free": { fit: "agent", note: "tool calls verified; finished the test task in 140s" },
  // Every probe clean and the fastest to answer; it ran out of time on the task's edge cases this round.
  "cohere/north-mini-code:free": { fit: "agent", note: "tool calls verified; first token in about a second" },
  // Calls fine whenever a request got through, but upstream refused most of them (429/502).
  "poolside/laguna-s-2.1:free": { fit: "busy", note: "tool calls verified; upstream rate-limits most requests" },
  "poolside/laguna-xs-2.1:free": { fit: "busy", note: "tool calls verified; upstream rate-limits most requests" },
  "google/gemma-4-31b-it:free": { fit: "busy", note: "upstream rate-limited 9 of 10 requests" },
  "google/gemma-4-26b-a4b-it:free": { fit: "busy", note: "upstream rate-limited 9 of 10 requests" },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": { fit: "busy", note: "tool calls verified; upstream capacity often exhausted" },
  "nvidia/nemotron-3.5-lightning:free": { fit: "slow", note: "tool calls verified, but 15s-3min before the first token" },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { fit: "slow", note: "every probe timed out upstream after 5 minutes" },
  "thinkingmachines/inkling:free": { fit: "apps-only", note: "OpenRouter serves it only to apps it lists; refused (403) here" },
  "thinkingmachines/inkling-small:free": { fit: "apps-only", note: "OpenRouter serves it only to apps it lists; refused (403) here" },
  "liquid/lfm-2.5-2.6b:free": { fit: "small", note: "2.6B: calls are well-formed, but 37 of 57 failed in the test task" },
};

/** The measured profile of a free model id, or what its id alone says about it. */
export function freeModelProfile(id: string): FreeModelProfile {
  return PROFILES[id] ?? (isSmallModel(id)
    ? { fit: "small", note: "chat-sized: fine for chat, but it often misuses tools" }
    : { fit: "unmeasured", note: "tool calling not measured yet" });
}

const TIER: Readonly<Record<FreeModelFit, number | null>> = { agent: 0, unmeasured: 1, busy: 2, slow: 3, small: 4, "apps-only": null };

/** The last tier the router uses while a better one is listed: slow and small models only when nothing else is. */
export const FREE_ROUTABLE_TIER = 2;

/**
 * Where the router puts a model: lower goes first, and `null` means the router never picks it.
 *
 * A tier is above recent health: a slow model answers every request in the end, which is a perfect
 * success rate that still costs a minute a turn, and a chat-sized one answers "hello" without error all
 * day. Neither may outrank a fast, capable model that happened to be refused once. A busy model is
 * kept as a fallback: its refusals are quick, so the router moves past one in a second.
 */
export function freeRoutingTier(id: string): number | null {
  return TIER[freeModelProfile(id).fit];
}
