/**
 * The hook lifecycle: every point in a session where a project's own scripts can observe or gate
 * what Archymedes does.
 *
 * Two granularities, deliberately distinct:
 * - **Tool hooks** (`pre_tool_use`/`post_tool_use`) fire around every tool call, built-in and
 *   external alike. A pre-hook exiting non-zero blocks the call; a post-hook's exit code cannot
 *   undo a side effect that already happened, so it only appends a warning.
 * - **Turn and session hooks** (`pre_turn`/`post_turn`, `pre_session`/`post_session`) fire around
 *   the coarser units a person actually thinks in — one request and its whole answer, and the
 *   session itself. They carry the same exit-code contract, so one script can gate a turn the same
 *   way it gates a tool call.
 *
 * The payload contract is the one Claude Code's own hooks use, and the reason is interoperability:
 * a hook script written for one works against the other. Each event travels to the script as one
 * JSON object, base64-encoded in `ARCHYMEDES_HOOK_EVENT_B64` (see `registry.ts`).
 */
export type HookEvent =
  | { event: "pre_tool_use"; toolName: string; arguments: Record<string, unknown> }
  | { event: "post_tool_use"; toolName: string; arguments: Record<string, unknown>; result: { content: string; isError: boolean } }
  | { event: "pre_turn"; objective: string }
  | { event: "post_turn"; objective: string; status: string; summary: string }
  | { event: "pre_session"; sessionId: string }
  | { event: "post_session"; sessionId: string };

/** The directory under a source (`.archymedes/hooks`, or a plugin's own) holding each phase's scripts. */
export type HookPhase = "pre-tool-use" | "post-tool-use" | "pre-turn" | "post-turn" | "pre-session" | "post-session";

/** Every phase, in lifecycle order — the order `HookRegistry.list` reports them in. */
export const HOOK_PHASES: readonly HookPhase[] = ["pre-session", "pre-turn", "pre-tool-use", "post-tool-use", "post-turn", "post-session"];

/** The outcome of a gating (pre-*) hook: allowed through, or blocked with the reason to show. */
export type HookGateOutcome = { blocked: false } | { blocked: true; reason: string };

/** The name this type had when only tool calls could be gated. Kept for existing importers. */
export type PreToolUseOutcome = HookGateOutcome;
