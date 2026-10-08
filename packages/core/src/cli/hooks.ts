/**
 * Compatibility shim: hooks now live in `../hooks/`, and this module re-exports them unchanged.
 *
 * The implementation moved so that the full hook lifecycle (tool, turn and session phases) lives in
 * one layer under `src/` with MCP and skills, rather than beside the CLI's own command handlers.
 * Existing imports — this package's `index.ts`, `external-tools.ts`, `tools.ts` and the tests that
 * pin the tool-hook behaviour — keep working against the same names.
 */
export { HOOKS_DIRECTORY, HookRegistry, hookCommand } from "../hooks";
export type { HookEvent, HookSource, HookPhase, HookGateOutcome, PreToolUseOutcome } from "../hooks";
