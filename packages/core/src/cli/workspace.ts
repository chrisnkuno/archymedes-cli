import { constants as fsConstants, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Dirent } from "node:fs";

/**
 * The filesystem boundary for Archymedes CLI.
 *
 * Every other part of the CLI reaches the disk through this module, because the CLI runs against a
 * developer's real working tree rather than a disposable sandbox. In the hosted product the E2B
 * container is the boundary — a mistake there costs a container. Here a mistake costs the user's
 * files, so path confinement is enforced in code rather than by the environment.
 *
 * Both OpenCode and Cline settled on the same rule and it is the one adopted here: resolve
 * everything to an absolute path and refuse anything that escapes the project root, including via
 * `..` or a symlink pointing outward.
 */

export type WorkspaceLimits = {
  /** Largest file the agent may read in one call. */
  maxReadBytes: number;
  /** Largest file the agent may write in one call. */
  maxWriteBytes: number;
  /** Files skipped by search and listing, by directory name. */
  ignoredDirectories: readonly string[];
  /**
   * Strips anything shaped like a credential (`*_TOKEN`, `*_SECRET`, ...) from a locally spawned
   * command's environment, not only Archymedes's own known provider keys. Off by default — see
   * `sanitizeCommandEnvironment` in command.ts for why a project's own env vars are the user's
   * choice to expose, not Archymedes's to withhold, unless they opt into the stricter posture.
   */
  strictCommandEnvironment?: boolean;
  /**
   * Runs a locally spawned command inside an unprivileged PID namespace when the OS supports one,
   * so a timeout or cancellation reaches every process it spawned — including ones it detached from
   * itself — not only the ones still in its original process group. On by default wherever the OS
   * supports it (checked once and cached; a no-op fallback everywhere else). Set to `false` only for
   * a command that is known to need to see the host's real, unnamespaced PID/mount view.
   */
  containProcessTree?: boolean;
};

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxReadBytes: 512_000,
  maxWriteBytes: 512_000,
  // Generated output, every one of them. `coverage/` alone was 2.85 MB across 92 files in this
  // repository — 30% of every byte `grep_files` read, none of it code anyone wrote. They also churn
  // as builds and test runs come and go, which is its own cost upstream in the prompt.
  ignoredDirectories: [".git", "node_modules", ".next", "dist", "build", "target", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", "vendor", ".archymedes", "coverage", "test-results", ".convex", ".wrangler"],
};

export class WorkspaceViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceViolation";
  }
}

/**
 * Resolves a candidate path against the workspace root, refusing anything outside it.
 *
 * Lexical resolution only — this deliberately does not touch the disk, so it can be applied to
 * paths that do not exist yet (a file the agent is about to create). `realPathWithin` handles the
 * symlink case for paths that do exist.
 */
export function resolveInWorkspace(root: string, candidate: string): string {
  if (typeof candidate !== "string" || !candidate.trim()) throw new WorkspaceViolation("path must be a non-empty string");
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, candidate);
  if (resolved !== absoluteRoot && !resolved.startsWith(absoluteRoot + path.sep)) {
    throw new WorkspaceViolation(`path escapes the workspace root: ${candidate}`);
  }
  return resolved;
}

/**
 * Confinement for paths that exist, following symlinks first.
 *
 * A symlink inside the tree pointing at `/etc/shadow` passes the lexical check above and would
 * otherwise hand its contents to the model. Non-existent paths fall back to the lexical result,
 * which is correct: nothing can be read through a link that is not there.
 */
export async function realPathWithin(root: string, candidate: string): Promise<string> {
  const resolved = resolveInWorkspace(root, candidate);
  const absoluteRoot = await fs.realpath(path.resolve(root)).catch(() => path.resolve(root));
  const real = await fs.realpath(resolved).catch(() => null);
  if (real === null) return resolved;
  if (real !== absoluteRoot && !real.startsWith(absoluteRoot + path.sep)) {
    throw new WorkspaceViolation(`path resolves outside the workspace root: ${candidate}`);
  }
  // Preserve the caller's lexical spelling after using the canonical path for confinement.
  // macOS commonly canonicalizes /var to /private/var; returning that spelling would make a
  // workspace-relative result look as though it escaped through several parent directories.
  return resolved;
}

