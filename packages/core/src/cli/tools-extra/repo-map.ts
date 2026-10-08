import type { AgentTool } from "../../agent-runtime";
import { ARCHYMEDES_CAPABILITIES } from "../permissions";
import { grepWorkspace } from "../workspace";
import { boundedInteger, directoryPrefix, oneOf, optionalString, requiredString, resolvedLimits, type ExtraToolOptions } from "./shared";
import { SymbolIndex, type CodeSymbol, type FileSymbols } from "./symbols";

export const REPO_MAP_DEFAULT_CHARS = 12_000;
export const REPO_MAP_MAX_CHARS = 60_000;

const ENTRY_NAMES = /(?:^|\/)(?:index|main|app|lib|mod|__init__|server|cli|program)\.[^/]+$/i;
const TEST_PATH = /(?:\.test\.|\.spec\.|_test\.go$|(?:^|\/)tests?\/|(?:^|\/)__tests__\/|Tests?\.cs$|Test\.java$|(?:^|\/)test_[^/]*\.py$)/;

/** Higher is more worth showing: exported API, entry points, shallow paths; tests rank last. */
export function rankFile(file: FileSymbols): number {
  const exported = file.symbols.filter((symbol) => symbol.exported && !symbol.parent).length;
  const depth = file.path.split("/").length - 1;
  // Public API dominates; a pile of private helpers adds a little, never enough to outrank it.
  const internal = file.symbols.length - exported;
  let score = exported * 3 + Math.min(internal, 6) * 0.5 - depth;
  if (ENTRY_NAMES.test(file.path)) score += 5;
  if (TEST_PATH.test(file.path)) score -= 10;
  return score;
}

function renderSymbol(symbol: CodeSymbol): string {
  return `${symbol.parent ? "    " : "  "}${symbol.line}: ${symbol.signature}`;
}

/** Most useful first: exported top-level declarations, then public members, then the rest. */
function symbolPriority(symbol: CodeSymbol): number {
  const tier = symbol.exported && !symbol.parent ? 0 : !symbol.parent ? 1 : symbol.exported ? 2 : 3;
  // Within a tier, behaviour (functions, classes, types) before plain values.
  return tier * 2 + (symbol.kind === "variable" || symbol.kind === "constant" ? 1 : 0);
}

/** One file's block with at most `cap` symbols (the most useful ones), in source order. */
function renderFileBlock(file: FileSymbols, cap: number): string {
  if (cap <= 0 || file.symbols.length === 0) return file.symbols.length > 0 ? `${file.path} (${file.symbols.length} symbol${file.symbols.length === 1 ? "" : "s"})` : file.path;
  const kept = file.symbols.length <= cap
    ? file.symbols
    : [...file.symbols].map((symbol, order) => ({ symbol, order })).sort((left, right) => symbolPriority(left.symbol) - symbolPriority(right.symbol) || left.order - right.order).slice(0, cap).sort((left, right) => left.order - right.order).map(({ symbol }) => symbol);
  const hidden = file.symbols.length - kept.length;
  const lines = [file.path, ...kept.map(renderSymbol)];
  if (hidden > 0) lines.push(`  … ${hidden} more symbol${hidden === 1 ? "" : "s"}`);
  return lines.join("\n");
}

/** Per-file symbol caps, raised one step at a time across all files. */
const SYMBOL_CAPS = [1, 2, 4, 8, 15, 30, 60];

/**
 * Picks how much of each file to show within `budget` characters.
 *
 * Every file starts as a bare path (with its symbol count); then the per-file cap is raised one
 * step at a time across all files, best-ranked first, while the budget lasts. Raising in rounds
 * rather than file by file means one 200-symbol file cannot crowd out the rest of the map. Test
 * files are only enriched after every other file has had its share. If even bare paths do not
 * all fit, the best-ranked paths are kept.
 */
