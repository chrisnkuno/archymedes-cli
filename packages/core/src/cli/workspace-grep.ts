import { constants as fsConstants, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { DEFAULT_WORKSPACE_LIMITS, WorkspaceViolation, escapeRegExp, looksBinary, walkWorkspace, globToRegExp, type WalkEntry, type WorkspaceLimits } from "./workspace";

/**
 * Content search across a local workspace: ripgrep when it is installed, the same search in-process
 * when it is not. Split out of workspace.ts (WS-29), which keeps containment, reads, writes and edits.
 */

/** The same, for the file reads a content search does. */
const GREP_CONCURRENCY = 32;

export type GrepMatch = { path: string; line: number; text: string };

/** `maxResults` defaults to 200; `ignoreCase` applies to fixed strings and patterns alike. */
export type GrepOptions = { include?: string; regex?: boolean; ignoreCase?: boolean; maxResults?: number };

let ripgrepLookup: Promise<string | null> | undefined;

/**
 * The `rg` binary on PATH, looked up once per process. `ARCHYMEDES_RIPGREP=0` (or `off`) disables
 * it; any other value is taken as an explicit path to the binary.
 */
export function findRipgrep(environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  ripgrepLookup ??= (async () => {
    const override = environment.ARCHYMEDES_RIPGREP?.trim();
    if (override && /^(0|off|false|no)$/i.test(override)) return null;
    if (override) return override;
    const names = process.platform === "win32" ? ["rg.exe"] : ["rg"];
    for (const directory of (environment.PATH ?? environment.Path ?? "").split(path.delimiter)) {
      if (!directory) continue;
      for (const name of names) {
        const candidate = path.join(directory.replace(/^"|"$/g, ""), name);
        try {
          await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
          return candidate;
        } catch {
          // Not here; keep looking.
        }
      }
    }
    return null;
  })();
  return ripgrepLookup;
}

/** Test hook: forget the cached `rg` lookup. */
export function resetRipgrepLookup(): void {
  ripgrepLookup = undefined;
}

/**
 * rg arguments equivalent to the JS search: hidden files included (the walk includes dotfiles), the
 * hard-coded ignore list excluded, the root .gitignore honoured even outside a git checkout, the
 * same per-file size limit, and path-sorted output so repeated searches are stable.
 */
export function ripgrepArguments(query: string, options: { include?: string; regex?: boolean; ignoreCase?: boolean; limits: WorkspaceLimits }): string[] {
  const args = ["--json", "--no-messages", "--hidden", "--no-require-git", "--no-ignore-parent", "--sort=path", "--max-filesize", String(options.limits.maxReadBytes)];
  for (const directory of options.limits.ignoredDirectories) args.push("--glob", `!${directory}`);
  // A superset of `globToRegExp`'s meaning (rg matches an unanchored glob at any depth); the exact
  // include matcher is re-applied to every result so the two paths agree.
  if (options.include) args.push("--glob", options.include);
  if (!options.regex) args.push("--fixed-strings");
  if (options.ignoreCase) args.push("--ignore-case");
  args.push("--regexp", query, "--", ".");
  return args;
}

/**
 * One line of `rg --json` output as a match, or null for every other message type.
 *
 * Text is kept exactly as the JS search reports it — the line without its `\n`, capped at 400
 * characters — and the path is normalised to root-relative forward slashes.
 */
export function parseRipgrepJsonLine(line: string): GrepMatch | null {
  if (!line.trim()) return null;
  let message: { type?: string; data?: { path?: { text?: string; bytes?: string }; line_number?: number; lines?: { text?: string; bytes?: string } } };
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (message.type !== "match" || !message.data) return null;
  const decode = (value?: { text?: string; bytes?: string }): string | undefined =>
    value?.text ?? (value?.bytes !== undefined ? Buffer.from(value.bytes, "base64").toString("utf8") : undefined);
  const rawPath = decode(message.data.path);
  const rawText = decode(message.data.lines);
  const lineNumber = message.data.line_number;
  if (rawPath === undefined || rawText === undefined || typeof lineNumber !== "number") return null;
  const relative = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return { path: relative, line: lineNumber, text: rawText.replace(/\n$/, "").slice(0, 400) };
}

/**
 * Runs `rg` and collects up to `maxResults` matches, or returns null when rg could not answer
 * (missing binary, a regex rg's engine rejects, any other error) so the caller falls back to the
 * JS search rather than reporting a false "no matches".
 */
async function ripgrepSearch(
  binary: string,
  root: string,
  query: string,
  options: { include?: string; regex?: boolean; ignoreCase?: boolean; maxResults: number; limits: WorkspaceLimits },
): Promise<GrepMatch[] | null> {
  const include = options.include ? globToRegExp(options.include) : null;
  const args = ripgrepArguments(query, options);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: GrepMatch[] | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, { cwd: path.resolve(root), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      finish(null);
      return;
    }
    const matches: GrepMatch[] = [];
    let pending = "";
    const consume = (line: string): void => {
      const match = parseRipgrepJsonLine(line);
      if (!match || (include && !include.test(match.path))) return;
      matches.push(match);
      if (matches.length >= options.maxResults) {
        child.kill();
        finish(matches);
      }
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (settled) return;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1 && !settled) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (settled) return;
      if (pending) consume(pending);
      if (settled) return;
      // 0: matches, 1: none. 2 is an error — trust it only if it still produced results.
      if (code === 0 || code === 1 || (code === 2 && matches.length > 0)) finish(matches);
      else finish(null);
    });
  });
}

