/**
 * Tool names models call out of habit, mapped onto the tools Archymedes actually has.
 *
 * Every model was trained against someone else's tool set, and under pressure it reaches for that
 * one: gpt-oss calls `container.exec` and `browser.search` (its built-in tools), models trained on
 * Claude Code transcripts call `Bash`, `Read` and `Edit`, Gemini prefixes `default_api.`, and
 * several open models emit `functions.read_file`. Each of those has exactly one meaning here, so
 * translating it costs nothing. Rejecting it costs a round trip, and two in a row stops the run.
 *
 * Only unambiguous translations are listed. A name that could mean two tools, or arguments that
 * do not carry what our tool needs (an `apply_patch` diff for `edit_file`), are left alone: the
 * runtime then tells the model which tools exist, which is the honest answer.
 *
 * `bun run test:live --census` asks real models to do ordinary work and lists every tool name they
 * call that is not one of ours, aliased or not, so this table grows from observation.
 */
import type { AgentToolCall } from "./agent-runtime";

type Args = Record<string, unknown>;
type Alias = { tool: string; args?: (args: Args) => Args | undefined };

/** The first present string among `keys`, so `file_path`, `filePath` and `path` all land on `path`. */
function pick(args: Args, keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof args[key] === "string" && args[key] !== "") return args[key] as string;
  return undefined;
}

/** Builds an argument object, dropping keys with no value, and refuses when a required one is missing. */
function shaped(required: Record<string, string | undefined>, optional: Record<string, unknown> = {}): Args | undefined {
  if (Object.values(required).some((value) => value === undefined)) return undefined;
  return { ...required, ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)) };
}

const PATH = ["path", "file_path", "filePath", "file", "filename", "target_file", "absolute_path", "relative_path"];
const DIRECTORY = ["path", "dir", "directory", "dir_path", "relative_workspace_path", "target_directory"];
const CONTENT = ["content", "contents", "file_text", "text", "code", "data"];
const OLD = ["oldText", "old_str", "old_string", "old", "search", "find", "original"];
const NEW = ["newText", "new_str", "new_string", "new", "replace", "replacement", "updated"];
const QUERY = ["query", "pattern", "regex", "search", "q", "term", "keyword"];

