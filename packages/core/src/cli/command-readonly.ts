import { splitCompound } from "./command-rules";
import { tokenizeCommand } from "./command";

/**
 * Whether a shell command only reads.
 *
 * `run_command` is declared a workspace effect, because most commands are one. But the commands an
 * agent runs most often while finding its way around — `ls`, `cat`, `rg`, `git status`, `git diff`
 * — change nothing, and gating them made build mode a stream of dialogs the person approved without
 * reading, each one also forcing the batch to run one command at a time. Codex (`is_known_safe_command`)
 * and Claude Code both run such commands without asking; this is Friday's version of that list.
 *
 * Conservative by construction: a command is read-only only when every part of it is a program on
 * the list below, used with no argument that turns it into a writer or a launcher. Anything this
 * cannot account for — command substitution, an output redirect, a background `&`, an environment
 * assignment, an unbalanced quote, a program it does not know — is "not read-only", which is the
 * old behaviour: the person is asked. Being wrong in that direction costs one dialog; being wrong in
 * the other direction is a command nobody approved.
 */
export function isReadOnlyCommand(command: string, platform: NodeJS.Platform = process.platform): boolean {
  const text = command.trim();
  if (!text || hasUnsafeShellSyntax(text)) return false;
  const parts = splitCompound(stripHarmlessRedirects(text));
  if (parts.length === 0) return false;
  return parts.every((part) => {
    let tokens: string[];
    try { tokens = tokenizeCommand(part, platform); } catch { return false; }
    return readOnlyInvocation(tokens);
  });
}

/** `2>/dev/null`, `>/dev/null`, `2>&1`, `>&2`: they discard or merge output and write no file. */
function stripHarmlessRedirects(command: string): string {
  return command
    .replace(/(^|\s)\d?>{1,2}\s*\/dev\/null(?=\s|$)/g, "$1")
    .replace(/(^|\s)\d?>&\d(?=\s|$)/g, "$1");
}

/**
 * Shell syntax that runs or writes something the program list cannot see: `$(...)` and backticks
 * run a command inside the command, `>` writes a file (once the harmless redirects are gone),
 * a lone `&` starts a background process, `<(`/`>(` are process substitution. Only outside single
 * quotes, where the shell would act on them; `rg 'a>b'` is a search for the text `a>b`.
 */
function hasUnsafeShellSyntax(command: string): boolean {
  const stripped = stripHarmlessRedirects(command);
  let quote: string | null = null;
  for (let index = 0; index < stripped.length; index += 1) {
    const character = stripped[index];
    const next = stripped[index + 1];
    if (quote === "'") { if (character === "'") quote = null; continue; }
    if (character === "\\") { index += 1; continue; }
    if (character === "`" || (character === "$" && next === "(")) return true;
    if (quote === '"') { if (character === '"') quote = null; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === ">") return true;
    if ((character === "<" || character === ">") && next === "(") return true;
    if (character === "<" && next === "<") return true; // a heredoc feeds a program text it may run
    if (character === "&") {
      if (next === "&") { index += 1; continue; }
      return true;
    }
  }
  return false;
}

/** Programs that only read or print, whatever their arguments (barring the flags in `WRITER_FLAGS`). */
const READERS = new Set([
  "ls", "dir", "cat", "head", "nl", "wc", "pwd", "echo", "printf", "which", "where", "whereis", "file", "stat",
  "du", "df", "tree", "cut", "tr", "basename", "dirname", "realpath", "readlink", "grep", "egrep", "fgrep",
  "rg", "diff", "cmp", "comm", "true", "false", "date", "uname", "whoami", "id", "printenv", "hostname",
  "jq", "column", "md5sum", "sha1sum", "sha256sum", "sha512sum", "shasum", "cksum", "od", "hexdump",
  "strings", "seq", "test", "[", "type", "findstr", "uniq", "sort", "tail", "cd",
]);

/** Flags that make an otherwise reading program write, follow forever, or run something. */
const WRITER_FLAGS: Record<string, RegExp> = {
  sort: /^(-o|--output)/,
  tail: /^(-[a-zA-Z]*[fF]|--follow)/,
  rg: /^(--pre|--pre-glob)\b/,
  date: /^(-s|--set)/,
};

