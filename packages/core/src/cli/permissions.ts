import { createHash } from "node:crypto";
import type { AgentTool, AgentToolCall } from "../agent-runtime";
import { assessToolSafety, type SafetyAssessment } from "./safety";
import type { JevJudge, JevToolCheck } from "./jev";

/**
 * Who decides whether a tool call runs.
 *
 * Cline's Plan/Act split is the model adopted here, for the reason it works: the expensive mistakes
 * an agent makes are not bad edits, they are confident edits made before it understood the problem.
 * A mode that physically cannot write forces the understanding to happen first.
 *
 * - `plan`     — read, search and think. No writes, no commands. Nothing to approve because nothing
 *                can change.
 * - `build`    — full tool set, with every effectful call gated on a human decision.
 * - `auto`     — full tool set, workspace edits pre-approved, external actions still gated. For a
 *                disposable checkout or a trusted loop, never the default.
 * - `defender` — full tool set, security-focused system prompt and playbooks (see
 *                `defender-playbooks.ts` in the CLI package), but gated exactly like `build`:
 *                a scanner that quietly patches what it finds is not a scanner anyone can trust,
 *                so nothing here is ever auto-approved regardless of effect.
 */
export type ArchymedesMode = "plan" | "build" | "auto" | "defender";

/**
 * `allow_pattern` accepts the request's offered `pattern` (see `suggestApprovalPattern`) as a
 * standing rule. A request that offered none treats it as a one-time `allow`.
 */
export type PermissionDecision = "allow" | "allow_always" | "allow_pattern" | "deny" | "deny_always";
export type ToolApprovalOutcome = "approved" | "denied";

/** Capability ids the runtime scopes tools by, mirrored from `lib/capability-registry.ts`. */
export const ARCHYMEDES_CAPABILITIES = {
  read: "workspace.files.read",
  write: "workspace.files",
  terminal: "workspace.terminal",
  research: "web.research",
  planning: "reasoning.plan",
  /** Skill, MCP and plugin tools — code Archymedes did not ship, running with the user's approval. */
  external: "workspace.external",
  /** Retrieving a security playbook. Defender mode only — nothing else has a use for one. */
  playbooks: "security.playbooks",
} as const;

/**
 * Everything a working session can call, which is every capability except the defender-only one.
 *
 * Spelled out rather than `Object.values`, because that spread silently handed each new capability
 * to build and auto the moment it was declared — including one whose whole point is that only
 * defender mode has it.
 */
const WORKING_CAPABILITIES = [
  ARCHYMEDES_CAPABILITIES.read,
  ARCHYMEDES_CAPABILITIES.write,
  ARCHYMEDES_CAPABILITIES.terminal,
  ARCHYMEDES_CAPABILITIES.research,
  ARCHYMEDES_CAPABILITIES.planning,
  ARCHYMEDES_CAPABILITIES.external,
];

const MODE_CAPABILITIES: Record<ArchymedesMode, string[]> = {
  // No externally-sourced tool runs in plan mode: plan already permits nothing that changes
  // anything, and a skill/MCP/plugin tool is by definition not one of the effects plan already
  // reasoned about (it could shell out, write files, or call a network service under the hood).
  plan: [ARCHYMEDES_CAPABILITIES.read, ARCHYMEDES_CAPABILITIES.research, ARCHYMEDES_CAPABILITIES.planning],
  build: [...WORKING_CAPABILITIES],
  auto: [...WORKING_CAPABILITIES],
  // The full set, not a read-only subset: a scanner that cannot run `npm audit`, grep for a
  // pattern across the tree, or propose the one-line fix for a vulnerable dependency is a report
  // generator, not a defender. What keeps this safe is `decide()` below never auto-approving it.
  defender: [...WORKING_CAPABILITIES, ARCHYMEDES_CAPABILITIES.playbooks],
};

export function capabilitiesForMode(mode: ArchymedesMode): string[] {
  return [...MODE_CAPABILITIES[mode]];
}

