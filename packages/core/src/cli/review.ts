import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runGit, type GitRunner } from "./checkpoints";

/**
 * `/review`: a reading of a change that reports findings and touches nothing, after Codex's review
 * presets. What is reviewed is a git diff — the uncommitted work, a branch's commits since it left
 * a base (as a pull request would show them), one commit, or another branch against HEAD — and the
 * answer is structured, so the interface can list findings and the agent can be asked to fix one.
 *
 * Pure parts (the target, the prompt, reading the answer) are separate from the one git step, so
 * each is tested on its own.
 */

export type ReviewTarget =
  | { kind: "uncommitted"; instructions?: string }
  | { kind: "base"; ref: string }
  | { kind: "commit"; ref: string }
  | { kind: "branch"; ref: string };

export type ReviewSeverity = "high" | "medium" | "low";

export type ReviewFinding = { file: string; line?: number; severity: ReviewSeverity; title: string; body: string };

export type ReviewResult = { target: string; findings: ReviewFinding[]; overall: string };

/**
 * Reads `/review`'s argument: nothing or `uncommitted`, `base <ref>`, `commit <ref>`,
 * `branch <ref>`; anything else is what to look for in the uncommitted work.
 */
export function parseReviewTarget(argument: string): ReviewTarget | { error: string } {
  const text = argument.trim();
  if (text === "" || text === "uncommitted") return { kind: "uncommitted" };
  const [word = "", ref = "", ...rest] = text.split(/\s+/);
  if (word === "base" || word === "commit" || word === "branch") {
    if (!ref || rest.length > 0) return { error: `/review ${word} takes one git ref, like /review ${word} main` };
    // A ref is handed to git as an argument; one that starts with "-" would be read as an option.
    if (ref.startsWith("-") || !/^[\w./@^~{}-]+$/.test(ref)) return { error: `Not a git ref: ${ref}` };
    return { kind: word, ref };
  }
  return { kind: "uncommitted", instructions: text };
}

export function describeReviewTarget(target: ReviewTarget): string {
  switch (target.kind) {
    case "uncommitted":
      return "the uncommitted changes";
    case "base":
      return `this branch's changes since ${target.ref}`;
    case "commit":
      return `commit ${target.ref}`;
    case "branch":
      return `branch ${target.ref} against HEAD`;
  }
}

/** The empty tree, for a repository with no commit yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The patch a target names, read-only. The uncommitted case goes through a private index so new
 * files are included without staging anything of the person's.
 */
export async function reviewPatch(root: string, target: ReviewTarget, git: GitRunner = runGit): Promise<{ patch: string } | { error: string }> {
  const run = async (args: string[], env?: Record<string, string>) => {
    const result = await git(args, { cwd: root, ...(env ? { env } : {}) });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
    return result.stdout;
  };
  try {
    switch (target.kind) {
      case "base":
        return { patch: await run(["diff", "--no-color", "--unified=3", `${target.ref}...HEAD`, "--"]) };
      case "branch":
        return { patch: await run(["diff", "--no-color", "--unified=3", `HEAD...${target.ref}`, "--"]) };
      case "commit":
        return { patch: await run(["show", "--no-color", "--unified=3", "--format=commit %H%n%n%B", target.ref, "--"]) };
      case "uncommitted": {
        const head = (await git(["rev-parse", "--verify", "-q", "HEAD^{tree}"], { cwd: root })).exitCode === 0 ? "HEAD" : EMPTY_TREE;
        const index = path.join(root, ".archymedes", `review-index-${randomUUID()}`);
        await fs.mkdir(path.dirname(index), { recursive: true });
        const env = { GIT_INDEX_FILE: index };
        try {
          await run(["read-tree", head], env);
          await run(["add", "--all", "--", ".", ":(exclude).archymedes"], env);
          return { patch: await run(["diff", "--cached", "--no-color", "--unified=3", head, "--", ".", ":(exclude).archymedes"], env) };
        } finally {
          await fs.unlink(index).catch(() => undefined);
        }
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export const REVIEW_INSTRUCTION = [
  "Review the change below as a careful senior engineer would review a pull request.",
  "Report only real problems a maintainer would want fixed: bugs, wrong behaviour, data loss, security holes, broken edge cases, missing error handling that matters, tests that do not test what they claim.",
  "Do not report style preferences, naming, or things that are merely different from how you would write them. Fewer, certain findings beat many speculative ones; an empty list is a fine answer.",
  "For each finding give the file, the line in the new version, a severity (high: wrong or unsafe in normal use; medium: wrong in a plausible case; low: worth fixing, rarely matters), a one-line title, and a short body saying what goes wrong and when.",
  'Answer with JSON only, no prose around it: {"findings":[{"file":"src/a.ts","line":12,"severity":"high","title":"...","body":"..."}],"overall":"one or two sentences on the change as a whole"}',
].join(" ");

/** The review request: the instruction, the person's focus if any, and the patch (cut to `limit`). */
export function reviewPrompt(target: ReviewTarget, patch: string, limit: number): string {
  const cut = patch.length > limit;
  const focus = target.kind === "uncommitted" && target.instructions ? `\n\nThe person asked you to look especially at: ${target.instructions}` : "";
  return `${REVIEW_INSTRUCTION}${focus}\n\nWhat is reviewed: ${describeReviewTarget(target)}.${cut ? ` The patch is ${patch.length.toLocaleString("en-US")} characters; only the first ${limit.toLocaleString("en-US")} are shown, so say in "overall" that the review is partial.` : ""}\n\n<patch>\n${cut ? patch.slice(0, limit) : patch}\n</patch>`;
}

/**
 * Reads the reviewer's answer. JSON as asked; else the first JSON object inside the text (a model
 * that wrapped it in a fence or a sentence); else the whole text as the overall verdict with no
 * findings — never a failure, since the words are still the review.
 */
export function parseReview(text: string, target: string): ReviewResult {
  const parsed = parseJsonObject(text);
  if (!parsed) return { target, findings: [], overall: text.trim() };
  const findings: ReviewFinding[] = [];
  for (const item of Array.isArray(parsed.findings) ? parsed.findings : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) continue;
    const severity = record.severity === "high" || record.severity === "medium" || record.severity === "low" ? record.severity : "medium";
    const line = typeof record.line === "number" && Number.isInteger(record.line) && record.line > 0 ? record.line : Number.parseInt(String(record.line ?? ""), 10);
    findings.push({
      file: typeof record.file === "string" ? record.file : "",
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      severity,
      title,
      body: typeof record.body === "string" ? record.body.trim() : "",
    });
  }
  const order: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { target, findings, overall: typeof parsed.overall === "string" ? parsed.overall.trim() : "" };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const attempt = (candidate: string) => {
    try {
      const value: unknown = JSON.parse(candidate);
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const whole = attempt(text.trim());
  if (whole) return whole;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? attempt(text.slice(start, end + 1)) : undefined;
}

/** The review as the conversation keeps it, so "fix the second finding" means something next turn. */
export function reviewTranscript(result: ReviewResult): string {
  const lines = [`Review of ${result.target}: ${result.findings.length === 0 ? "no findings." : `${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}.`}`];
  result.findings.forEach((finding, index) => {
    const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    lines.push(`${index + 1}. [${finding.severity}] ${where} — ${finding.title}${finding.body ? `\n   ${finding.body}` : ""}`);
  });
  if (result.overall) lines.push("", result.overall);
  return lines.join("\n");
}