/** Path as the user would recognise it — relative to the root, forward-slashed. */
export function displayPath(root: string, absolute: string): string {
  const relative = path.relative(path.resolve(root), absolute);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

const BINARY_SNIFF_BYTES = 4_096;

/** A NUL byte in the first few KB is how `git` and every editor decide a file is not text. */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export type ReadResult = {
  path: string;
  content: string;
  /** 1-based line the returned slice starts at. */
  startLine: number;
  totalLines: number;
  truncated: boolean;
};

/**
 * Reads a text file, optionally a line window of it.
 *
 * Line windows exist because a 6,000-line file read whole is usually a context-budget mistake, not
 * a request for the whole file — but the window is opt-in, since silently returning part of a file
 * the model believes it read in full is worse than spending the tokens.
 */
export async function readTextFile(
  root: string,
  candidate: string,
  options: { offset?: number; limit?: number; limits?: WorkspaceLimits } = {},
): Promise<ReadResult> {
  const limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS;
  const absolute = await realPathWithin(root, candidate);
  // A missing file must fail the same shape every backend fails it: a project-relative path in a
  // sentence, not a raw ENOENT carrying this machine's absolute filesystem layout. Node's default
  // error for a missing `stat` is exactly that leak — one more path a model reading a "file not
  // found" message across Local, E2B and Docker would otherwise see worded three different ways.
  const stat = await fs.stat(absolute).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceViolation(`${displayPath(root, absolute)} does not exist`);
    throw error;
  });
  if (stat.isDirectory()) throw new WorkspaceViolation(`${displayPath(root, absolute)} is a directory, not a file`);
  if (stat.size > limits.maxReadBytes) {
    throw new WorkspaceViolation(`${displayPath(root, absolute)} is ${stat.size} bytes, above the ${limits.maxReadBytes}-byte read limit`);
  }
  const buffer = await fs.readFile(absolute);
  if (looksBinary(buffer)) throw new WorkspaceViolation(`${displayPath(root, absolute)} looks like a binary file`);

  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  const startLine = Math.max(1, options.offset ?? 1);
  const limit = options.limit;
  if (startLine === 1 && limit === undefined) {
    return { path: displayPath(root, absolute), content: text, startLine: 1, totalLines: lines.length, truncated: false };
  }
  const slice = lines.slice(startLine - 1, limit === undefined ? undefined : startLine - 1 + limit);
  return {
    path: displayPath(root, absolute),
    content: slice.join("\n"),
    startLine,
    totalLines: lines.length,
    truncated: startLine > 1 || (limit !== undefined && startLine - 1 + limit < lines.length),
  };
}

/**
 * Raw bytes of a file inside the workspace, for callers that render rather than read (an image in
 * the transcript). Same confinement and size limit as `readTextFile`; never handed to a model.
 */
export async function readBinaryFile(root: string, candidate: string, limits: WorkspaceLimits = DEFAULT_WORKSPACE_LIMITS): Promise<{ path: string; bytes: Uint8Array }> {
  const absolute = await realPathWithin(root, candidate);
  const stat = await fs.stat(absolute).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceViolation(`${displayPath(root, absolute)} does not exist`);
    throw error;
  });
  if (stat.isDirectory()) throw new WorkspaceViolation(`${displayPath(root, absolute)} is a directory, not a file`);
  if (stat.size > limits.maxReadBytes) {
    throw new WorkspaceViolation(`${displayPath(root, absolute)} is ${stat.size} bytes, above the ${limits.maxReadBytes}-byte read limit`);
  }
  return { path: displayPath(root, absolute), bytes: new Uint8Array(await fs.readFile(absolute)) };
}