export type ApprovalRequest = {
  call: AgentToolCall;
  tool: AgentTool;
  /** One line a human can act on without reading JSON — "edit src/app.ts", "run npm test". */
  summary: string;
  /** Exact proposed action. Recomputed before every lookup, so changed arguments need consent. */
  actionDigest: string;
  /** Versioned authorization key persisted by `allow_always` / `deny_always`. */
  scopeKey: string;
  policyVersion: typeof APPROVAL_POLICY_VERSION;
  /** Why auto mode did not silently approve this otherwise-workspace-local action. */
  safety: SafetyAssessment;
  /**
   * A broader standing rule the human may grant instead of the exact action — "always allow
   * commands starting with `npm test`", "always allow edits under `src/app`". Absent when the call
   * is not safe to generalize (see `suggestApprovalPattern`). Answering `allow_pattern` grants it.
   */
  pattern?: ApprovalPattern;
  /**
   * Jev's second opinion on the call, when a judge is configured and answered.
   *
   * Annotation, not authorization: it arrives with the prompt so the human reads it
   * beside the rule-based screen, and a missing one changes nothing about the decision.
   */
  jev?: JevToolCheck;
};

export type ApprovalPrompt = (request: ApprovalRequest) => Promise<PermissionDecision>;

/**
 * Remembers standing decisions for the exact normalized action, not merely its tool name.
 *
 * Approval fatigue is a safety problem, not an ergonomics one: an agent that asks forty times
 * trains the human to press `y` without reading, which is strictly worse than asking twice.
 * A changed path, command, argument or effect creates a different digest and must be considered
 * again. This is intentionally narrower than Cline-style UI categories: categories are useful for
 * presentation, but too broad to be authorization keys.
 */
export const APPROVAL_POLICY_VERSION = "archymedes-approval-v2" as const;

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Approval arguments contain a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  throw new Error(`Approval arguments contain unsupported ${typeof value} value`);
}

/**
 * Stable across object key order, but deliberately changes when any meaningful argument changes —
 * including, since `APPROVAL_POLICY_VERSION` bumped to v2, a tool's provenance. A standing
 * `allow_always` for `write_file` was granted to Archymedes's own built-in tool; if a same-named tool
 * later arrives from an MCP server or a skill file, that is a different actor making the same-shaped
 * request, and the old approval must not silently cover it. The version bump means every decision
 * made under v1 is void regardless of provenance — the honest way to close the gap for tools that
 * were already approved before this field existed, rather than guessing which of them would still
 * have been approved knowingly.
 */
export function actionDigest(call: AgentToolCall, tool: AgentTool): string {
  const action = JSON.stringify(canonicalize({
    policyVersion: APPROVAL_POLICY_VERSION,
    tool: tool.name,
    capabilityId: tool.capabilityId,
    effect: tool.effect,
    provenance: tool.provenance ?? { kind: "built-in" },
    arguments: call.arguments ?? {},
  }));
  return createHash("sha256").update(action).digest("hex");
}

export function approvalScopeKey(call: AgentToolCall, tool: AgentTool): string {
  return `${APPROVAL_POLICY_VERSION}:${actionDigest(call, tool)}`;
}

// ---------------------------------------------------------------------------------------------
// Pattern approvals
// ---------------------------------------------------------------------------------------------

/**
 * A standing approval broader than one exact action, offered only where generalizing is safe.
 *
 * Exact digests stay the default authorization key — a pattern exists because approving
 * `npm test` forty times with forty different flags is the approval fatigue the digest comment
 * above warns about. It is deliberately narrow in what it can describe: a command *prefix* (never
 * a regex, never a destructive program) and a workspace-relative *directory* for file edits.
 * Everything still passes `assessToolSafety` at match time, so a pattern can never pre-approve a
 * sensitive call that the exact action would have prompted for.
 */
export type ApprovalPattern =
  | { kind: "command-prefix"; prefix: string; label: string }
  | { kind: "directory"; directory: string; label: string };

