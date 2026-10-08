/**
 * Hooks: project-defined scripts that run at Archymedes's lifecycle points — before and after tool
 * calls, before and after whole turns, and around the session itself.
 *
 * Module map:
 * - `types.ts` — the `HookEvent` union and the phase list.
 * - `command.ts` — the per-shell invocation that passes a hook its event payload.
 * - `registry.ts` — discovery and execution (`HookRegistry`).
 */

export { HOOKS_DIRECTORY, HookRegistry } from "./registry";
export type { HookSource } from "./registry";
export { hookCommand } from "./command";
export { HOOK_PHASES } from "./types";
export type { HookEvent, HookPhase, HookGateOutcome, PreToolUseOutcome } from "./types";