export async function writeTextFile(root: string, candidate: string, content: string, limits = DEFAULT_WORKSPACE_LIMITS): Promise<{ path: string; bytesWritten: number }> {
  if (typeof content !== "string") throw new WorkspaceViolation("content must be a string");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > limits.maxWriteBytes) throw new WorkspaceViolation(`content is ${bytes} bytes, above the ${limits.maxWriteBytes}-byte write limit`);
  const absolute = resolveInWorkspace(root, candidate);
  // Confirm the parent is inside the tree too: creating a file through a symlinked directory would
  // otherwise write outside the workspace even though the lexical path looked fine.
  await realPathWithin(root, path.dirname(candidate));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
  return { path: displayPath(root, absolute), bytesWritten: bytes };
}

/** One exact-text replacement. `replaceAll` permits more than one occurrence. */
export type TextEdit = { oldText: string; newText: string; replaceAll?: boolean };

type LineEnding = "lf" | "crlf" | "mixed";

function lineEndingOf(content: string): LineEnding {
  const crlf = content.split("\r\n").length - 1;
  if (crlf === 0) return "lf";
  const lf = content.split("\n").length - 1;
  return lf === crlf ? "crlf" : "mixed";
}

const toLf = (text: string): string => text.replace(/\r\n/g, "\n");
const toCrlf = (text: string): string => toLf(text).replace(/\n/g, "\r\n");

/** Non-overlapping occurrences, the same count `split` gives. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count += 1;
  return count;
}

/**
 * Index-slice replacement. Never `String.prototype.replace` with a string replacement: that expands
 * `$&`, `$'`, `` $` `` and `$$` inside `newText`, which silently corrupts any edit that happens to
 * contain a dollar sign followed by one of those characters (shell, PHP, regex, template code...).
 */
function replaceText(content: string, oldText: string, newText: string, all: boolean): string {
  if (all) return content.split(oldText).join(newText);
  const index = content.indexOf(oldText);
  return index === -1 ? content : content.slice(0, index) + newText + content.slice(index + oldText.length);
}

/** Dice coefficient over character bigrams: cheap enough to run against every line of a file. */
function similarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    bigrams.set(pair, (bigrams.get(pair) ?? 0) + 1);
  }
  let shared = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const remaining = bigrams.get(pair) ?? 0;
    if (remaining > 0) { shared += 1; bigrams.set(pair, remaining - 1); }
  }
  return (2 * shared) / (left.length + right.length - 2);
}

/** A hint naming the line most like oldText's first line, so a near miss is fixable in one turn. */
function nearestLineHint(content: string, oldText: string): string {
  const needle = toLf(oldText).split("\n").map((line) => line.trim()).find(Boolean);
  if (!needle) return "";
  const lines = toLf(content).split("\n");
  let best = { score: 0, line: 0 };
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines[index].trim();
    if (!candidate || Math.abs(candidate.length - needle.length) > Math.max(needle.length, 40)) continue;
    const score = similarity(needle.slice(0, 300), candidate.slice(0, 300));
    if (score > best.score) best = { score, line: index + 1 };
  }
  if (best.score < 0.5) return " Re-read the file and copy oldText exactly.";
  const text = lines[best.line - 1];
  const shown = text.length > 160 ? `${text.slice(0, 160)}…` : text;
  const exactIgnoringIndent = text.trim() === needle;
  return ` Closest line is ${best.line}${exactIgnoringIndent ? " (same text, different indentation)" : ""}: ${JSON.stringify(shown)}. Re-read the file and copy oldText exactly.`;
}

/**
 * Locates `oldText` line-wise, ignoring trailing whitespace on every line and line-ending style.
 *
 * Returns the character span of every match in `content`. Only whole lines are compared; that is
 * the shape a model's near-miss nearly always has (an editor stripped trailing spaces, or the model
 * dropped them), and it keeps the fallback from matching something the model did not mean.
 */
