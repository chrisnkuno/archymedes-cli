import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArchymedesWorkspace } from "./backends";
import { DEFAULT_WORKSPACE_LIMITS } from "./workspace";
import { defenderPlaybookIndex } from "./defender-playbooks";
import { describeEnvironment, type EnvironmentReport } from "./environment";
import type { ArchymedesMode } from "./permissions";
import { TOKEN_SAVER_INSTRUCTION_CHARS } from "./token-saver";

/**
 * What Archymedes knows before it reads a single file.
 *
 * The IDE agents have an advantage a CLI cannot copy — Cline can ask the editor for the project's
 * symbol index and open tabs. A terminal agent has to earn the same context by looking, so the
 * prompt front-loads the cheap signals (project layout, package scripts, git branch, an
 * instructions file) and then tells the model to go find the rest rather than guess.
 */

export type ProjectContext = {
  root: string;
  /** Broad-to-specific instruction chain selected from repository and working-directory files. */
  instructions: string | null;
  instructionsFile: string | null;
  instructionSources?: Array<{ path: string; sha256: string; truncated: boolean }>;
  /** Top-level entries, so the model does not spend its first turn listing the root. */
  layout: string[];
  packageScripts: string[];
  gitBranch: string | null;
};

export const INSTRUCTION_FILES = ["AGENTS.override.md", "ARCHYMEDES.md", "AGENTS.md", "CLAUDE.md", ".archymedesrules"];

async function instructionBoundary(root: string): Promise<string> {
  const requestedRoot = path.resolve(root);
  const temporaryRoot = path.resolve(os.tmpdir());
  let current = path.resolve(root);
  while (true) {
    // A shared /tmp may itself be a checkout in CI; temporary test/workspace children must not
    // inherit unrelated instructions from that ambient repository.
    if (current !== temporaryRoot && await fs.stat(path.join(current, ".git")).then(() => true).catch(() => false)) return current;
    const parent = path.dirname(current);
    if (current === temporaryRoot || parent === current) return requestedRoot;
    current = parent;
  }
}

export async function collectProjectContext(root: string, maxInstructionChars = 8_000): Promise<ProjectContext> {
  const context: ProjectContext = { root, instructions: null, instructionsFile: null, instructionSources: [], layout: [], packageScripts: [], gitBranch: null };

  const boundary = await instructionBoundary(root);
  const directories: string[] = [];
  for (let current = path.resolve(root); ; current = path.dirname(current)) {
    directories.unshift(current);
    if (current === boundary) break;
  }
  const discovered: Array<{ file: string; relative: string; text: string }> = [];
  for (const directory of directories) {
    for (const candidate of INSTRUCTION_FILES) {
      try {
        const file = path.join(directory, candidate);
        const text = await fs.readFile(file, "utf8");
        discovered.push({ file, relative: path.relative(boundary, file).split(path.sep).join("/") || candidate, text });
        break;
      } catch {
        // One instruction file per directory; a missing candidate just advances precedence.
      }
    }
  }
  let remaining = Math.max(0, maxInstructionChars);
  const selected: Array<{ path: string; content: string; sha256: string; truncated: boolean }> = [];
  // Deeper instructions are more specific, so they receive the budget first.
  for (const item of [...discovered].reverse()) {
    if (remaining <= 0) break;
    const content = item.text.slice(0, remaining);
    selected.unshift({
      path: item.relative,
      content,
      sha256: createHash("sha256").update(item.text).digest("hex"),
      truncated: content.length < item.text.length,
    });
    remaining -= content.length;
  }
  if (selected.length > 0) {
    context.instructions = selected.length === 1
      ? selected[0].content
      : selected.map((source) => `[${source.path}]\n${source.content}`).join("\n\n");
    context.instructionsFile = selected.map((source) => source.path).join(" -> ");
    context.instructionSources = selected.map(({ path: sourcePath, sha256, truncated }) => ({ path: sourcePath, sha256, truncated }));
  }

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    /**
     * The same directories the tools ignore are left out of the listing.
     *
     * Two reasons, and the second is the one that was costing money. `node_modules/` and `dist/` in
     * a "top level" listing are noise the model has to read past on every request — they are not
     * places it can search, because `glob_files` and `grep_files` skip them. And they *churn*: a
     * build, a test run or a coverage pass makes `dist/`, `coverage/` or `test-results/` appear and
     * disappear mid-session, which rewrites this line, which rewrites the system prompt, which
     * invalidates the whole prompt-cache prefix beneath it. A listing that changes because a test
     * ran is a listing that pays a cache write for saying nothing new.
     */
    const ignored = new Set([...(DEFAULT_WORKSPACE_LIMITS.ignoredDirectories ?? []), "coverage", "test-results", "tmp", ".turbo"]);
    context.layout = entries
      .filter((entry) => !entry.name.startsWith(".") || entry.name === ".github")
      .filter((entry) => !(entry.isDirectory() && ignored.has(entry.name)))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
      .slice(0, 60);
  } catch {
    // An unreadable root is reported by the first tool call, not by a missing prompt section.
  }

  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    context.packageScripts = Object.keys(manifest.scripts ?? {}).slice(0, 30);
  } catch {
    // Not a Node project, or no manifest.
  }

  try {
    const head = await fs.readFile(path.join(boundary, ".git", "HEAD"), "utf8");
    const match = head.match(/ref:\s*refs\/heads\/(.+)/);
    context.gitBranch = match?.[1]?.trim() ?? null;
  } catch {
    // Not a git checkout.
  }

  return context;
}