function allocateBlocks(ranked: readonly FileSymbols[], budget: number): { blocks: Map<string, string>; used: number; omitted: number } {
  const sizeAt = (file: FileSymbols, cap: number) => renderFileBlock(file, cap).length + 1;
  const caps = new Map<string, number>();
  let used = 0;
  let omitted = 0;
  for (const file of ranked) {
    const size = sizeAt(file, 0);
    if (used + size > budget) { omitted += 1; continue; }
    caps.set(file.path, 0);
    used += size;
  }
  const placed = ranked.filter((file) => caps.has(file.path));
  const groups = [placed.filter((file) => !TEST_PATH.test(file.path)), placed.filter((file) => TEST_PATH.test(file.path))];
  for (const group of groups) {
    for (const cap of SYMBOL_CAPS) {
      for (const file of group) {
        const current = caps.get(file.path)!;
        if (file.symbols.length <= current) continue;
        const extra = sizeAt(file, cap) - sizeAt(file, current);
        if (used + extra <= budget) {
          caps.set(file.path, cap);
          used += extra;
        }
      }
    }
  }
  const blocks = new Map(placed.map((file) => [file.path, renderFileBlock(file, caps.get(file.path)!)]));
  return { blocks, used, omitted };
}

/** Plain files grouped by directory: `docs/ (3): a.md, b.md, c.md`. */
function renderOtherFiles(paths: readonly string[]): string[] {
  const byDirectory = new Map<string, string[]>();
  for (const filePath of paths) {
    const slash = filePath.lastIndexOf("/");
    const directory = slash === -1 ? "./" : `${filePath.slice(0, slash)}/`;
    const names = byDirectory.get(directory) ?? [];
    names.push(filePath.slice(slash + 1));
    byDirectory.set(directory, names);
  }
  return [...byDirectory.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([directory, names]) => `${directory} (${names.length}): ${names.join(", ")}`);
}

export type RepoMapResult = { content: string; data: Record<string, unknown> };

export async function buildRepoMap(
  index: SymbolIndex,
  options: { root: string; path?: string; query?: string; maxChars?: number },
): Promise<RepoMapResult> {
  const prefix = await directoryPrefix(options.root, options.path);
  const maxChars = options.maxChars ?? REPO_MAP_DEFAULT_CHARS;
  const query = options.query?.trim().toLowerCase();
  const entries = await index.files(prefix);
  const indexed = await index.symbolsForAll(entries);
  const indexedPaths = new Set(indexed.map((file) => file.path));

  let codeFiles: FileSymbols[] = indexed;
  let otherFiles = entries.map((entry) => entry.relative).filter((relative) => !indexedPaths.has(relative));
  if (query) {
    codeFiles = indexed.flatMap((file) => {
      if (file.path.toLowerCase().includes(query)) return [file];
      const symbols = file.symbols.filter((symbol) => symbol.name.toLowerCase().includes(query) || symbol.parent?.toLowerCase().includes(query));
      return symbols.length > 0 ? [{ ...file, symbols }] : [];
    });
    otherFiles = otherFiles.filter((relative) => relative.toLowerCase().includes(query));
  }

  const withSymbols = codeFiles.filter((file) => file.symbols.length > 0);
  const codeWithout = codeFiles.filter((file) => file.symbols.length === 0).map((file) => file.path);
  const scope = prefix || ".";
  const header = `Repo map of ${scope}${query ? ` matching "${options.query}"` : ""}: ${entries.length} file${entries.length === 1 ? "" : "s"}, ${withSymbols.length} with symbols.`;
  let remaining = maxChars - header.length - 120;

  const ranked = [...withSymbols].sort((left, right) => rankFile(right) - rankFile(left) || left.path.localeCompare(right.path));
  const allocation = allocateBlocks(ranked, Math.max(0, remaining));
  const chosen = allocation.blocks;
  let omitted = allocation.omitted;
  remaining -= allocation.used;

  const sections: string[] = [header];
  if (chosen.size > 0) sections.push([...chosen.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, block]) => block).join("\n"));
  const others: string[] = [];
  for (const line of renderOtherFiles([...codeWithout, ...otherFiles])) {
    if (line.length + 1 > remaining) { omitted += line.split(", ").length; continue; }
    others.push(line);
    remaining -= line.length + 1;
  }
  if (others.length > 0) sections.push(`Other files:\n${others.join("\n")}`);
  if (omitted > 0) sections.push(`[${omitted} more file${omitted === 1 ? "" : "s"} omitted to fit ${maxChars} chars; narrow with path or query, or raise maxChars.]`);
  if (chosen.size === 0 && others.length === 0) sections.push(query ? "No files or symbols matched." : "No files.");

  return {
    content: sections.join("\n\n"),
    data: {
      path: scope,
      query: options.query ?? null,
      totalFiles: entries.length,
      filesWithSymbols: withSymbols.length,
      shownFiles: chosen.size,
      omittedFiles: omitted,
      files: [...chosen.keys()].sort(),
    },
  };
}