function trailingWhitespaceInsensitiveMatches(content: string, oldText: string): Array<{ start: number; end: number }> {
  const wanted = toLf(oldText).split("\n");
  const includesFinalNewline = wanted.length > 1 && wanted[wanted.length - 1] === "";
  if (includesFinalNewline) wanted.pop();
  const wantedTrimmed = wanted.map((line) => line.trimEnd());
  if (wantedTrimmed.every((line) => line === "")) return [];

  const rawLines = content.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of rawLines) { starts.push(offset); offset += line.length + 1; }
  const trimmed = rawLines.map((line) => line.trimEnd());

  const matches: Array<{ start: number; end: number }> = [];
  for (let first = 0; first + wantedTrimmed.length <= rawLines.length; first += 1) {
    let matched = true;
    for (let line = 0; line < wantedTrimmed.length; line += 1) {
      if (trimmed[first + line] !== wantedTrimmed[line]) { matched = false; break; }
    }
    if (!matched) continue;
    const last = first + wantedTrimmed.length - 1;
    if (includesFinalNewline && last + 1 >= rawLines.length) continue; // oldText promised a newline the file does not have.
    const lastLine = rawLines[last];
    const end = includesFinalNewline
      ? starts[last] + lastLine.length + 1
      : starts[last] + lastLine.length - (lastLine.endsWith("\r") ? 1 : 0);
    matches.push({ start: starts[first], end });
  }
  return matches;
}

/**
 * Applies `edits` in order to `content`, all-or-nothing: the first edit that cannot be applied
 * throws, and nothing is returned for writing.
 *
 * Exact matching first. Then two tolerances, each only when the exact text is absent:
 *
 * - Line endings. A model almost always sends LF; a Windows checkout is often CRLF. The edit is
 *   matched after normalizing oldText to the file's own line ending, and newText is written in the
 *   file's line ending so a CRLF file never ends up with a stray block of LF lines (or vice versa).
 * - Trailing whitespace, line-wise, and only when that match is unique — an ambiguous fuzzy match is
 *   still an error, never a guess.
 */
export function applyTextEdits(content: string, edits: readonly TextEdit[], label: string): { content: string; replacements: number } {
  if (!Array.isArray(edits) || edits.length === 0) throw new WorkspaceViolation("at least one edit is required");
  let current = content;
  let replacements = 0;
  edits.forEach((edit, index) => {
    const prefix = edits.length > 1 ? `edits[${index}]: ` : "";
    const { oldText, newText } = edit ?? ({} as TextEdit);
    if (typeof oldText !== "string" || oldText === "") throw new WorkspaceViolation(`${prefix}oldText must be a non-empty string`);
    if (typeof newText !== "string") throw new WorkspaceViolation(`${prefix}newText must be a string`);
    if (oldText === newText) throw new WorkspaceViolation(`${prefix}oldText and newText are identical`);

    const ending = lineEndingOf(current);
    // newText in the file's own line ending, so an inserted block never mixes styles.
    const adapt = (text: string): string => (ending === "crlf" ? toCrlf(text) : ending === "lf" ? toLf(text) : text);

    let needle = oldText;
    let occurrences = countOccurrences(current, needle);
    if (occurrences === 0 && ending !== "mixed") {
      const normalized = adapt(oldText);
      if (normalized !== oldText) {
        needle = normalized;
        occurrences = countOccurrences(current, needle);
      }
    }

    if (occurrences > 0) {
      if (occurrences > 1 && !edit.replaceAll) {
        throw new WorkspaceViolation(`${prefix}oldText appears ${occurrences} times in ${label}; include more surrounding context or set replaceAll`);
      }
      current = replaceText(current, needle, adapt(newText), edit.replaceAll === true);
      replacements += edit.replaceAll ? occurrences : 1;
      return;
    }

    const fuzzy = trailingWhitespaceInsensitiveMatches(current, oldText);
    if (fuzzy.length === 1) {
      const [{ start, end }] = fuzzy;
      current = current.slice(0, start) + adapt(newText) + current.slice(end);
      replacements += 1;
      return;
    }
    if (fuzzy.length > 1) {
      throw new WorkspaceViolation(`${prefix}oldText was not found exactly in ${label}, and matches ${fuzzy.length} places when trailing whitespace is ignored; include more surrounding context`);
    }
    throw new WorkspaceViolation(`${prefix}oldText was not found in ${label}.${nearestLineHint(current, oldText)}`);
  });
  return { content: current, replacements };
}