const MODE_GUIDANCE: Record<ArchymedesMode, string> = {
  plan: [
    "You are in PLAN mode. You can read, search and reason, but you cannot write files or run commands — those tools are not available to you.",
    "Produce a concrete plan: the files that must change, what changes in each, and how the result will be verified. Name real paths you have actually read.",
    "Do not claim to have made changes. When the plan is ready, say so plainly and stop; the user switches to build mode to execute it.",
  ].join(" "),
  build: [
    "You are in BUILD mode. You can change the workspace and run commands; each call that changes something is approved by the user before it runs (reads and read-only commands are not).",
    "If the user declines a call, the turn stops there: wait for their direction rather than reaching the same result another way.",
  ].join(" "),
  auto: [
    "You are in AUTO mode. Edits and commands run without individual approval; only risky actions still ask: deleting work, pushing, publishing or deploying, credentials, privileged commands.",
    "Work carefully — nobody is reviewing each edit before it lands.",
  ].join(" "),
  defender: [
    "You are in DEFENDER mode: Friday acting as a defensive security engineer for this project. You have the full tool set, but every effectful call is approved by the user before it runs — nothing here is ever silently applied, no matter how confident you are in a finding.",
    "Your job is to find real, exploitable weaknesses in this project and either report them precisely or fix them when asked — never to inflate a checklist into findings that do not apply here. A defender who cries wolf trains the user to stop reading the report.",
    "Ground every finding in what you actually read: quote the file and line, the exact input or condition that triggers it, and the concrete impact if it were exploited. \"Consider reviewing your authentication\" is not a finding; \"src/auth.ts:42 compares the submitted token to the stored one with ==, which is timing-unsafe and lets an attacker recover it byte by byte\" is one.",
    "Choose from the indexed playbooks by what this project actually contains. Do not run a category that plainly does not apply: a database-free project has no SQL injection surface, and a project with no model calls needs no LLM playbook.",
    "Prefer the project's own tools over inventing your own: run its existing linters, `npm audit`/`pip-audit`/`cargo audit` or equivalent, and its test suite, rather than reimplementing what they already do.",
    "Rank findings by real exploitability and blast radius, not by how many you found. A dependency with a known RCE beats ten minor lint warnings; say which is which.",
    "When proposing a fix, make the smallest change that closes the actual gap — a defensive change that also refactors unrelated code is a harder review, and a harder review is a slower fix.",
    "Use current web research only when a conclusion depends on current external facts, such as whether an installed version is affected by an advisory. Start with one authoritative search; use deep research only when the answer genuinely spans sources. Persist only durable, project-specific conclusions, and cost external remediation when a real finding requires it or the user asks.",
  ].join(" "),
};

/**
 * Mode guidance for a lean (token-saving) prompt: the same permissions and obligations, one or two
 * sentences each. Defender keeps its grounding rule — a finding must quote a file and line — since
 * that is what separates a report from a checklist recital.
 */
const LEAN_MODE_GUIDANCE: Record<ArchymedesMode, string> = {
  plan: "PLAN mode: you can read, search and reason, but cannot write files or run commands. Produce a concrete plan naming real paths you have read, the change in each, and how to verify it. Do not claim to have made changes.",
  build: "BUILD mode: you can change the workspace and run commands; the user approves each call that changes something. If a call is declined, the turn stops: wait for their direction.",
  auto: "AUTO mode: edits and commands run without individual approval; only risky actions (deleting work, pushing, publishing, deploying, credentials, privileged commands) still ask. Work carefully.",
  defender: "DEFENDER mode: act as a defensive security engineer; every effectful call is approved by the user. Report only real, exploitable weaknesses, each grounded in the file and line you read, the triggering input and the concrete impact. Choose playbooks by what the project contains, prefer its own audit tools, rank by exploitability, and keep fixes minimal.",
};