/** Shell syntax that chains, substitutes or redirects — a command containing any is never generalized or pattern-matched. */
const SHELL_OPERATORS = /[;&|`$<>(){}\r\n]/;

/** Programs whose every invocation deserves its own look: removal, privilege, raw shells, network, process and system control. */
const NEVER_GENERALIZE = new Set([
  "rm", "rmdir", "del", "erase", "rd", "unlink", "shred", "dd", "mkfs", "format", "truncate",
  "mv", "move", "cp", "copy", "ln", "chmod", "chown", "chgrp", "icacls", "takeown",
  "sudo", "su", "doas", "runas",
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "pwsh", "powershell", "cmd",
  "eval", "exec", "source", "xargs", "env", "nohup", "start", "open", "iex", "invoke-expression",
  "curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "ftp", "rsync", "telnet",
  "kill", "killall", "pkill", "taskkill", "shutdown", "reboot", "halt", "poweroff",
  "systemctl", "service", "launchctl", "crontab", "schtasks", "reg", "setx", "set", "export",
  "find", "docker", "podman", "kubectl", "helm", "terraform", "pulumi", "aws", "gcloud", "az",
  "gh", "heroku", "vercel", "netlify", "fly", "flyctl", "firebase", "railway",
]);

/** Programs that only mean something with their next word: `node x.js`, not `node`. */
const NEEDS_SUBCOMMAND = new Set([
  "node", "python", "python3", "py", "ruby", "perl", "php", "deno", "bun", "java", "dotnet",
  "npm", "pnpm", "yarn", "npx", "bunx", "pnpx", "git", "cargo", "go", "pip", "pip3", "uv", "poetry",
  "make", "mvn", "gradle", "./gradlew", "gradlew", "composer", "bundle", "rake", "mix", "gem",
]);

/** The only git subcommands that read without changing refs, the index or the working tree. */
const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "blame", "grep", "ls-files", "rev-parse", "describe", "shortlog", "fetch"]);

/** Package-manager subcommands that publish, authenticate or install arbitrary code — each one is its own decision. */
const PACKAGE_RISKY = new Set([
  "publish", "unpublish", "deprecate", "owner", "access", "login", "logout", "adduser", "token", "dist-tag", "link",
  "version", "install", "i", "add", "remove", "uninstall", "rm", "un", "update", "upgrade", "up", "yank", "release",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "cargo", "pip", "pip3", "uv", "poetry", "composer", "bundle", "gem"]);
/** Subcommands that run something named by the *next* word, so the prefix must include it. */
const RUNNER_SUBCOMMANDS = new Set(["run", "run-script", "exec", "x", "dlx"]);

function isBuiltIn(tool: AgentTool): boolean {
  return !tool.provenance || tool.provenance.kind === "built-in";
}

function programName(token: string): string {
  return token.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, "");
}

/**
 * The prefix "always allow commands starting with …" would cover, or undefined when the command
 * must not be generalized: chained or redirected, a destructive or privileged program, a raw
 * shell or network client, or a subcommand that publishes, installs, or rewrites history.
 *
 * One word for a self-contained tool (`ls -la` -> `ls`), two for a program that needs its next
 * word (`npm test`, `git status`, `node scripts/build.js`), three for a script runner (`npm run
 * build`, so approving one script never approves every script).
 */
export function commandApprovalPrefix(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 500 || SHELL_OPERATORS.test(trimmed)) return undefined;
  const tokens = trimmed.split(/\s+/);
  const program = programName(tokens[0]!);
  if (NEVER_GENERALIZE.has(program)) return undefined;
  // A plain word: never a flag, so `node -e …` and `python -c …` (inline code) are never generalized.
  const word = (token: string | undefined) => token !== undefined && /^[A-Za-z0-9@.][\w@./:-]*$/.test(token);
  if (!NEEDS_SUBCOMMAND.has(program)) return word(tokens[0]) ? tokens[0] : undefined;
  const sub = tokens[1];
  if (!word(sub)) return undefined;
  const subcommand = sub!.toLowerCase();
  if (program === "git" && !GIT_READ_ONLY.has(subcommand)) return undefined;
  if (PACKAGE_MANAGERS.has(program) && PACKAGE_RISKY.has(subcommand)) return undefined;
  if ((PACKAGE_MANAGERS.has(program) || program === "npx" || program === "bunx" || program === "pnpx") && RUNNER_SUBCOMMANDS.has(subcommand)) {
    return word(tokens[2]) ? tokens.slice(0, 3).join(" ") : undefined;
  }
  return tokens.slice(0, 2).join(" ");
}

/** Whether `command` is covered by a granted prefix: same leading words, and itself safe to generalize. */
export function commandMatchesPrefix(command: string, prefix: string): boolean {
  if (commandApprovalPrefix(command) === undefined) return false;
  const tokens = command.trim().split(/\s+/);
  const wanted = prefix.trim().split(/\s+/).filter(Boolean);
  return wanted.length > 0 && wanted.every((token, index) => tokens[index] === token);
}

/** Directories whose contents are configuration of the tool or the repository itself, never covered by a directory rule. */
const PROTECTED_SEGMENTS = new Set([".git", ".archymedes", ".ssh", ".aws", ".gnupg"]);

/** A workspace-relative, forward-slash path, or undefined for anything absolute or escaping. */
function relativeEditPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("~")) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return undefined;
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase()))) return undefined;
  return normalized;
}

/** The directory "always allow edits under …" would cover: the edited file's own folder, never the workspace root. */
export function editApprovalDirectory(filePath: unknown): string | undefined {
  const relative = relativeEditPath(filePath);
  if (!relative) return undefined;
  const slash = relative.lastIndexOf("/");
  return slash > 0 ? relative.slice(0, slash) : undefined;
}

/** Whether a file path lies under a granted directory, by whole path segments (`src/a` never covers `src/ab`). */
export function pathUnderDirectory(filePath: unknown, directory: string): boolean {
  const relative = relativeEditPath(filePath);
  return relative !== undefined && directory.length > 0 && relative.startsWith(`${directory}/`);
}

const EDIT_TOOLS = new Set(["edit_file", "write_file"]);

/**
 * The broader rule a human may grant for this call, if any.
 *
 * Only Archymedes's own `run_command`, `edit_file` and `write_file` qualify — a same-named tool
 * from an MCP server or a skill is a different actor, exactly as `actionDigest` treats it — and
 * only when the exact call is not itself sensitive.
 */
export function suggestApprovalPattern(call: AgentToolCall, tool: AgentTool, safety: SafetyAssessment = assessToolSafety(call, tool)): ApprovalPattern | undefined {
  if (!isBuiltIn(tool) || tool.effect !== "workspace" || safety.sensitive) return undefined;
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  if (tool.name === "run_command" && typeof args.command === "string") {
    const prefix = commandApprovalPrefix(args.command);
    return prefix ? commandPattern(prefix) : undefined;
  }
  if (EDIT_TOOLS.has(tool.name)) {
    const directory = editApprovalDirectory(args.path);
    return directory ? directoryPattern(directory) : undefined;
  }
  return undefined;
}

function commandPattern(prefix: string): ApprovalPattern {
  return { kind: "command-prefix", prefix, label: `always allow commands starting with "${prefix}"` };
}

function directoryPattern(directory: string): ApprovalPattern {
  return { kind: "directory", directory, label: `always allow edits under ${directory}/` };
}

const PREFIX_SCOPE = `${APPROVAL_POLICY_VERSION}:prefix:run_command:`;
const DIRECTORY_SCOPE = `${APPROVAL_POLICY_VERSION}:dir:edit:`;

/** The persisted key for a granted pattern — versioned like exact keys, so `restore` keeps it. */
export function approvalPatternScopeKey(pattern: ApprovalPattern): string {
  return pattern.kind === "command-prefix" ? `${PREFIX_SCOPE}${pattern.prefix}` : `${DIRECTORY_SCOPE}${pattern.directory}`;
}

function patternFromScopeKey(scope: string): ApprovalPattern | undefined {
  if (scope.startsWith(PREFIX_SCOPE)) return commandPattern(scope.slice(PREFIX_SCOPE.length));
  if (scope.startsWith(DIRECTORY_SCOPE)) return directoryPattern(scope.slice(DIRECTORY_SCOPE.length));
  return undefined;
}

export class PermissionLedger {
  private readonly standing = new Map<string, "allow" | "deny">();
  /** Old broad denials remain safe; old broad allows are intentionally not migrated. */
  private readonly legacyDeniedTools = new Set<string>();
  /** What the current turn is trying to do, in the user's own words — context for the Jev judge. */
  private taskHint = "";

  constructor(private readonly mode: ArchymedesMode, private readonly prompt: ApprovalPrompt, private readonly judge?: JevJudge) {}

  /** The turn's objective, set fresh per turn so a judge never reads a stale task. */
  setTaskHint(hint: string): void {
    this.taskHint = hint;
  }

  /** Standing decisions made so far, for display and for session persistence. */
  snapshot(): Record<string, "allow" | "deny"> {
    return Object.fromEntries(this.standing);
  }

  /**
   * Grants a pattern rule directly — for a front end that offers it outside the approval prompt.
   * Re-validated here, so a hand-built pattern cannot smuggle in a prefix `suggestApprovalPattern`
   * would never have offered.
   */
  allowPattern(pattern: ApprovalPattern): void {
    if (pattern.kind === "command-prefix" && commandApprovalPrefix(pattern.prefix) === undefined) {
      throw new Error(`Commands starting with "${pattern.prefix}" cannot be approved as a pattern`);
    }
    if (pattern.kind === "directory" && editApprovalDirectory(`${pattern.directory}/file`) !== pattern.directory) {
      throw new Error(`${pattern.directory} cannot be approved as an edit directory`);
    }
    this.standing.set(approvalPatternScopeKey(pattern), "allow");
  }

  /** Granted pattern rules, for display and for revocation. */
  patterns(): ApprovalPattern[] {
    return [...this.standing.entries()]
      .filter(([, decision]) => decision === "allow")
      .map(([scope]) => patternFromScopeKey(scope))
      .filter((pattern): pattern is ApprovalPattern => pattern !== undefined);
  }

  /** Removes a granted pattern rule; returns whether one was present. */
  revokePattern(pattern: ApprovalPattern): boolean {
    return this.standing.delete(approvalPatternScopeKey(pattern));
  }

  restore(decisions: Record<string, "allow" | "deny">): void {
    for (const [scope, decision] of Object.entries(decisions)) {
      if (scope.startsWith(`${APPROVAL_POLICY_VERSION}:`)) this.standing.set(scope, decision);
      else if (decision === "deny") this.legacyDeniedTools.add(scope);
    }
  }

  async isApproved(call: AgentToolCall, tool: AgentTool): Promise<boolean> {
    return (await this.decide(call, tool)) === "approved";
  }

  /** Rich outcome lets the runtime distinguish a real rejection from an unresolved request. */
  async decide(call: AgentToolCall, tool: AgentTool): Promise<ToolApprovalOutcome> {
    // A tool that changes nothing needs no gate; the runtime only asks about the ones that do.
    if (tool.effect === "none") return "approved";
    // Auto mode is an ergonomics feature, not a blanket trust grant. Inspect the exact command,
    // path and content before taking its fast path; credentials, production configuration and
    // high-impact commands remain explicit human decisions.
    const safety = assessToolSafety(call, tool);
    if (this.mode === "auto" && tool.effect === "workspace" && !safety.sensitive) return "approved";

    if (this.legacyDeniedTools.has(tool.name)) return "denied";
    const action = actionDigest(call, tool);
    const scopeKey = `${APPROVAL_POLICY_VERSION}:${action}`;
    const standing = this.standing.get(scopeKey);
    if (standing) return standing === "allow" ? "approved" : "denied";
    if (this.patternApproves(call, tool, safety)) return "approved";

    // The second opinion arrives with the prompt, never instead of it. Fast paths above
    // already returned, so routine auto-approved edits never pay for a judgment call —
    // only the decisions a human is about to make get annotated. Fail-open by contract:
    // no opinion means the rules and the human decide exactly as before.
    let jev: JevToolCheck | undefined;
    if (this.judge) {
      try {
        jev = await this.judge.checkTool({
          taskHint: this.taskHint,
          toolName: tool.name,
          toolDescription: tool.description,
          toolArguments: call.arguments,
        });
      } catch {
        // A judge that throws must not turn an approval into a failure; absence of an
        // opinion is a defined state, not an error path.
        jev = undefined;
      }
    }

    // Defender mode never offers a broader grant: its contract is that each change is looked at.
    const pattern = this.mode === "defender" ? undefined : suggestApprovalPattern(call, tool, safety);
    const decision = await this.prompt({
      call,
      tool,
      summary: describeToolCall(call, tool),
      actionDigest: action,
      scopeKey,
      policyVersion: APPROVAL_POLICY_VERSION,
      safety,
      ...(pattern ? { pattern } : {}),
      ...(jev ? { jev } : {}),
    });
    if (decision === "allow_always") this.standing.set(scopeKey, "allow");
    if (decision === "deny_always") this.standing.set(scopeKey, "deny");
    if (decision === "allow_pattern" && pattern) this.standing.set(approvalPatternScopeKey(pattern), "allow");
    return decision === "allow" || decision === "allow_always" || decision === "allow_pattern" ? "approved" : "denied";
  }

  /** Whether a granted pattern covers this call. Sensitive calls and non-built-in tools never match. */
  private patternApproves(call: AgentToolCall, tool: AgentTool, safety: SafetyAssessment): boolean {
    if (this.mode === "defender" || !isBuiltIn(tool) || tool.effect !== "workspace" || safety.sensitive) return false;
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    for (const pattern of this.patterns()) {
      if (pattern.kind === "command-prefix" && tool.name === "run_command" && typeof args.command === "string" && commandMatchesPrefix(args.command, pattern.prefix)) return true;
      if (pattern.kind === "directory" && EDIT_TOOLS.has(tool.name) && pathUnderDirectory(args.path, pattern.directory)) return true;
    }
    return false;
  }
}

/**
 * Where a tool came from, in words, for the human being asked to approve it — empty for Archymedes's own
 * built-in tools, which need no disclaimer.
 *
 * The digest already distinguishes provenance (see `actionDigest`), but a digest is not what anyone
 * reads before pressing `y`. Without this, an MCP server offering a tool called `deploy` renders in
 * the prompt as exactly `deploy` — indistinguishable from something Archymedes ships — and the entire
 * point of tracking provenance is to inform precisely this decision.
 */
export function describeProvenance(tool: AgentTool): string {
  const provenance = tool.provenance;
  if (!provenance || provenance.kind === "built-in") return "";
  const source = provenance.kind === "mcp" ? "MCP server" : provenance.kind;
  return ` [from ${source} "${provenance.providerId}", not built into Archymedes]`;
}

/**
 * Human-readable one-liner for an approval prompt or a transcript line.
 *
 * The single place a tool call is put into words, which is why the provenance marker belongs here:
 * every surface that asks a human to approve something — the interactive prompt, the non-TTY
 * refusal, a parked job's stored request, the daemon's forwarded one — renders `summary`, so
 * attaching it at this choke point reaches all of them and cannot be forgotten by a new one.
 */
export function describeToolCall(call: AgentToolCall, tool: AgentTool): string {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
  const origin = describeProvenance(tool);
  switch (call.name) {
    case "write_file":
      return `write ${asString(args.path) ?? "a file"}${origin}`;
    case "edit_file":
      return `edit ${asString(args.path) ?? "a file"}${origin}`;
    case "run_command": {
      const program = asString(args.command) ?? "a command";
      return `run ${program}${origin}`;
    }
    case "start_application":
      return `start ${asString(args.command) ?? "an application"} on port ${String(args.port ?? "unknown")}${origin}`;
    case "stop_application":
      return `stop application ${asString(args.id) ?? "unknown"}${origin}`;
    default:
      return `${tool.name}${args.path ? ` ${asString(args.path)}` : ""}${origin}`;
  }
}
