import { execFile } from "node:child_process";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "../../agent-runtime";
import { ARCHYMEDES_CAPABILITIES } from "../permissions";
import { displayPath, resolveInWorkspace } from "../workspace";
import { boundedInteger, optionalString, requiredString, truncateText, type ExtraToolOptions } from "./shared";

/**
 * Read-only git inspection without a shell.
 *
 * `run_command` can already run git, but it needs approval and a shell, and its output is
 * whatever git prints. These tools are always read-only, so they need no approval and can run in
 * parallel, and their output is parsed into something a model (and a UI) can rely on.
 *
 * Hardening, because "read-only" git can still execute code a repository configures:
 * - `execFile`, never a shell; every user value goes after `--` or is validated as a ref first.
 * - `core.fsmonitor` off (a repo-configured fsmonitor is a program `git status` would run),
 *   `--no-ext-diff`/`--no-textconv` (external diff drivers and textconv filters are programs too),
 *   no pager, no optional locks (inspection must never contend with the user's own git).
 */

export type GitRunResult = { ok: true; stdout: string } | { ok: false; reason: "not_a_repository" | "git_missing" | "timeout" | "failed"; message: string };

const GIT_BASE_ARGS = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false"];
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

export function runGit(root: string, args: readonly string[], timeoutMs: number): Promise<GitRunResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...GIT_BASE_ARGS, ...args],
      {
        cwd: path.resolve(root),
        timeout: timeoutMs,
        maxBuffer: MAX_GIT_OUTPUT,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C", LANGUAGE: "C" },
      },
      (error, stdout, stderr) => {
        if (!error) { resolve({ ok: true, stdout }); return; }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        if (failure.code === "ENOENT") { resolve({ ok: false, reason: "git_missing", message: "git is not installed or not on PATH." }); return; }
        if (failure.killed || failure.signal === "SIGTERM") { resolve({ ok: false, reason: "timeout", message: `git timed out after ${timeoutMs} ms.` }); return; }
        const text = String(stderr || failure.message).trim();
        if (/not a git repository/i.test(text)) { resolve({ ok: false, reason: "not_a_repository", message: "Not a git repository: the project root is not inside a git work tree." }); return; }
        resolve({ ok: false, reason: "failed", message: text.split("\n").slice(0, 8).join("\n") || "git failed." });
      },
    );
  });
}

function failureResult(result: Extract<GitRunResult, { ok: false }>): AgentToolResult {
  // "Not a repository" is an answer, not a malfunction: the model should move on, not retry.
  return { content: result.message, isError: result.reason !== "not_a_repository", data: { ok: false, reason: result.reason } };
}

/**
 * A ref the model may name: no leading `-` (that would be an option), no whitespace or control
 * characters, and only characters git itself allows in revision expressions.
 */
export function validateRef(ref: string, name = "ref"): string {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("-") || !/^[\w./~^@{}+-]+$/.test(trimmed)) {
    throw new Error(`${name} '${ref}' is not a valid git revision`);
  }
  return trimmed;
}

/** A workspace-confined pathspec, relative to the root (which is git's cwd), forward-slashed. */
function pathspec(root: string, candidate: string | undefined): string {
  if (!candidate) return ".";
  const relative = displayPath(root, resolveInWorkspace(root, candidate));
  return relative;
}

/** `git rev-parse --show-prefix`: where the workspace root sits inside the repository. */
async function repoPrefix(root: string, timeoutMs: number): Promise<GitRunResult> {
  return runGit(root, ["rev-parse", "--show-prefix"], timeoutMs);
}

export type GitStatusEntry = {
  path: string;
  /** Previous path, for renames and copies. */
  originalPath?: string;
  /** Index (staged) and work-tree states, one porcelain letter each; `.` means unchanged. */
  index: string;
  worktree: string;
  kind: "changed" | "renamed" | "unmerged" | "untracked" | "ignored";
  submodule?: boolean;
};

export type GitStatus = {
  branch: { head: string | null; oid: string | null; upstream: string | null; ahead: number; behind: number };
  entries: GitStatusEntry[];
};

/**
 * Parses `git status --porcelain=v2 --branch -z`.
 *
 * Paths are NUL-terminated (so spaces and newlines in names survive), and a rename's original
 * path is the record that follows it. `stripPrefix` turns repo-root-relative paths into
 * workspace-relative ones when the workspace is a subdirectory of the repository.
 */