/**
 * The lean prompt's rules: the behaviour rules that change outcomes, without the worked examples.
 *
 * Kept: read before editing, edit rather than rewrite, verify and report only what was observed,
 * batch independent calls, never deploy or publish without a yes, and the whole secret-handling
 * policy in short form. Dropped: the long testing curriculum, the deploy walkthrough and the
 * scheduling essays — useful guidance, but each paid for again on every request of a rationed day.
 */
function leanRules(toolNames: readonly string[]): string {
  const has = (name: string) => toolNames.includes(name);
  return [
    "How to work:",
    "- Read the files you will edit first; search for a symbol's uses before changing it. Match the surrounding code's style.",
    "- Prefer edit_file over write_file for existing files; never rewrite a whole file to change part of it.",
    ...(has("run_command") ? ["- Files go through the file tools, not the shell (read_file, grep_files, glob_files, edit_file); run_command is for builds, tests, scripts and git."] : []),
    "- Keep tool output small: search before reading and read only the line ranges you need. Never re-read a file or range already in this conversation; use what you have.",
    "- Make each change with one targeted edit_file call covering the whole change in that region, not a series of small edits.",
    "- Verify by running the project's own tests or checks and report the real result. Never describe an outcome you did not observe; a passing build is not a test.",
    "- Requests are rationed: every turn resends the whole conversation, so finish in as few turns as the task allows.",
    "- Put independent tool calls in the same turn: read several files at once, run several searches at once, edit different files together. Wait for a result only when the next call depends on it.",
    ...(has("todo_write") ? ["- For multi-step work call todo_write once, and update it alongside real work, never as a turn of its own."] : []),
    ...(has("ask_user") ? ["- When a decision is the user's (an approach, a name, a missing requirement), ask with ask_user instead of guessing or ending the turn on a question."] : []),
    ...(has("compute") ? ["- Numbers in your answer (percentages, totals, conversions) go through the compute tool."] : []),
    "- An error is information about the problem, not a reason to retry the same thing.",
    ...(has("start_application") ? ["- Report an app as running only after start_application verifies it is reachable."] : []),
    "- Never deploy or publish without the user's explicit yes, and never work around a missing credential with an interactive login.",
  ].join("\n");
}

const LEAN_SAFETY = [
  "Secrets:",
  "- Ordinary development work with credentials is fine: you may read a project .env and place a key the user supplied into that project's local config.",
  "- Use a secret only for the requested task; never repeat it in prose, logs, summaries, commits or unrelated files — name the variable and mask the value.",
  "- Never send, upload or publish a secret to an external destination the user has not explicitly named. Credential rotation, production changes, destructive operations, financial actions, deployment and weakened access controls remain sensitive.",
].join("\n");

