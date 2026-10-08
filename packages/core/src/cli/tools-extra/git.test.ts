import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "../../agent-runtime";
import { createGitTools, parseGitLog, parsePorcelainV2, validateRef } from "./git";

const context = { taskId: "t", runId: "r", stepId: "s" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" },
  });
}

function toolsFor(root: string): Map<string, AgentTool> {
  return new Map(createGitTools({ root }).map((tool) => [tool.name, tool]));
}

describe("parsePorcelainV2", () => {
  it("parses branch headers, changes, renames, conflicts, untracked and paths with spaces", () => {
    const output = [
      "# branch.oid 1234567890abcdef",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 aaaa bbbb sub/staged file.ts",
      "1 .M N... 100644 100644 100644 aaaa bbbb sub/unstaged.ts",
      "2 R. N... 100644 100644 100644 aaaa bbbb R100 sub/new name.ts",
      "sub/old name.ts",
      "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc sub/conflict.ts",
      "? sub/untracked.txt",
      "1 .M S.M. 160000 160000 160000 aaaa bbbb sub/module",
      "",
    ].join("\0");
    const status = parsePorcelainV2(output, "sub/");
    expect(status.branch).toEqual({ head: "main", oid: "1234567890abcdef", upstream: "origin/main", ahead: 2, behind: 1 });
    expect(status.entries).toEqual([
      { path: "staged file.ts", index: "M", worktree: ".", kind: "changed" },
      { path: "unstaged.ts", index: ".", worktree: "M", kind: "changed" },
      { path: "new name.ts", originalPath: "old name.ts", index: "R", worktree: ".", kind: "renamed" },
      { path: "conflict.ts", index: "U", worktree: "U", kind: "unmerged" },
      { path: "untracked.txt", index: "?", worktree: "?", kind: "untracked" },
      { path: "module", index: ".", worktree: "M", kind: "changed", submodule: true },
    ]);
  });

  it("reads an unborn branch and a detached head", () => {
    expect(parsePorcelainV2("# branch.oid (initial)\0# branch.head main\0").branch).toMatchObject({ oid: null, head: "main" });
    expect(parsePorcelainV2("# branch.oid abc\0# branch.head (detached)\0").branch).toMatchObject({ oid: "abc", head: null });
  });
});

describe("parseGitLog", () => {
  it("splits records and fields", () => {
    expect(parseGitLog("h1\x1fs1\x1fAda\x1f2026-01-01\x1fFirst\x1e\nh2\x1fs2\x1fBob\x1f2026-01-02\x1fSecond: with colon\x1e")).toEqual([
      { hash: "h1", shortHash: "s1", author: "Ada", date: "2026-01-01", subject: "First" },
      { hash: "h2", shortHash: "s2", author: "Bob", date: "2026-01-02", subject: "Second: with colon" },
    ]);
  });
});

describe("validateRef", () => {
  it("accepts revision expressions and refuses option injection", () => {
    for (const ref of ["HEAD", "HEAD~2", "main..feature", "v1.2.3", "origin/main", "HEAD@{1}", "abc123^"]) expect(validateRef(ref)).toBe(ref);
    for (const ref of ["--output=/tmp/x", "-p", "HEAD; rm -rf /", "a b", "$(x)", "HEAD:file"]) expect(() => validateRef(ref)).toThrow(/not a valid git revision/);
  });
});