export function parsePorcelainV2(output: string, stripPrefix = ""): GitStatus {
  const status: GitStatus = { branch: { head: null, oid: null, upstream: null, ahead: 0, behind: 0 }, entries: [] };
  const records = output.split("\0");
  const local = (repoPath: string) => (stripPrefix && repoPath.startsWith(stripPrefix) ? repoPath.slice(stripPrefix.length) : repoPath);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# ")) {
      const [, key, ...rest] = record.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") status.branch.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") status.branch.head = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") status.branch.upstream = value;
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) { status.branch.ahead = Number(match[1]); status.branch.behind = Number(match[2]); }
      }
      continue;
    }
    const type = record[0];
    if (type === "?" || type === "!") {
      status.entries.push({ path: local(record.slice(2)), index: type, worktree: type, kind: type === "?" ? "untracked" : "ignored" });
      continue;
    }
    // Field counts before the path: 1 → 8, 2 → 9 (plus the score), u → 10.
    const fieldCount = type === "1" ? 8 : type === "2" ? 9 : type === "u" ? 10 : -1;
    if (fieldCount === -1) continue;
    const parts = record.split(" ");
    const filePath = parts.slice(fieldCount).join(" ");
    const xy = parts[1] ?? "..";
    const entry: GitStatusEntry = {
      path: local(filePath),
      index: xy[0] ?? ".",
      worktree: xy[1] ?? ".",
      kind: type === "1" ? "changed" : type === "2" ? "renamed" : "unmerged",
      ...(parts[2]?.startsWith("S") ? { submodule: true } : {}),
    };
    if (type === "2") {
      index += 1;
      entry.originalPath = local(records[index] ?? "");
    }
    status.entries.push(entry);
  }
  return status;
}

const STATE_WORDS: Record<string, string> = { M: "modified", T: "type changed", A: "added", D: "deleted", R: "renamed", C: "copied", U: "unmerged" };

export function renderStatus(status: GitStatus): string {
  const { branch } = status;
  const head = branch.head ?? `detached at ${branch.oid?.slice(0, 12) ?? "unknown"}`;
  const tracking = branch.upstream ? ` → ${branch.upstream} (ahead ${branch.ahead}, behind ${branch.behind})` : "";
  const lines = [`On ${head}${branch.oid ? "" : " (no commits yet)"}${tracking}`];
  const describe = (entry: GitStatusEntry, letter: string) => `  ${STATE_WORDS[letter] ?? letter}: ${entry.originalPath ? `${entry.originalPath} -> ` : ""}${entry.path}`;
  const staged = status.entries.filter((entry) => (entry.kind === "changed" || entry.kind === "renamed") && entry.index !== ".");
  const unstaged = status.entries.filter((entry) => (entry.kind === "changed" || entry.kind === "renamed") && entry.worktree !== ".");
  const conflicts = status.entries.filter((entry) => entry.kind === "unmerged");
  const untracked = status.entries.filter((entry) => entry.kind === "untracked");
  if (conflicts.length > 0) lines.push(`Conflicts (${conflicts.length}):`, ...conflicts.map((entry) => `  both ${entry.index}${entry.worktree}: ${entry.path}`));
  if (staged.length > 0) lines.push(`Staged (${staged.length}):`, ...staged.map((entry) => describe(entry, entry.index)));
  if (unstaged.length > 0) lines.push(`Not staged (${unstaged.length}):`, ...unstaged.map((entry) => describe(entry, entry.worktree)));
  if (untracked.length > 0) lines.push(`Untracked (${untracked.length}):`, ...untracked.map((entry) => `  ${entry.path}`));
  if (status.entries.length === 0) lines.push("Working tree clean.");
  return lines.join("\n");
}

export type GitLogEntry = { hash: string; shortHash: string; author: string; date: string; subject: string };

const FIELD = "\x1f";
const RECORD = "\x1e";

export function parseGitLog(output: string): GitLogEntry[] {
  return output.split(RECORD).map((record) => record.replace(/^\s+/, "")).filter(Boolean).map((record) => {
    const [hash = "", shortHash = "", author = "", date = "", subject = ""] = record.split(FIELD);
    return { hash, shortHash, author, date, subject: subject.trimEnd() };
  });
}

function readOnlyTool(tool: Omit<AgentTool, "capabilityId" | "effect" | "requiresApproval" | "parallelSafe">): AgentTool {
  return { ...tool, capabilityId: ARCHYMEDES_CAPABILITIES.read, effect: "none", requiresApproval: false, parallelSafe: true };
}

