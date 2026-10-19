import type { AgentTool } from "../agent-runtime";
import type { ArchymedesWorkspace } from "./backends";
import { ARCHYMEDES_CAPABILITIES } from "./permissions";
import { COMBINED_SECRET_PATTERN, findSecretsInLine, SEVERITY_RANK, type SecretFinding } from "./secret-scan";
import { optionalInteger, requiredString } from "./tool-args";
import { displayPath, resolveInWorkspace } from "./workspace";
import type { GrepMatch } from "./workspace-grep";

/**
 * The search tools: list_files, glob_files, grep_files and scan_secrets. Read-only, parallel-safe,
 * never asked about. Split out of tools.ts (WS-29), the first family of the split WS-27.10 plans.
 */

const LIST_ENTRY_CAP = 400;
const GREP_SHOWN = 100;
const GREP_MAX = 500;
const GLOB_SHOWN = 150;

/**
 * The root-relative, slash-separated prefix a `list_files` path means.
 *
 * Models routinely send an absolute path (`/home/me/project`), `./src/` or `.`; the listing compares
 * against root-relative entries, so an unnormalised absolute path matched nothing and came back as
 * "No entries." Local workspaces resolve it properly (and refuse a path outside the root); remote
 * ones only get the lexical clean-up, since their filesystem is not this machine's.
 */
export function listPrefix(raw: string, localRoot: string | null): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === ".") return "";
  if (localRoot !== null) {
    const relative = displayPath(localRoot, resolveInWorkspace(localRoot, trimmed));
    return relative === "." ? "" : relative;
  }
  return trimmed.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

export type PlacedSecretFinding = SecretFinding & { path: string; line: number };

/**
 * The `scan_secrets` tool's own logic, exported so a UI surface (`friday.ts`'s `/scan`) can run the
 * identical scan directly — without spending a model turn, and without the two ever drifting into
 * scanning slightly different things. Sorted worst-first: a findings list a person reads top to
 * bottom should read most-consequential first, the same convention `DEFENDER_PLAYBOOKS`' own
 * category ordering already follows.
 */
export async function scanWorkspaceForSecrets(workspace: Pick<ArchymedesWorkspace, "grep">, include?: string): Promise<PlacedSecretFinding[]> {
  const matches = await workspace.grep(COMBINED_SECRET_PATTERN.source, { regex: true, include });
  const findings = matches.flatMap((match) => findSecretsInLine(match.text).map((finding) => ({ path: match.path, line: match.line, ...finding })));
  return findings.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]);
}

/**
 * Matches with the lines around them, grouped by file the way `rg -C` prints: `12:` a match,
 * `11-` context, `--` between separate stretches. Each file is read once; one that cannot be read
 * falls back to its bare matches.
 */
async function withContext(workspace: ArchymedesWorkspace, matches: readonly GrepMatch[], context: number): Promise<string> {
  const byFile = new Map<string, number[]>();
  for (const match of matches) byFile.set(match.path, [...(byFile.get(match.path) ?? []), match.line]);
  const blocks: string[] = [];
  for (const [file, lines] of byFile) {
    const text = await workspace.readFile(file).then((read) => read.content.split("\n"), () => null);
    if (!text) {
      blocks.push(`${file}\n${matches.filter((match) => match.path === file).map((match) => `${match.line}: ${match.text}`).join("\n")}`);
      continue;
    }
    const hit = new Set(lines);
    const out: string[] = [file];
    let previous = 0;
    for (const line of lines) {
      const from = Math.max(1, line - context, previous + 1);
      const to = Math.min(text.length, line + context);
      if (previous && from > previous + 1) out.push("--");
      for (let at = from; at <= to; at += 1) out.push(`${at}${hit.has(at) ? ":" : "-"} ${text[at - 1]}`);
      previous = Math.max(previous, to);
    }
    blocks.push(out.join("\n"));
  }
  return blocks.join("\n\n");
}