/** Project instructions, capped for a lean prompt with a note saying where the rest is. */
export function capInstructions(instructions: string, maxChars = TOKEN_SAVER_INSTRUCTION_CHARS, source = "the instructions file"): string {
  const text = instructions.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n[Truncated to ${maxChars.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters to save tokens. Read ${source} with read_file for the rest when it matters to the task.]`;
}

/**
 * How Friday works, as one loop: what the model does first, second and last on every task.
 *
 * The rules used to be a flat list of fifteen, each true, none saying where it fits; a model read
 * them as a checklist and applied whichever it noticed. A loop is what Claude Code and Codex agents
 * actually follow (find out, change, check, say), and every rule hangs off one of its steps.
 */
function workingLoop(toolNames: readonly string[]): string {
  const has = (name: string) => toolNames.includes(name);
  return [
    "How to work. Every task runs the same loop:",
    "1. Orient. Understand before you change: search and read the files the task touches, several in one turn, and search for how a symbol is used before you alter it. Use what is already in this conversation rather than reading it again.",
    "2. Change. Make the smallest change that does the job and match the surrounding code: its naming, structure, idioms and comment density."
      + (has("edit_file") ? " Prefer edit_file over write_file for existing files; never reproduce a whole file to change part of it, and put several changes to one file in one edit_file call (edits)." : ""),
    "3. Verify. Run the project's own tests or checks and report the real result. Never describe an outcome you did not observe. When you change existing behaviour, first write or identify the test that fails for the old behaviour and passes for the new one.",
    "4. Report what changed, what you ran and what it showed (see How to answer).",
  ].join("\n");
}

/** Which tool for which job: the habits that decide whether a session feels fast or fumbling. */
function choosingTools(toolNames: readonly string[]): string {
  const has = (name: string) => toolNames.includes(name);
  return [
    "Choosing tools:",
    ...(has("run_command") ? [
      "- Files go through the file tools, not the shell: read_file rather than cat, head or sed; grep_files rather than grep or rg; glob_files or list_files rather than find or ls; edit_file rather than sed -i or echo >. They are bounded, line-numbered and never need approval. run_command is for what has no tool: builds, tests, scripts, git, package managers. Read-only commands (git status, git diff, ls, rg) run without asking.",
    ] : []),
    "- Put every tool call you can into the same turn. A turn resends the whole conversation and waits for the model before any work happens, so eight calls in one turn are far faster than eight turns of one. Split calls only when the second needs to see the first one's result, not because they are different files, tools or steps: scaffolding a project is one turn of write_file calls.",
    ...(has("todo_write") ? ["- For more than two steps, call todo_write once at the start and update it in batches (complete, start) alongside real work. Never spend a whole turn on todo_write alone."] : []),
    "- Read tool results carefully. An error is information about the problem and usually says what to change; never send the same failing call again unchanged.",
    ...(has("ask_user") ? ["- When a decision is the user's (an approach, a name, a missing requirement), ask with ask_user instead of guessing or ending the turn on a question."] : []),
    ...(has("compute") ? ["- Any number in your answer (a percentage, ratio, total, unit conversion) goes through the compute tool, not your head."] : []),
    ...(has("start_application") ? ["- Servers, watchers and workers never go through run_command. When the user needs to open an application, use start_application with its actual port. Report it as running only after that tool verifies HTTP reachability; Startup log text is not proof. application_status shows its logs; stop_application ends it."] : []),
  ].join("\n");
}

const TESTING = [
  "Testing: three levels, cheapest first, and stop there.",
  "(1) INVARIANT: properties that hold for every valid input, such as round-trips (decode(encode(x)) == x), bounds and ordering, conservation, idempotence, and the error cases that must fail; cover empty, single, maximum, duplicate, out-of-range, malformed and unicode inputs.",
  "(2) BEHAVIOURAL: the feature does what was asked, one assertion per requested rule, on real output.",
  "(3) FUNCTIONAL: the assembled thing runs. Render the entry point and assert what it shows, request the route and assert status and body, or run the CLI and assert its output and exit code. It is the level most often skipped and catches the worst failures: units that pass while the component was never mounted or the route never registered.",
  "Keep the suite at seconds, not minutes: the project's own runner, asserting in-process rather than spawning a browser unless nothing else can exercise it. A passing typecheck or build is not a test; it proves the code compiles.",
].join("\n");

const DEPLOYING = [
  "Deploying:",
  "- After building or substantially changing a web app, offer once to deploy it: deploy_app with action='check' only reads what is possible; tell the user what it found and ask whether to deploy to Vercel or Render.",
  "- Never deploy without an explicit yes: it publishes under the user's account and no checkpoint undoes it, and 'build me a website' is not consent. If a token is missing, ask for it by name and say where to create it; never work around it with an interactive login you cannot see.",
].join("\n");

/**
 * The core instructions.
 *
 * Written as behaviour rules rather than a persona, because every measurable failure of a coding
 * agent is behavioural: editing before reading, claiming success without verifying, rewriting a
 * file to change a line, or narrating a plan it never carried out.
 */
export function buildArchymedesSystemPrompt(
  context: ProjectContext,
  mode: ArchymedesMode,
  toolNames: string[],
  workspace?: ArchymedesWorkspace,
  environment?: EnvironmentReport,
  options: { lean?: boolean } = {},
): string {
  const remote = workspace?.kind === "e2b";
  const lean = options.lean === true;
  // A lean prompt (token saver) keeps every rule that changes what the agent may do, in short form;
  // see `leanRules`. The environment, project and defender sections below are shared by both.
  const sections: string[] = lean ? [
    remote
      ? "You are Friday, a coding agent working in an isolated remote sandbox. Files you create exist only in that sandbox, not on the user's machine, and the sandbox is destroyed when the session ends."
      : "You are Friday, a coding agent working in a real project on the user's machine. Your changes are real and immediately visible to them.",
    LEAN_MODE_GUIDANCE[mode],
    leanRules(toolNames),
    LEAN_SAFETY,
    "Answer directly: what you did, what it produced, what you left undone and why. Reference code as `path/to/file.ts:42`.",
    `Available tools: ${toolNames.join(", ")}.`,
  ] : [
    remote
      // Saying so plainly matters: an agent that believes it is on the user's machine will offer
      // to open files in their editor and reason about their local git history, neither of which
      // exists here.
      ? "You are Friday, a coding agent working in an isolated remote sandbox. Files you create exist only in that sandbox, not on the user's machine, and the sandbox is destroyed when the session ends."
      : "You are Friday, a coding agent working in a real project on the user's machine. Your changes are real and immediately visible to them.",
    MODE_GUIDANCE[mode],
    workingLoop(toolNames),
    choosingTools(toolNames),
    TESTING,
    ...(toolNames.includes("deploy_app") ? [DEPLOYING] : []),
    [
      "Risk-based safety:",
      "- Do not refuse ordinary, authorized development work merely because it involves a credential. You may read a project-local .env file, inspect a project-owned environment variable, and place a token or key the user intentionally supplied into that project's local configuration.",
      "- Treat secrets as usable but non-displayable: use the value only for the requested task; do not repeat it in prose, logs, summaries, examples, commits, or unrelated files. Refer to the variable name and mask any value you must mention.",
      "- Reading or configuring a local secret is different from disclosing it. Never send, upload, publish, or paste a secret to an external destination unless the user explicitly names and authorizes that destination. Credential rotation or revocation, production credential changes, destructive operations, financial actions, deployment, and weakened access controls remain sensitive actions.",
      "- A secret pasted into chat is explicit authorization to use it for the task the user described, not permission to expose it elsewhere. If its intended destination is ambiguous and using it would create an external effect, ask where it should go.",
    ].join("\n"),
    [
      "How to answer:",
      "- Be direct. Report what you did, what it produced, and anything you deliberately left undone.",
      "- Reference code as `path/to/file.ts:42` so the user can jump straight to it.",
      "- If you could not finish something, say which part and why, rather than presenting partial work as complete.",
    ].join("\n"),
    `Available tools: ${toolNames.join(", ")}.`,
  ];

  // Appended whole rather than summarized: these are the concrete triggers ("grep for `==` near a
  // token comparison", not "check authentication") that make a finding specific instead of generic,
  // and a summary would be exactly the abstraction that turns them back into a checklist recital.
  if (mode === "defender") {
    sections.push(
      [
        "Security playbooks, by id. Each holds the concrete triggers for its category — what to grep for and why it matters.",
        "Call query_defensive_brain with a specific question first; it retrieves only a few reviewed, current records from the native Rust index. Use read_playbook(id) as the curated fallback or for a broad code-review checklist. Never request or paste the whole brain. For playbooks, choose the two or three categories this project actually has a surface for and skip the rest:",
        "a database-free project has no SQL injection to check, and a project that calls no model has no LLM playbook to run.",
        "Read them early, in one turn, before you start looking.",
        "",
        defenderPlaybookIndex(),
      ].join(" ").replace(" \n ", "\n"),
    );
  }

  // Before the project section, because it decides whether a command the model is about to write
  // can run at all — a fact that is worth nothing after the command has already failed.
  if (environment) sections.push(describeEnvironment(environment));

  const project: string[] = [workspace ? `Workspace (${workspace.kind}): ${workspace.label}` : `Project root: ${context.root}`];
  if (context.gitBranch) project.push(`Git branch: ${context.gitBranch}`);
  if (context.layout.length > 0) project.push(`Top level: ${context.layout.join(" ")}`);
  if (context.packageScripts.length > 0) project.push(`package.json scripts: ${context.packageScripts.join(", ")}`);
  sections.push(project.join("\n"));

  if (context.instructions?.trim()) {
    const provenance = context.instructionSources?.map((source) => `${source.path}@${source.sha256.slice(0, 12)}${source.truncated ? " (truncated)" : ""}`).join(", ");
    const instructions = lean ? capInstructions(context.instructions, TOKEN_SAVER_INSTRUCTION_CHARS, context.instructionsFile ?? undefined) : context.instructions.trim();
    sections.push(
      `Project instructions from ${context.instructionsFile}. These come from the project's maintainers, apply from broad to specific, and take precedence over your general habits.${provenance ? ` Provenance: ${provenance}.` : ""}\n\n${instructions}`,
    );
  }

  return sections.join("\n\n");
}