/** Version and help queries on toolchains, which print and exit. Not on arbitrary programs: `./x --version` runs x. */
const TOOLCHAINS = new Set([
  "node", "npm", "npx", "bun", "deno", "pnpm", "yarn", "python", "python3", "pip", "pip3", "uv", "go", "cargo",
  "rustc", "rustup", "java", "javac", "ruby", "gem", "php", "tsc", "git", "docker", "kubectl", "make", "gcc", "clang",
]);

/** git subcommands that only read the repository. Each may carry a per-subcommand check in `gitArgumentsReadOnly`. */
const GIT_READERS = new Set([
  "status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "describe",
  "remote", "tag", "shortlog", "cat-file", "merge-base", "config", "stash", "reflog", "whatchanged",
  "for-each-ref", "name-rev", "count-objects", "worktree", "rev-list", "show-ref", "check-ignore", "help", "version",
]);

function readOnlyInvocation(tokens: readonly string[]): boolean {
  const [program, ...args] = tokens;
  if (!program || /^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) return false; // `FOO=1 cmd` changes what cmd does
  const name = program.toLowerCase();
  if (TOOLCHAINS.has(name) && args.length === 1 && /^(--version|-v|-V|version|--help|-h)$/.test(args[0])) return true;
  if (name === "git") return gitReadOnly(args);
  if (name === "find") return findReadOnly(args);
  if (name === "sed") return sedReadOnly(args);
  if (name === "env" || name === "printenv") return name === "printenv" || args.length === 0;
  if (name === "command") return args[0] === "-v" || args[0] === "-V";
  if (!READERS.has(name)) return false;
  const writer = WRITER_FLAGS[name];
  // `uniq in out` writes `out`; `hostname name` renames the machine. One positional or none only reads.
  if (name === "uniq") return args.filter((arg) => !arg.startsWith("-")).length <= 1;
  if (name === "hostname") return args.every((arg) => arg.startsWith("-") && !/^(-F|--file|-b|--boot)/.test(arg));
  return !writer || !args.some((arg) => writer.test(arg));
}

/** `find` without the actions that delete, run or write. */
function findReadOnly(args: readonly string[]): boolean {
  return !args.some((arg) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg));
}

/** `sed -n '1,80p' file`: printing lines, the way agents page through files. Never `-i`, never a `w` or `e` command. */
function sedReadOnly(args: readonly string[]): boolean {
  if (args.some((arg) => /^(-i|--in-place|-[a-zA-Z]*i)/.test(arg))) return false;
  if (!args.includes("-n")) return false;
  const script = args.find((arg) => !arg.startsWith("-"));
  return script !== undefined && /^[\d,$\s;p]+$/.test(script);
}

function gitReadOnly(args: readonly string[]): boolean {
  let index = 0;
  // Global options before the subcommand. `-c` is refused: `-c diff.external=…` runs a program.
  while (index < args.length && args[index].startsWith("-")) {
    const option = args[index];
    if (option === "-C") { index += 2; continue; }
    if (option === "--no-pager" || option === "--no-optional-locks" || option === "-P") { index += 1; continue; }
    return false;
  }
  const subcommand = args[index];
  if (!subcommand || !GIT_READERS.has(subcommand)) return false;
  const rest = args.slice(index + 1);
  // Writing to a file, or handing output to a program, from any reading subcommand.
  if (rest.some((arg) => /^(--output|--ext-diff|--textconv|--exec|-o$)/.test(arg))) return false;
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  switch (subcommand) {
    // Listing only: a name creates a branch or tag, and these flags rename, delete or move.
    case "branch":
      return positional.length === 0 && !rest.some((arg) => /^(-[dDmMcC]|--delete|--move|--copy|--set-upstream|--unset-upstream|--edit-description|-u$|--track|-f$|--force)/.test(arg));
    case "tag":
      return (positional.length === 0 || rest.some((arg) => arg === "-l" || arg === "--list")) && !rest.some((arg) => /^(-[dafsmFu]$|--delete|--annotate|--sign|--force|--message|--file)/.test(arg));
    case "remote":
      return positional.length === 0 || ["show", "get-url"].includes(positional[0]);
    case "config":
      return rest.some((arg) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(arg)) && !rest.some((arg) => /^(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit|-e)$/.test(arg));
    case "stash":
      return positional[0] === "list" || positional[0] === "show";
    case "reflog":
      return positional.length === 0 || positional[0] === "show";
    case "worktree":
      return positional[0] === "list";
    default:
      return true;
  }
}