/**
 * Replaces one exact occurrence of `oldText`.
 *
 * Deliberately not a whole-file rewrite: a model that must reproduce an entire file to change one
 * line will eventually reproduce it imperfectly, and the damage is silent. Requiring the old text
 * to appear exactly once makes an ambiguous edit an error rather than a coin flip.
 */
export async function editTextFile(
  root: string,
  candidate: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean; limits?: WorkspaceLimits } = {},
): Promise<{ path: string; replacements: number }> {
  return editTextFileWithEdits(root, candidate, [{ oldText, newText, replaceAll: options.replaceAll }], { limits: options.limits });
}

/**
 * The edits an `edit_file` call asks for: either the single `oldText`/`newText`/`replaceAll` form,
 * or `edits` — an array of `{oldText, newText, replaceAll?}`, accepted as a real array or as its JSON
 * encoding (the tool schema only declares scalar types, so the model sends it as a string).
 */
export function parseEditArguments(args: Record<string, unknown>): TextEdit[] {
  if (args.edits !== undefined && args.edits !== null) {
    if (args.oldText !== undefined || args.newText !== undefined) {
      throw new WorkspaceViolation("use either edits or oldText/newText, not both");
    }
    let raw: unknown = args.edits;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        throw new WorkspaceViolation("edits must be a JSON array of {\"oldText\", \"newText\", \"replaceAll\"?} objects");
      }
    }
    if (!Array.isArray(raw) || raw.length === 0) throw new WorkspaceViolation("edits must be a non-empty array of {oldText, newText, replaceAll?} objects");
    return raw.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new WorkspaceViolation(`edits[${index}] must be an object with oldText and newText`);
      const { oldText, newText, replaceAll } = entry as Record<string, unknown>;
      if (typeof oldText !== "string" || oldText === "") throw new WorkspaceViolation(`edits[${index}].oldText must be a non-empty string`);
      if (typeof newText !== "string") throw new WorkspaceViolation(`edits[${index}].newText must be a string`);
      if (replaceAll !== undefined && replaceAll !== null && typeof replaceAll !== "boolean") throw new WorkspaceViolation(`edits[${index}].replaceAll must be true or false`);
      return { oldText, newText, replaceAll: replaceAll === true };
    });
  }
  if (typeof args.oldText !== "string" || args.oldText === "") throw new WorkspaceViolation("oldText must be a non-empty string (or pass edits)");
  if (typeof args.newText !== "string") throw new WorkspaceViolation("newText must be a string");
  return [{ oldText: args.oldText, newText: args.newText, replaceAll: args.replaceAll === true }];
}

export function fingerprintText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * What the agent last saw of each file, so an edit cannot be applied to a file that changed on disk
 * underneath it (the user saved in their editor, a formatter ran, another agent wrote it).
 *
 * Only files the agent has read or written are guarded: an edit to a file it never read still goes
 * through, as it always has — the guard is against acting on a stale view, not against editing
 * without looking.
 */
export class FileReadTracker {
  private readonly seen = new Map<string, string>();

  /** Records the full content the agent now knows `path` to have. */
  record(path: string, content: string): void {
    this.seen.set(path, fingerprintText(content));
  }

  forget(path: string): void {
    this.seen.delete(path);
  }

  has(path: string): boolean {
    return this.seen.has(path);
  }

  /** Throws when `path` was read before and its content on disk is no longer what was read. */
  assertFresh(path: string, currentContent: string): void {
    const known = this.seen.get(path);
    if (known !== undefined && known !== fingerprintText(currentContent)) {
      throw new WorkspaceViolation(`${path} changed on disk since it was last read; re-read it with read_file before editing`);
    }
  }
}

const fileReadTrackers = new WeakMap<object, FileReadTracker>();

/**
 * The tracker for one workspace. Keyed by the workspace object because that object lives as long
 * as the session does, while the tool list is rebuilt on every turn.
 */