/** A command as a string: gpt-oss's `container.exec` sends `cmd` as an argv array, often `["bash", "-lc", "..."]`. */
function commandOf(args: Args): string | undefined {
  const raw = args.command ?? args.cmd ?? args.script ?? args.input ?? args.code;
  if (typeof raw === "string") return raw || undefined;
  if (Array.isArray(raw) && raw.every((part) => typeof part === "string") && raw.length > 0) {
    const argv = raw as string[];
    if (argv.length === 3 && /^(ba|z)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1])) return argv[2];
    return argv.map((part) => (/^[\w./=:@%+-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`)).join(" ");
  }
  return undefined;
}

const runCommand: Alias = { tool: "run_command", args: (args) => shaped({ command: commandOf(args) }) };
const readFile: Alias = {
  tool: "read_file",
  args: (args) => {
    const offset = typeof args.offset === "number" ? args.offset : typeof args.start_line === "number" ? args.start_line : undefined;
    return shaped({ path: pick(args, PATH) }, { offset, limit: typeof args.limit === "number" ? args.limit : undefined });
  },
};
const listFiles: Alias = { tool: "list_files", args: (args) => ({ path: pick(args, DIRECTORY) ?? "." }) };
const globFiles: Alias = { tool: "glob_files", args: (args) => shaped({ pattern: pick(args, ["pattern", "glob", "query", "name"]) }, { path: pick(args, DIRECTORY) }) };
const grepFiles: Alias = {
  tool: "grep_files",
  args: (args) => shaped({ query: pick(args, QUERY) }, { include: pick(args, ["include", "glob", "include_pattern", "file_pattern"]) }),
};
const writeFile: Alias = { tool: "write_file", args: (args) => shaped({ path: pick(args, PATH), content: pick(args, CONTENT) ?? (typeof args.content === "string" ? "" : undefined) }) };
const editFile: Alias = {
  tool: "edit_file",
  args: (args) => shaped({ path: pick(args, PATH), oldText: pick(args, OLD), newText: pick(args, NEW) ?? (NEW.some((key) => args[key] === "") ? "" : undefined) },
    { replaceAll: typeof args.replace_all === "boolean" ? args.replace_all : typeof args.replaceAll === "boolean" ? args.replaceAll : undefined }),
};
const webSearch: Alias = { tool: "web_search", args: (args) => shaped({ query: pick(args, ["query", "q", "search_query", "term"]) }) };
const webFetch: Alias = { tool: "web_fetch", args: (args) => shaped({ url: pick(args, ["url", "uri", "link", "href", "id"]) }) };

/**
 * Anthropic's text editor tool: one name, the operation in `command`. Each command is one of ours.
 */
const textEditor = (args: Args): { tool: string; args: Args } | undefined => {
  const command = args.command;
  const as = (alias: Alias) => { const mapped = alias.args!(args); return mapped ? { tool: alias.tool, args: mapped } : undefined; };
  if (command === "view") return as(readFile);
  if (command === "create") return as(writeFile);
  if (command === "str_replace") return as(editFile);
  return undefined;
};

/** Keyed by the normalized name: lower case, separators as underscores, namespace prefix removed. */
const ALIASES: Record<string, Alias> = {
  // Shell.
  bash: runCommand, shell: runCommand, sh: runCommand, exec: runCommand, execute: runCommand, terminal: runCommand,
  run: runCommand, run_shell: runCommand, run_shell_command: runCommand, shell_command: runCommand, execute_command: runCommand,
  execute_bash: runCommand, run_terminal_cmd: runCommand, run_terminal_command: runCommand, run_in_terminal: runCommand, command: runCommand,
  // Reading.
  read: readFile, cat: readFile, view: readFile, view_file: readFile, open_file: readFile, read_text_file: readFile,
  get_file: readFile, get_file_contents: readFile, file_read: readFile, readfile: readFile, read_file_content: readFile,
  // Listing.
  ls: listFiles, list: listFiles, list_dir: listFiles, list_directory: listFiles, listdir: listFiles, print_tree: listFiles, tree: listFiles,
  // Finding files by name.
  glob: globFiles, find: globFiles, find_files: globFiles, file_search: globFiles, find_file: globFiles, search_files_by_name: globFiles,
  // Searching contents.
  grep: grepFiles, rg: grepFiles, ripgrep: grepFiles, search: grepFiles, search_files: grepFiles, grep_search: grepFiles,
  search_code: grepFiles, code_search: grepFiles, search_in_files: grepFiles,
  // Writing.
  write: writeFile, create_file: writeFile, write_to_file: writeFile, save_file: writeFile, file_write: writeFile, create: writeFile,
  // Editing.
  edit: editFile, str_replace: editFile, replace: editFile, replace_in_file: editFile, search_replace: editFile,
  search_and_replace: editFile, apply_edit: editFile, edit_text_file: editFile, modify_file: editFile,
  // The web.
  search_web: webSearch, google_search: webSearch, internet_search: webSearch, web_search_preview: webSearch,
  fetch: webFetch, fetch_url: webFetch, open_url: webFetch, browse: webFetch, url_fetch: webFetch, http_get: webFetch,
};

/** Namespaced names whose namespace changes the meaning, so they are matched before the prefix is stripped. */
const QUALIFIED: Record<string, Alias> = {
  "container.exec": runCommand,
  "browser.search": webSearch,
  "browser.open": webFetch,
  "browser.find": grepFiles,
  "repo_browser.open_file": readFile,
  "repo_browser.print_tree": listFiles,
  "repo_browser.search": grepFiles,
};

/** Prefixes models put in front of a tool name that carry no meaning of their own. */
const NAMESPACES = /^(functions|function|default_api|tools|tool|api|repo_browser|mcp)[.:/]/i;

/** `ReadFile`, `read-file`, `read file` and `READ_FILE` all become `read_file`. */
export function normalizeToolName(name: string): string {
  return name.trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

export type ToolNameResolution =
  /** Already one of ours. */
  | { kind: "exact" }
  /** A known habit, translated; `call` carries our name and our argument names. */
  | { kind: "alias"; call: AgentToolCall }
  /** Not a tool we can map. The runtime corrects the model. */
  | { kind: "unknown" };

/**
 * What a requested tool call means here.
 *
 * `available` is the set of tool names this run may call, so an alias never resolves to a tool
 * the current mode does not include: that stays the runtime's "not allowed in this run" answer.
 */
export function resolveToolCall(call: AgentToolCall, available: ReadonlySet<string>): ToolNameResolution {
  if (available.has(call.name)) return { kind: "exact" };
  const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments as Args : undefined;
  const translate = (tool: string, mapped: Args | undefined): ToolNameResolution =>
    available.has(tool) ? { kind: "alias", call: { ...call, name: tool, arguments: mapped ?? args ?? {} } } : { kind: "unknown" };

  // Our own name behind a prefix or in another case: arguments are already ours.
  const bare = normalizeToolName(call.name.replace(NAMESPACES, ""));
  if (available.has(bare)) return translate(bare, args);

  const qualified = QUALIFIED[call.name.trim().toLowerCase()];
  const alias = qualified ?? ALIASES[bare];
  if (bare === "str_replace_based_edit_tool" || bare === "str_replace_editor" || bare === "text_editor") {
    const mapped = args ? textEditor(args) : undefined;
    return mapped ? translate(mapped.tool, mapped.args) : { kind: "unknown" };
  }
  if (!alias) return { kind: "unknown" };
  if (!alias.args) return translate(alias.tool, args);
  if (!args) return { kind: "unknown" };
  const mapped = alias.args(args);
  return mapped ? translate(alias.tool, mapped) : { kind: "unknown" };
}

/**
 * The tool a habitual name stands for here, whatever its arguments: `Read` is `read_file`. For the
 * message when a call's arguments did not carry what that tool needs, so the model is told what to
 * send rather than that the tool does not exist (it does, by another name), and its next call is
 * right instead of the same habit again.
 */
export function aliasTarget(name: string, available: ReadonlySet<string>): string | undefined {
  const bare = normalizeToolName(name.replace(NAMESPACES, ""));
  if (bare === "str_replace_based_edit_tool" || bare === "str_replace_editor" || bare === "text_editor") return undefined; // one name, three tools
  const tool = (QUALIFIED[name.trim().toLowerCase()] ?? ALIASES[bare])?.tool;
  return tool && available.has(tool) ? tool : undefined;
}
