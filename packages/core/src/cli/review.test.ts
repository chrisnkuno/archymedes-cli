import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeReviewTarget, parseReview, parseReviewTarget, reviewPatch, reviewPrompt, reviewTranscript } from "./review";

let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const write = (name: string, content: string) => fs.writeFile(path.join(root, name), content);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "review-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe("what /review reads", () => {
  it("names a target from the argument, refusing what git would read as an option", () => {
    expect(parseReviewTarget("")).toEqual({ kind: "uncommitted" });
    expect(parseReviewTarget("uncommitted")).toEqual({ kind: "uncommitted" });
    expect(parseReviewTarget("base main")).toEqual({ kind: "base", ref: "main" });
    expect(parseReviewTarget("commit HEAD~1")).toEqual({ kind: "commit", ref: "HEAD~1" });
    expect(parseReviewTarget("branch feature/x")).toEqual({ kind: "branch", ref: "feature/x" });
    expect(parseReviewTarget("the error handling")).toEqual({ kind: "uncommitted", instructions: "the error handling" });
    expect(parseReviewTarget("base --output=/tmp/x")).toHaveProperty("error");
    expect(parseReviewTarget("commit a b")).toHaveProperty("error");
    expect(parseReviewTarget("branch")).toHaveProperty("error");
  });

  it("reads uncommitted work, new files included, without staging anything", async () => {
    await write("a.txt", "one\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
    await write("a.txt", "one\ntwo\n");
    await write("new.txt", "brand new\n");
    const read = await reviewPatch(root, { kind: "uncommitted" });
    expect("patch" in read && read.patch).toContain("+two");
    expect("patch" in read && read.patch).toContain("new.txt");
    expect(git("diff", "--cached", "--name-only")).toBe("");
  });

  it("reads a repository with no commit yet", async () => {
    await write("first.txt", "hello\n");
    const read = await reviewPatch(root, { kind: "uncommitted" });
    expect("patch" in read && read.patch).toContain("+hello");
  });

  it("reads a branch since its base, another branch against HEAD, and one commit", async () => {
    await write("a.txt", "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    await write("a.txt", "base\nfeature\n");
    git("commit", "-q", "-am", "feature work");
    git("checkout", "-q", "main");
    await write("b.txt", "main only\n");
    git("add", ".");
    git("commit", "-q", "-m", "main work");

    const branch = await reviewPatch(root, { kind: "branch", ref: "feature" });
    expect("patch" in branch && branch.patch).toContain("+feature");
    expect("patch" in branch && branch.patch).not.toContain("main only");

    git("checkout", "-q", "feature");
    const base = await reviewPatch(root, { kind: "base", ref: "main" });
    expect("patch" in base && base.patch).toContain("+feature");
    expect("patch" in base && base.patch).not.toContain("main only");

    const commit = await reviewPatch(root, { kind: "commit", ref: "HEAD" });
    expect("patch" in commit && commit.patch).toContain("feature work");
    expect(await reviewPatch(root, { kind: "commit", ref: "nope" })).toHaveProperty("error");
  });
});

describe("the reviewer's answer", () => {
  it("reads JSON as asked, worst first, and keeps only findings with a title", () => {
    const result = parseReview(JSON.stringify({
      findings: [
        { file: "a.ts", line: 3, severity: "low", title: "minor", body: "rarely" },
        { file: "b.ts", line: "12", severity: "high", title: "data loss", body: "on retry" },
        { file: "c.ts", severity: "nonsense", title: "unsure severity" },
        { file: "d.ts", body: "no title" },
      ],
      overall: "Mostly fine.",
    }), "the uncommitted changes");
    expect(result.findings.map((finding) => [finding.severity, finding.title, finding.line])).toEqual([["high", "data loss", 12], ["medium", "unsure severity", undefined], ["low", "minor", 3]]);
    expect(result.overall).toBe("Mostly fine.");
  });

  it("finds the JSON inside a fence or a sentence, and keeps plain words as the verdict", () => {
    expect(parseReview('Here you go:\n```json\n{"findings":[{"file":"x","title":"t"}],"overall":"o"}\n```', "t").findings).toHaveLength(1);
    expect(parseReview("Looks correct to me.", "t")).toEqual({ target: "t", findings: [], overall: "Looks correct to me." });
  });

  it("asks for JSON, carries the focus, and says when the patch was cut", () => {
    const prompt = reviewPrompt({ kind: "uncommitted", instructions: "the parser" }, "x".repeat(50), 10);
    expect(prompt).toContain("Answer with JSON only");
    expect(prompt).toContain("look especially at: the parser");
    expect(prompt).toContain("only the first 10 are shown");
    expect(describeReviewTarget({ kind: "base", ref: "main" })).toBe("this branch's changes since main");
  });

  it("is kept in the conversation as numbered findings the next message can name", () => {
    const text = reviewTranscript({ target: "the uncommitted changes", findings: [{ file: "a.ts", line: 2, severity: "high", title: "off by one", body: "skips the last item" }], overall: "One real bug." });
    expect(text).toBe("Review of the uncommitted changes: 1 finding.\n1. [high] a.ts:2 — off by one\n   skips the last item\n\nOne real bug.");
  });
});