describe("git tools against a real repository", () => {
  let root: string;
  let outside: string;
  let tools: Map<string, AgentTool>;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-git-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-nogit-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "commit.gpgsign", "false");
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "app.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(root, "notes.md"), "first\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Initial commit");
    await fs.writeFile(path.join(root, "src", "app.ts"), "export const a = 2;\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Bump a");
    // Leave: one staged change, one unstaged change, one untracked file with a space.
    await fs.writeFile(path.join(root, "notes.md"), "first\nsecond\n");
    git(root, "add", "notes.md");
    await fs.writeFile(path.join(root, "src", "app.ts"), "export const a = 3;\n");
    await fs.writeFile(path.join(root, "new file.txt"), "hello\n");
    tools = toolsFor(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("declares every git tool read-only and parallel-safe", () => {
    for (const name of ["git_status", "git_diff", "git_log", "git_show"]) {
      expect(tools.get(name)).toMatchObject({ effect: "none", parallelSafe: true, requiresApproval: false });
    }
  });

  it("git_status reports branch and grouped changes", async () => {
    const result = await tools.get("git_status")!.execute({}, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("On main");
    expect(result.content).toContain("Staged (1):\n  modified: notes.md");
    expect(result.content).toContain("Not staged (1):\n  modified: src/app.ts");
    expect(result.content).toContain("Untracked (1):\n  new file.txt");
    expect((result.data as { branch: { head: string } }).branch.head).toBe("main");
  });

  it("git_status is relative to a workspace that is a repository subdirectory", async () => {
    const result = await toolsFor(path.join(root, "src")).get("git_status")!.execute({}, context);
    expect(result.content).toContain("modified: app.ts");
    expect(result.content).not.toContain("notes.md");
  });

  it("git_diff shows unstaged, staged, against a ref, and path-filtered diffs", async () => {
    const unstaged = await tools.get("git_diff")!.execute({}, context);
    expect(unstaged.content).toContain("-export const a = 2;\n+export const a = 3;");
    expect(unstaged.content).not.toContain("second");

    const staged = await tools.get("git_diff")!.execute({ staged: true }, context);
    expect(staged.content).toContain("+second");
    expect(staged.content).not.toContain("export const a");

    const againstRef = await tools.get("git_diff")!.execute({ ref: "HEAD~1", path: "src" }, context);
    expect(againstRef.content).toContain("-export const a = 1;\n+export const a = 3;");
    expect(againstRef.content).not.toContain("notes.md");

    const stat = await tools.get("git_diff")!.execute({ stat: true }, context);
    expect(stat.content).toMatch(/src\/app\.ts \| 2 \+-/);

    const empty = await tools.get("git_diff")!.execute({ path: "notes.md" }, context);
    expect(empty.content).toBe("No unstaged changes in notes.md.");
  });

  it("git_diff truncates long output", async () => {
    await fs.writeFile(path.join(root, "src", "big.ts"), "");
    git(root, "add", "src/big.ts");
    await fs.writeFile(path.join(root, "src", "big.ts"), Array.from({ length: 400 }, (_, line) => `export const value${line} = ${line};`).join("\n"));
    try {
      const result = await tools.get("git_diff")!.execute({ path: "src/big.ts", maxChars: 1_000 }, context);
      expect(result.content.length).toBeLessThan(1_200);
      expect(result.content).toMatch(/\[truncated: showed \d+ of \d+ chars/);
      expect(result.data).toMatchObject({ truncated: true });
    } finally {
      git(root, "rm", "-q", "-f", "--cached", "src/big.ts");
      await fs.rm(path.join(root, "src", "big.ts"));
    }
  });

  it("git_log lists commits newest first, with n and path filters", async () => {
    const all = await tools.get("git_log")!.execute({}, context);
    const commits = (all.data as { commits: Array<{ subject: string; author: string }> }).commits;
    expect(commits.map((commit) => commit.subject)).toEqual(["Bump a", "Initial commit"]);
    expect(commits[0].author).toBe("Ada");
    expect(all.content).toMatch(/^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} Ada: Bump a$/m);

    const one = await tools.get("git_log")!.execute({ n: 1 }, context);
    expect((one.data as { commits: unknown[] }).commits).toHaveLength(1);

    const notes = await tools.get("git_log")!.execute({ path: "notes.md" }, context);
    expect((notes.data as { commits: Array<{ subject: string }> }).commits.map((commit) => commit.subject)).toEqual(["Initial commit"]);
  });

  it("git_show reads a file at a revision, both argument spellings", async () => {
    const separate = await tools.get("git_show")!.execute({ ref: "HEAD~1", path: "src/app.ts" }, context);
    expect(separate.content).toBe("export const a = 1;\n");
    const combined = await tools.get("git_show")!.execute({ ref: "HEAD:src/app.ts" }, context);
    expect(combined.content).toBe("export const a = 2;\n");
  });

  it("git_show without a path shows the commit", async () => {
    const result = await tools.get("git_show")!.execute({ ref: "HEAD" }, context);
    expect(result.content).toContain("Bump a");
    expect(result.content).toContain("+export const a = 2;");
  });

  it("git_show reports a missing path or bad revision as an error, not a crash", async () => {
    const missing = await tools.get("git_show")!.execute({ ref: "HEAD", path: "nope.ts" }, context);
    expect(missing.isError).toBe(true);
    const bad = await tools.get("git_show")!.execute({ ref: "no-such-branch" }, context);
    expect(bad.isError).toBe(true);
  });

  it("refuses paths outside the workspace and option-like refs", async () => {
    await expect(tools.get("git_show")!.execute({ ref: "HEAD", path: "../etc/passwd" }, context)).rejects.toThrow(/escapes the workspace root/);
    await expect(tools.get("git_diff")!.execute({ path: "../../" }, context)).rejects.toThrow(/escapes the workspace root/);
    await expect(tools.get("git_diff")!.execute({ ref: "--output=pwned.txt" }, context)).rejects.toThrow(/not a valid git revision/);
    await expect(tools.get("git_log")!.execute({ ref: "-p" }, context)).rejects.toThrow(/not a valid git revision/);
    await expect(fs.access(path.join(root, "pwned.txt"))).rejects.toThrow();
  });

  it("reports 'not a git repository' gracefully", async () => {
    const outsideTools = toolsFor(outside);
    for (const [name, args] of [["git_status", {}], ["git_diff", {}], ["git_log", {}], ["git_show", { ref: "HEAD" }]] as const) {
      const result = await outsideTools.get(name)!.execute(args, context);
      expect(result.content).toMatch(/Not a git repository/);
      expect(result.isError).toBe(false);
      expect(result.data).toMatchObject({ ok: false, reason: "not_a_repository" });
    }
  });

  it("handles a repository with no commits", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-git-empty-"));
    try {
      git(empty, "init", "-q", "-b", "trunk");
      const emptyTools = toolsFor(empty);
      const status = await emptyTools.get("git_status")!.execute({}, context);
      expect(status.content).toContain("On trunk (no commits yet)");
      expect(status.content).toContain("Working tree clean.");
      const log = await emptyTools.get("git_log")!.execute({}, context);
      expect(log.content).toBe("No commits yet.");
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});
