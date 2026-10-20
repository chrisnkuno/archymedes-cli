/**
 * Intent-aware tool scoping shared by estimation and execution.
 * Conservative defaults preserve capability whenever a request is ambiguous.
 */
import type { ArchymedesMode } from "./permissions";
import type { AgentTool } from "../agent-runtime";

export type ToolProfile = "chat" | "read" | "full";

// The everyday ways to ask for a change. A verb missing here sends the request to the read-only
// profile, where the agent cannot do what was asked ("make a file", "put a spinner in app.tsx"), so the
// list errs wide: offering a write tool to a question costs a few tokens, withholding it fails the task.
const MUTATING = /\b(create|write|edit|change|modify|fix|implement|build|install|delete|remove|rename|move|run|test|commit|push|deploy|publish|send|continue|resume|update|add|refactor|replace|rewrite|append|insert|generate|format|upgrade|bump|revert|patch|migrate|scaffold|save|set up|setup|make|put|convert|clean|tidy|configure|enable|disable|extract|split|merge|apply|adjust|tweak|improve|optimi[sz]e|simplify|introduce|swap|wire|hook up|integrate|inline|dedupe|deduplicate|wrap|pull out|break up|turn into|hook)\b/i;
const REPOSITORY_READING = /\b(review|inspect|audit|analy[sz]e|diagnose|explain|find|locate|search|read|why|error|bug|code|repo(?:sitory)?|project|file|folder|function|class|test|diff)\b/i;
const DIRECT_CHAT = /^(?:hi|hello|hey|thanks|thank you|who are you|what can you do)[.!?\s]*$/i;
const EXACT_REPLY = /\b(?:reply|respond|say|output)\s+with\s+(?:exactly|only)\b/i;
/** A file name or path ("note.txt", "src/api"): the answer lives in the workspace, not the prompt. */
const MENTIONS_PATH = /(?:^|[\s"'`(])(?:[\w.-]+\/)*[\w-]+\.[a-z0-9]{1,8}\b|(?:^|\s)\.{0,2}\/[\w.-]+/i;

/** Conservative intent routing: uncertainty keeps the full toolset. */
export function toolProfileForObjective(objective: string, mode: ArchymedesMode): ToolProfile {
  const text = objective.trim();
  if (mode === "defender" || MUTATING.test(text)) return "full";
  const needsWorkspace = REPOSITORY_READING.test(text) || MENTIONS_PATH.test(text);
  if (DIRECT_CHAT.test(text)) return "chat";
  // "Reply with only X" constrains the answer's form, not where it comes from: "read note.txt and
  // reply with only the word" still needs a file tool. It means chat only when nothing points at the workspace.
  if (EXACT_REPLY.test(text) && !needsWorkspace) return "chat";
  if (needsWorkspace) return "read";
  return "full";
}

export function toolsForProfile(tools: readonly AgentTool[], profile: ToolProfile): AgentTool[] {
  if (profile === "full") return [...tools];
  if (profile === "chat") return [];
  return tools.filter((tool) => tool.effect === "none");
}