export function createGitTools(options: ExtraToolOptions): AgentTool[] {
  const { root } = options;
  const timeoutMs = options.gitTimeoutMs ?? 10_000;

  return [
    readOnlyTool({
      name: "git_status",
      description: "Git branch (ahead/behind upstream) and staged, unstaged, untracked and conflicted files.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const prefix = await repoPrefix(root, timeoutMs);
        if (!prefix.ok) return failureResult(prefix);
        const result = await runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", "."], timeoutMs);
        if (!result.ok) return failureResult(result);
        const status = parsePorcelainV2(result.stdout, prefix.stdout.trim());
        return { content: renderStatus(status), data: { ok: true, ...status } };
      },
    }),
    readOnlyTool({
      name: "git_diff",
      description:
        "Unified diff; default unstaged work-tree changes. staged: the index. ref: compare against a revision, or 'a..b'.",
      inputSchema: {
        type: "object",
        properties: {
          staged: { type: "boolean" },
          ref: { type: "string", description: "e.g. 'HEAD~1', 'main..feature'." },
          path: { type: "string" },
          stat: { type: "boolean", description: "Per-file summary only." },
          maxChars: { type: "integer", description: "Default 20000, max 100000." },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const ref = optionalString(args.ref, "ref");
        const spec = pathspec(root, optionalString(args.path, "path"));
        const maxChars = boundedInteger(args.maxChars, "maxChars", 20_000, 500, 100_000);
        const gitArgs = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
        if (args.staged === true) gitArgs.push("--cached");
        if (args.stat === true) gitArgs.push("--stat");
        if (ref) gitArgs.push(validateRef(ref));
        gitArgs.push("--", spec);
        const result = await runGit(root, gitArgs, timeoutMs);
        if (!result.ok) return failureResult(result);
        if (!result.stdout.trim()) {
          const what = args.staged === true ? "staged changes" : ref ? `differences against ${ref}` : "unstaged changes";
          return { content: `No ${what}${spec === "." ? "" : ` in ${spec}`}.`, data: { ok: true, empty: true, truncated: false } };
        }
        const cut = truncateText(result.stdout, maxChars, "Narrow with path, or use stat=true for a summary.");
        return { content: cut.text, data: { ok: true, empty: false, truncated: cut.truncated, totalChars: result.stdout.length } };
      },
    }),
    readOnlyTool({
      name: "git_log",
      description: "Recent commits (hash, author, date, subject), newest first.",
      inputSchema: {
        type: "object",
        properties: {
          n: { type: "integer", description: "Default 20, max 200." },
          path: { type: "string", description: "Only commits touching this path." },
          ref: { type: "string", description: "Instead of HEAD." },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const n = boundedInteger(args.n, "n", 20, 1, 200);
        const ref = optionalString(args.ref, "ref");
        const pathArgument = optionalString(args.path, "path");
        const gitArgs = ["log", `-n${n}`, "--date=short", `--pretty=format:%H${FIELD}%h${FIELD}%an${FIELD}%ad${FIELD}%s${RECORD}`];
        if (ref) gitArgs.push(validateRef(ref));
        gitArgs.push("--", pathspec(root, pathArgument));
        const result = await runGit(root, gitArgs, timeoutMs);
        if (!result.ok) {
          if (result.reason === "failed" && /does not have any commits|bad default revision/i.test(result.message)) {
            return { content: "No commits yet.", data: { ok: true, commits: [] } };
          }
          return failureResult(result);
        }
        const commits = parseGitLog(result.stdout);
        if (commits.length === 0) return { content: pathArgument ? `No commits touch ${pathArgument}.` : "No commits.", data: { ok: true, commits: [] } };
        return {
          content: commits.map((commit) => `${commit.shortHash} ${commit.date} ${commit.author}: ${commit.subject}`).join("\n"),
          data: { ok: true, commits },
        };
      },
    }),
    readOnlyTool({
      name: "git_show",
      description:
        "A file at a revision (ref + path, or 'HEAD:src/app.ts'), or with no path a commit's message and diff.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          path: { type: "string" },
          maxChars: { type: "integer", description: "Default 20000, max 100000." },
        },
        required: ["ref"],
        additionalProperties: false,
      },
      async execute(args) {
        let ref = requiredString(args.ref, "ref").trim();
        let filePath = optionalString(args.path, "path");
        const colon = ref.indexOf(":");
        if (colon > 0 && !filePath) {
          filePath = ref.slice(colon + 1);
          ref = ref.slice(0, colon);
        }
        ref = validateRef(ref);
        const maxChars = boundedInteger(args.maxChars, "maxChars", 20_000, 500, 100_000);
        if (filePath) {
          // `./path` makes git resolve it against cwd (the project root), not the repository top.
          const relative = pathspec(root, filePath);
          if (relative === ".") throw new Error("path must name a file");
          const result = await runGit(root, ["show", "--no-color", "--no-textconv", `${ref}:./${relative}`], timeoutMs);
          if (!result.ok) return failureResult(result);
          if (result.stdout.includes("\0")) {
            return { content: `${relative} at ${ref} is a binary file (${result.stdout.length} bytes); not shown.`, data: { ok: true, ref, path: relative, binary: true } };
          }
          const cut = truncateText(result.stdout, maxChars, "Raise maxChars, or read a narrower part via git_diff.");
          return { content: cut.text, data: { ok: true, ref, path: relative, binary: false, truncated: cut.truncated } };
        }
        const result = await runGit(root, ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--stat", "--patch", "--date=short", ref, "--"], timeoutMs);
        if (!result.ok) return failureResult(result);
        const cut = truncateText(result.stdout, maxChars, "Pass a path to see one file at this revision, or use git_diff with path.");
        return { content: cut.text, data: { ok: true, ref, truncated: cut.truncated } };
      },
    }),
  ];
}
