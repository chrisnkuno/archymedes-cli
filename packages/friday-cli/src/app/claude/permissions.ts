import type { AgentTool } from "@archymedes/core/agent-runtime";
import { forbiddenMessage, judgeCommand, type CommandRule } from "@archymedes/core/cli/command-rules";
import type { ArchymedesMode } from "@archymedes/core/cli/permissions";
import { assessToolSafety } from "@archymedes/core/cli/safety";

/**
 * Which of Claude Code's permission questions Friday answers itself, so Claude in a mode behaves
 * as Friday's own models do in it (`PermissionPolicy.decide` in core):
 *
 * - tools that change nothing never ask, in any mode — Friday's read_file, grep_files, web_search
 *   and web_fetch are `effect: "none"`. Claude Code asked about every web search, and in auto mode
 *   three searches at once each waited on a dialog;
 * - the person's command rules speak first: forbid refuses with the rule's reason, allow runs
 *   (except in defender mode, which looks at every change), ask always asks;
 * - auto mode runs a command without asking when Friday's safety screen finds nothing sensitive
 *   (credentials, destructive, external, financial, privacy, production, security). Edits are
 *   already Claude Code's own `acceptEdits`. A command leaving Claude Code's sandbox always asks.
 *
 * Undefined means ask the person.
 */
export type Screened = { behavior: "allow" } | { behavior: "deny"; message: string } | undefined;

/** Claude Code's tools with no effect outside reading the project or the web. */
const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "WebSearch", "WebFetch", "TodoWrite", "BashOutput", "ToolSearch"]);

/** Friday's run_command as the safety screen reads it: a workspace effect, judged by its command. */
const RUN_COMMAND = { name: "run_command", effect: "workspace" } as AgentTool;

export function screenToolUse(toolName: string, input: Record<string, unknown>, mode: ArchymedesMode, rules: readonly CommandRule[]): Screened {
  if (READ_ONLY.has(toolName)) return { behavior: "allow" };
  if (toolName !== "Bash" || typeof input.command !== "string") return undefined;
  const command = input.command;
  const ruled = judgeCommand(rules, command);
  if (ruled?.decision === "forbid") return { behavior: "deny", message: forbiddenMessage(command, ruled) };
  if (ruled?.decision === "allow" && mode !== "defender") return { behavior: "allow" };
  if (ruled?.decision === "ask" || input.dangerouslyDisableSandbox === true) return undefined;
  if (mode === "auto" && !assessToolSafety({ id: "", name: "run_command", arguments: { command } }, RUN_COMMAND).sensitive) return { behavior: "allow" };
  return undefined;
}