export function fileReadTrackerFor(owner: object): FileReadTracker {
  let tracker = fileReadTrackers.get(owner);
  if (!tracker) {
    tracker = new FileReadTracker();
    fileReadTrackers.set(owner, tracker);
  }
  return tracker;
}

/** Several edits to one file, applied in order and written once — or not at all. */
export async function editTextFileWithEdits(
  root: string,
  candidate: string,
  edits: readonly TextEdit[],
  options: { limits?: WorkspaceLimits } = {},
): Promise<{ path: string; replacements: number }> {
  const existing = await readTextFile(root, candidate, { limits: options.limits });
  const result = applyTextEdits(existing.content, edits, existing.path);
  await writeTextFile(root, candidate, result.content, options.limits ?? DEFAULT_WORKSPACE_LIMITS);
  return { path: existing.path, replacements: result.replacements };
}

export type WalkEntry = { absolute: string; relative: string; isDirectory: boolean };

/** How many directories are read at once. Enough to hide I/O latency, far below any descriptor limit. */
const WALK_CONCURRENCY = 32;

/** The same, for the file reads a content search does. */
const GREP_CONCURRENCY = 32;

/**
 * Breadth-first walk that never leaves the root and never descends into ignored directories.
 *
 * Reads a whole level of directories at once instead of one at a time. The walk is latency-bound,
 * not CPU-bound — it awaited a single `readdir` and then awaited the next — so this is close to
 * free: measured 41ms to 6ms on this repository, and 302ms to 57ms on a 3,000-directory tree. It
 * backs `glob_files`, `grep_files`, `list_files` and skill discovery, so every one of those pays it.
 *
 * Order is still deterministic, and that is deliberate rather than incidental: the level's
 * directories are read concurrently but their entries are yielded in the order the level was
 * queued, so two runs over an unchanged tree produce identical output. A parallel walk that yielded
 * in completion order would make `glob_files` return a different list on every call, which is a
 * miserable thing to debug and a needless cache invalidation upstream.
 */
export async function* walkWorkspace(root: string, limits = DEFAULT_WORKSPACE_LIMITS, maxEntries = 20_000): AsyncGenerator<WalkEntry> {
  const absoluteRoot = path.resolve(root);
  const ignored = new Set(limits.ignoredDirectories);
  // An empty ignore list means "show me everything" (config discovery under `.archymedes`), so the
  // project's .gitignore is only consulted when the caller wants the agent-facing, filtered view.
  const gitignored = ignored.size > 0 ? await loadRootGitignore(absoluteRoot) : null;
  let level: string[] = [absoluteRoot];
  let seen = 0;

  while (level.length > 0) {
    const next: string[] = [];
    for (let start = 0; start < level.length; start += WALK_CONCURRENCY) {
      const batch = level.slice(start, start + WALK_CONCURRENCY);
      // An unreadable directory is not a reason to abandon the whole walk, so each read resolves to
      // its own entries or to nothing.
      const reads = await Promise.all(batch.map(async (directory): Promise<{ directory: string; entries: Dirent[] }> => {
        try {
          return { directory, entries: await fs.readdir(directory, { withFileTypes: true }) };
        } catch {
          return { directory, entries: [] };
        }
      }));
      for (const { directory, entries } of reads) {
        for (const entry of entries) {
          if (seen >= maxEntries) return;
          const absolute = path.join(directory, entry.name);
          // Symlinks are reported but never followed: following them can leave the tree and can loop.
          const isDirectory = entry.isDirectory();
          if (isDirectory && ignored.has(entry.name)) continue;
          const relative = displayPath(absoluteRoot, absolute);
          if (gitignored?.(relative, isDirectory)) continue;
          seen += 1;
          yield { absolute, relative, isDirectory };
          if (isDirectory) next.push(absolute);
        }
      }
    }
    level = next;
  }
}

/**
 * Glob matching for the subset of syntax people actually type: `**`, `*`, `?`, and `{a,b}`.
 *
 * Implemented here rather than pulled in, because a glob library is a dependency whose only job is
 * to build a regular expression, and the CLI's dependency surface is part of its security surface.
 */