export type SymbolDefinition = CodeSymbol & { path: string };

/** Definitions of `name` (or `Parent.name`), exact first, falling back to case-insensitive. */
export async function findDefinitions(index: SymbolIndex, options: { root: string; name: string; path?: string; kind?: string }): Promise<{ matches: SymbolDefinition[]; exact: boolean; similar: string[] }> {
  const prefix = await directoryPrefix(options.root, options.path);
  const files = await index.symbolsForAll(await index.files(prefix));
  const dot = options.name.lastIndexOf(".");
  const parent = dot > 0 ? options.name.slice(0, dot) : undefined;
  const name = dot > 0 ? options.name.slice(dot + 1) : options.name;
  const all: SymbolDefinition[] = files.flatMap((file) => file.symbols.map((symbol) => ({ ...symbol, path: file.path })));
  const kindOk = (symbol: SymbolDefinition) => !options.kind || symbol.kind === options.kind;
  const parentOk = (symbol: SymbolDefinition, fold: boolean) => !parent || (fold ? symbol.parent?.toLowerCase() === parent.toLowerCase() : symbol.parent === parent);
  let matches = all.filter((symbol) => symbol.name === name && parentOk(symbol, false) && kindOk(symbol));
  let exact = true;
  if (matches.length === 0) {
    exact = false;
    matches = all.filter((symbol) => symbol.name.toLowerCase() === name.toLowerCase() && parentOk(symbol, true) && kindOk(symbol));
  }
  const similar = matches.length > 0
    ? []
    : [...new Set(all.filter((symbol) => symbol.name.toLowerCase().includes(name.toLowerCase())).map((symbol) => (symbol.parent ? `${symbol.parent}.${symbol.name}` : symbol.name)))].slice(0, 15);
  // Exported definitions first: the one people mean is usually the public one.
  matches.sort((left, right) => Number(right.exported) - Number(left.exported) || left.path.localeCompare(right.path) || left.line - right.line);
  return { matches, exact, similar };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createRepoMapTools(options: ExtraToolOptions, index: SymbolIndex): AgentTool[] {
  const { root } = options;
  const limits = resolvedLimits(options);
  return [
    {
      name: "repo_map",
      description:
        "Codebase overview: file tree with each source file's top-level symbols, most relevant first. "
        + "Use it first in an unfamiliar repo instead of many list/read calls.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Subdirectory." },
          query: { type: "string", description: "Filter on paths and symbol names." },
          maxChars: { type: "integer", description: `Default ${REPO_MAP_DEFAULT_CHARS}, max ${REPO_MAP_MAX_CHARS}.` },
        },
        additionalProperties: false,
      },
      capabilityId: ARCHYMEDES_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        return buildRepoMap(index, {
          root,
          path: optionalString(args.path, "path"),
          query: optionalString(args.query, "query"),
          maxChars: boundedInteger(args.maxChars, "maxChars", REPO_MAP_DEFAULT_CHARS, 1_000, REPO_MAP_MAX_CHARS),
        });
      },
    },
    {
      name: "find_symbol",
      description:
        "Where a symbol is defined (file:line + signature), or its whole-word uses with mode 'references'. Better than grep for 'where is X defined'.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "e.g. 'parseConfig' or 'Server.start'." },
          mode: { type: "string", description: "'definitions' (default) or 'references'." },
          path: { type: "string", description: "Subdirectory." },
          kind: { type: "string", description: "e.g. function, class, method, type." },
          maxResults: { type: "integer" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      capabilityId: ARCHYMEDES_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const name = requiredString(args.name, "name").trim();
        const mode = oneOf(args.mode, "mode", ["definitions", "references"] as const, "definitions");
        const pathArgument = optionalString(args.path, "path");
        if (mode === "definitions") {
          const maxResults = boundedInteger(args.maxResults, "maxResults", 50, 1, 500);
          const found = await findDefinitions(index, { root, name, path: pathArgument, kind: optionalString(args.kind, "kind") });
          if (found.matches.length === 0) {
            const hint = found.similar.length > 0 ? ` Similar names: ${found.similar.join(", ")}.` : " Try mode 'references' or grep_files.";
            return { content: `No definition of '${name}' found.${hint}`, data: { name, mode, matches: [], similar: found.similar } };
          }
          const shown = found.matches.slice(0, maxResults);
          const lines = shown.map((match) => `${match.path}:${match.line}: [${match.kind}${match.parent ? ` in ${match.parent}` : ""}] ${match.signature}`);
          const notes: string[] = [];
          if (!found.exact) notes.push(`(no exact-case match; showing case-insensitive matches)`);
          if (found.matches.length > shown.length) notes.push(`[${found.matches.length - shown.length} more not shown]`);
          return {
            content: [...lines, ...notes].join("\n"),
            data: { name, mode, exact: found.exact, total: found.matches.length, matches: shown.map(({ path: filePath, line, kind, signature, parent, exported }) => ({ path: filePath, line, kind, signature, parent: parent ?? null, exported })) },
          };
        }

        const maxResults = boundedInteger(args.maxResults, "maxResults", 100, 1, 500);
        const identifier = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
        if (!identifier) throw new Error("name must contain an identifier");
        const prefix = await directoryPrefix(root, pathArgument);
        // Word boundaries only make sense next to word characters; `$`-names get explicit guards.
        const pattern = `(?:^|[^\\w$])${escapeRegExp(identifier)}(?:$|[^\\w$])`;
        const plainWord = /^\w+$/.test(identifier);
        const matches = await grepWorkspace(root, plainWord ? `\\b${escapeRegExp(identifier)}\\b` : pattern, {
          regex: true,
          include: prefix ? `${prefix}/**` : undefined,
          maxResults: maxResults + 1,
          limits,
          ripgrep: options.ripgrep,
        });
        const truncated = matches.length > maxResults;
        const shown = matches.slice(0, maxResults);
        if (shown.length === 0) return { content: `No references to '${identifier}' found.`, data: { name: identifier, mode, matches: [] } };
        const definitionLines = new Set((await findDefinitions(index, { root, name: identifier, path: pathArgument })).matches.filter((definition) => definition.name === identifier).map((definition) => `${definition.path}:${definition.line}`));
        const lines = shown.map((match) => `${match.path}:${match.line}:${definitionLines.has(`${match.path}:${match.line}`) ? " (definition)" : ""} ${match.text.trim().slice(0, 200)}`);
        const fileCount = new Set(shown.map((match) => match.path)).size;
        return {
          content: `${shown.length}${truncated ? "+" : ""} reference${shown.length === 1 ? "" : "s"} to '${identifier}' in ${fileCount} file${fileCount === 1 ? "" : "s"}:\n${lines.join("\n")}${truncated ? `\n[more references not shown; raise maxResults or narrow with path]` : ""}`,
          data: { name: identifier, mode, truncated, matches: shown.map((match) => ({ path: match.path, line: match.line, text: match.text, definition: definitionLines.has(`${match.path}:${match.line}`) })) },
        };
      },
    },
  ];
}