/** The search family, in the order the tool contract lists them. */
export function searchTools(workspace: ArchymedesWorkspace): AgentTool[] {
  return [
    {
      name: "list_files",
      description: "List files and directories under a path in the project.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, depth: { type: "integer", description: "Directory levels to descend. Default 2." } },
        additionalProperties: false,
      },
      capabilityId: ARCHYMEDES_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const prefix = listPrefix(typeof args.path === "string" ? args.path : "", workspace.kind === "local" ? workspace.label : null);
        const entries = await workspace.list(prefix, optionalInteger(args.depth, "depth") ?? 2);
        // Name the path in the empty case: "No entries." for a directory that was never there reads
        // as an empty project, and a model that believes that stops looking.
        if (entries.length === 0) {
          return { content: prefix ? `${prefix} is empty, ignored, or does not exist. Paths are relative to the project root; list "." to see the top level.` : "No entries. The project root is empty (or everything in it is ignored).", data: { entries } };
        }
        const capped = entries.length >= LIST_ENTRY_CAP;
        return { content: capped ? `${entries.join("\n")}\n[Listing capped at ${LIST_ENTRY_CAP} entries; list a subdirectory or lower depth to see the rest.]` : entries.join("\n"), data: { entries, truncated: capped } };
      },
    },
    {
      name: "glob_files",
      description: "Find files whose path matches a glob, e.g. 'src/**/*.ts' or '**/*.{js,ts}'. Optional path limits it to one directory (the pattern is then relative to it).",
      inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "Directory to search in. Default: project root." } }, required: ["pattern"], additionalProperties: false },
      capabilityId: ARCHYMEDES_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const directory = listPrefix(typeof args.path === "string" ? args.path : "", workspace.kind === "local" ? workspace.label : null);
        const pattern = requiredString(args.pattern, "pattern").replace(/^(\.\/)+/, "");
        const matches = await workspace.glob(directory ? `${directory}/${pattern}` : pattern);
        if (matches.length === 0) {
          return { content: directory ? `No files matched ${pattern} under ${directory}. Try "**/*" there, or list_files on it.` : "No files matched.", data: { matches } };
        }
        // A long list costs more context than it is worth and a model cannot act on 500 names;
        // show a screenful and say how to narrow.
        const shown = matches.slice(0, GLOB_SHOWN);
        const more = matches.length - shown.length;
        const note = more > 0 ? `\n[${more} more matched. Narrow it: pass path for one directory, or a more specific pattern.]` : "";
        return { content: shown.join("\n") + note, data: { matches, truncated: more > 0 } };
      },
    },
    {
      name: "grep_files",
      description:
        "Search file contents (ripgrep). Fixed string unless regex. Narrow with path and include. "
        + "output: content (matching lines, default), files (paths only), count (per file). context adds lines around each match.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to find, or a regular expression with regex: true." },
          path: { type: "string", description: "File or directory to search. Default: project root." },
          include: { type: "string", description: "Glob for file names, e.g. '*.ts' (any depth) or 'src/**/*.tsx'." },
          regex: { type: "boolean" },
          ignoreCase: { type: "boolean" },
          output: { type: "string", enum: ["content", "files", "count"] },
          context: { type: "integer", description: "Lines before and after each match (content output), up to 10." },
          limit: { type: "integer", description: `Most matching lines shown. Default ${GREP_SHOWN}, max ${GREP_MAX}.` },
        },
        required: ["query"],
        additionalProperties: false,
      },
      capabilityId: ARCHYMEDES_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const query = requiredString(args.query, "query");
        const output = typeof args.output === "string" ? args.output : "content";
        if (!["content", "files", "count"].includes(output)) throw new Error(`output must be content, files or count (got ${output})`);
        const context = Math.min(optionalInteger(args.context, "context") ?? 0, 10);
        const limit = Math.min(optionalInteger(args.limit, "limit") ?? GREP_SHOWN, GREP_MAX);
        const directory = listPrefix(typeof args.path === "string" ? args.path : "", workspace.kind === "local" ? workspace.label : null);
        // A bare '*.ts' means any depth, as it does to ripgrep and .gitignore; matched from the root
        // it found only top-level files, and "No matches." sent the model looking for the wrong thing.
        const rawInclude = typeof args.include === "string" && args.include.trim() ? args.include.trim().replace(/^(\.\/)+/, "") : undefined;
        const fileGlob = rawInclude && !rawInclude.includes("/") ? `**/${rawInclude}` : rawInclude;
        const search = (include: string | undefined) => workspace.grep(query, {
          include, regex: args.regex === true, ignoreCase: args.ignoreCase === true,
          // Files and counts need every match to be right; lines are shown only up to the limit.
          maxResults: output === "content" ? limit + 1 : GREP_MAX * 4,
        });
        let matches = await search(directory ? `${directory}/${fileGlob ?? "**"}` : fileGlob);
        // `path` may name a file rather than a directory.
        if (matches.length === 0 && directory && !fileGlob) matches = await search(directory);
        if (matches.length === 0) {
          const where = [directory && `under ${directory}`, rawInclude && `in ${rawInclude}`].filter(Boolean).join(" ");
          return { content: `No matches${where ? ` ${where}` : ""}.${args.regex === true || args.ignoreCase === true ? "" : " Fixed-string and case-sensitive: try ignoreCase, or regex for a pattern."}`, data: { matches: [] } };
        }
        if (output === "files" || output === "count") {
          const counts = new Map<string, number>();
          for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
          const capped = matches.length >= GREP_MAX * 4;
          const rows = [...counts].map(([path, count]) => (output === "files" ? path : `${path}: ${count}`));
          const head = `${counts.size} file${counts.size === 1 ? "" : "s"}${output === "count" ? `, ${matches.length} match${matches.length === 1 ? "" : "es"}` : ""}${capped ? " (at least; the search stopped early)" : ""}`;
          return { content: `${head}\n${rows.join("\n")}`, data: { files: [...counts].map(([path, count]) => ({ path, count })), truncated: capped } };
        }
        const shown = matches.slice(0, limit);
        const more = matches.length > limit ? `\n[More matches than the ${limit} shown. Narrow with path or include, raise limit, or use output "files".]` : "";
        const data = { matches: shown.map((match) => ({ path: match.path, line: match.line, text: match.text })), truncated: more !== "" };
        if (context === 0) return { content: shown.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") + more, data };
        return { content: (await withContext(workspace, shown, context)) + more, data };
      },
    },
    {
      name: "scan_secrets",
      description: "Scan files for likely hardcoded credentials (keys, tokens, passwords). Values are masked in the output.",
      inputSchema: {
        type: "object",
        properties: { include: { type: "string", description: "Glob limiting which files are scanned, e.g. 'src/**'." } },
        additionalProperties: false,
      },
      capabilityId: ARCHYMEDES_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const include = typeof args.include === "string" ? args.include : undefined;
        const findings = await scanWorkspaceForSecrets(workspace, include);
        if (findings.length === 0) {
          return { content: "No likely secrets found by pattern in the scanned files.", data: { findings: [] } };
        }
        const content = findings.map((finding) => `${finding.path}:${finding.line}: [${finding.severity}] ${finding.kind} — ${finding.masked}`).join("\n");
        return {
          content: `${findings.length} possible secret${findings.length === 1 ? "" : "s"} found by pattern, worst first — verify each; a pattern match is a lead, not proof.\n${content}`,
          data: { findings },
        };
      },
    },
  ];
}