export function globToRegExp(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        // `**/` may match nothing at all, so `**/x` also matches a top-level `x`.
        if (pattern[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    if (character === "?") { expression += "[^/]"; continue; }
    if (character === "{") {
      const close = pattern.indexOf("}", index);
      if (close > index) {
        expression += `(?:${pattern.slice(index + 1, close).split(",").map(escapeRegExp).join("|")})`;
        index = close;
        continue;
      }
    }
    expression += escapeRegExp(character);
  }
  return new RegExp(`^${expression}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a root-relative, forward-slashed path is ignored. */
export type GitignoreMatcher = (relative: string, isDirectory: boolean) => boolean;

/**
 * The common subset of .gitignore syntax: comments, blank lines, `!` negation, a trailing `/` for
 * directories only, a leading or embedded `/` anchoring to the root, and the same `*`/`**`/`?`/`{}`
 * globs `globToRegExp` supports. Later rules win, as in git. Character classes are matched
 * literally; nested .gitignore files are not read — this is a root-file filter, not git.
 */
export function parseGitignore(text: string): GitignoreMatcher {
  const rules: Array<{ regex: RegExp; negate: boolean; directoryOnly: boolean }> = [];
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\r$/, "").replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.replace(/\/+$/, "");
    if (!line) continue;
    const anchored = line.includes("/");
    line = line.replace(/^\/+/, "");
    if (!line) continue;
    rules.push({ regex: globToRegExp(anchored ? line : `**/${line}`), negate, directoryOnly });
  }
  return (relative, isDirectory) => {
    let ignoredPath = false;
    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.regex.test(relative)) ignoredPath = !rule.negate;
    }
    return ignoredPath;
  };
}

/** The root .gitignore as a matcher, or null when there is none (or it cannot be read). */
export async function loadRootGitignore(root: string): Promise<GitignoreMatcher | null> {
  try {
    const text = await fs.readFile(path.join(path.resolve(root), ".gitignore"), "utf8");
    return parseGitignore(text);
  } catch {
    return null;
  }
}

export async function globWorkspace(root: string, pattern: string, limits = DEFAULT_WORKSPACE_LIMITS, maxResults = 500): Promise<string[]> {
  const matcher = globToRegExp(pattern);
  const matches: string[] = [];
  for await (const entry of walkWorkspace(root, limits)) {
    if (entry.isDirectory) continue;
    if (matcher.test(entry.relative)) matches.push(entry.relative);
    if (matches.length >= maxResults) break;
  }
  return matches.sort();
}

export type GrepMatch = { path: string; line: number; text: string };

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
export function ripgrepArguments(query: string, options: { include?: string; regex?: boolean; limits: WorkspaceLimits }): string[] {
  const args = ["--json", "--no-messages", "--hidden", "--no-require-git", "--no-ignore-parent", "--sort=path", "--max-filesize", String(options.limits.maxReadBytes)];
  for (const directory of options.limits.ignoredDirectories) args.push("--glob", `!${directory}`);
  // A superset of `globToRegExp`'s meaning (rg matches an unanchored glob at any depth); the exact
  // include matcher is re-applied to every result so the two paths agree.
  if (options.include) args.push("--glob", options.include);
  if (!options.regex) args.push("--fixed-strings");
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
  options: { include?: string; regex?: boolean; maxResults: number; limits: WorkspaceLimits },
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
  options: { include?: string; regex?: boolean; maxResults?: number; limits?: WorkspaceLimits; ripgrep?: string | null } = {},
): Promise<GrepMatch[]> {
  if (typeof query !== "string" || query === "") throw new WorkspaceViolation("query must be a non-empty string");
  const limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS;
  const maxResults = options.maxResults ?? 200;
  // Validate a regex with the JS engine first, so a malformed pattern fails the same way either way.
  const matcher = options.regex ? new RegExp(query) : null;
  const binary = options.ripgrep === undefined ? await findRipgrep() : options.ripgrep;
  if (binary) {
    const found = await ripgrepSearch(binary, root, query, { include: options.include, regex: options.regex, maxResults, limits });
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
