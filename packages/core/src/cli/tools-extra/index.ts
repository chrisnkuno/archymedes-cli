import type { AgentTool } from "../../agent-runtime";
import { createGitTools } from "./git";
import { createImageTools } from "./image";
import { createNotebookTools } from "./notebook";
import { createRepoMapTools } from "./repo-map";
import { resolvedLimits, type ExtraToolOptions } from "./shared";
import { SymbolIndex } from "./symbols";

export type { ExtraToolOptions } from "./shared";
export { SymbolIndex, extractSymbols, languageForPath, type CodeSymbol, type Language, type SymbolKind } from "./symbols";
export { buildRepoMap, findDefinitions } from "./repo-map";
export { parsePorcelainV2, parseGitLog, runGit, validateRef } from "./git";
export { applyNotebookEdit, serializeNotebook, toSourceLines } from "./notebook";

/**
 * repo_map, find_symbol, git_status, git_diff, git_log, git_show, notebook_edit and view_image.
 *
 * Same `AgentTool` shape as `createArchymedesTools`; schemas use only the subset `tool-schema.ts`
 * validates, so the caller's final wrap (validation, instructions, hooks) applies unchanged.
 * They work on a local directory only — offer them when the workspace is `LocalWorkspace`.
 */
export function createExtraTools(options: ExtraToolOptions): AgentTool[] {
  const index = options.symbolIndex ?? new SymbolIndex(options.root, resolvedLimits(options));
  return [...createRepoMapTools(options, index), ...createGitTools(options), ...createNotebookTools(options), ...createImageTools(options)];
}