/**
 * Content search across the workspace.
 *
 * Uses ripgrep when it is installed, and reads files directly when it is not: the CLI must behave
 * identically on a machine that does not have `rg`, and a search that silently finds nothing
 * because a binary is missing is the worst possible failure mode for an agent deciding what to
 * edit — so any rg failure falls back to the JS search rather than returning an empty result.
 * Pass `ripgrep: null` to force the JS search.
 */
export async function grepWorkspace(
  root: string,
  query: string,
  options: GrepOptions & { limits?: WorkspaceLimits; ripgrep?: string | null } = {},
): Promise<GrepMatch[]> {
  if (typeof query !== "string" || query === "") throw new WorkspaceViolation("query must be a non-empty string");
  const limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS;
  const maxResults = options.maxResults ?? 200;
  // Validate a regex with the JS engine first, so a malformed pattern fails the same way either way.
  // A case-insensitive fixed string is matched as an escaped pattern: same meaning, one code path.
  const matcher = options.regex || options.ignoreCase
    ? new RegExp(options.regex ? query : escapeRegExp(query), options.ignoreCase ? "i" : "")
    : null;
  const binary = options.ripgrep === undefined ? await findRipgrep() : options.ripgrep;
  if (binary) {
    const found = await ripgrepSearch(binary, root, query, { include: options.include, regex: options.regex, ignoreCase: options.ignoreCase, maxResults, limits });
    if (found) return found;
  }
  const include = options.include ? globToRegExp(options.include) : null;
  const matches: GrepMatch[] = [];
  /**
   * The literal being searched for, as bytes.
   *
   * A plain-text search can rule a file out without ever decoding it: `Buffer.indexOf` scans the
   * bytes as they were read, while `toString().split("\n")` allocates roughly three times the
   * file's size to produce a line array that is thrown away when nothing matches — and nothing
   * matches in the overwhelming majority of files. Only meaningful for a non-regex query, which is
   * the common one.
   */
  const literal = matcher ? null : Buffer.from(query, "utf8");

  /** Every match in one file, in line order. Returns an empty list for anything unreadable. */
  const scan = async (entry: WalkEntry): Promise<GrepMatch[]> => {
    let buffer: Buffer;
    try {
      const stat = await fs.stat(entry.absolute);
      if (stat.size > limits.maxReadBytes) return [];
      buffer = await fs.readFile(entry.absolute);
    } catch {
      return [];
    }
    if (looksBinary(buffer)) return [];
    if (literal && buffer.indexOf(literal) === -1) return [];
    const found: GrepMatch[] = [];
    const lines = buffer.toString("utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (matcher ? matcher.test(line) : line.includes(query)) {
        found.push({ path: entry.relative, line: index + 1, text: line.slice(0, 400) });
        if (found.length >= maxResults) break;
      }
    }
    return found;
  };

  /**
   * Files are read concurrently, and their matches are appended in walk order.
   *
   * Both halves matter. Reading one file at a time made the search latency-bound on a workload that
   * is almost entirely waiting; appending in completion order would have made two searches of an
   * unchanged tree return the same matches in a different sequence, which is a miserable thing to
   * diff and a needless cache invalidation upstream.
   */
  const batch: WalkEntry[] = [];
  const drain = async (): Promise<boolean> => {
    const scanned = await Promise.all(batch.splice(0, batch.length).map(scan));
    for (const fileMatches of scanned) {
      for (const match of fileMatches) {
        matches.push(match);
        if (matches.length >= maxResults) return true;
      }
    }
    return false;
  };

  for await (const entry of walkWorkspace(root, limits)) {
    if (entry.isDirectory) continue;
    if (include && !include.test(entry.relative)) continue;
    batch.push(entry);
    if (batch.length >= GREP_CONCURRENCY && await drain()) return matches;
  }
  await drain();
  return matches;
}
