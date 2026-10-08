/**
 * The language servers Archymedes knows how to start, and how to find the one a file needs.
 *
 * A workspace is usually several languages at once — TypeScript calling a Python script, a
 * Rust binary beside its Cargo.toml — and each language has its own server with its own
 * command. This table is the mapping from "a file with this extension" to "run this command
 * over stdio". It is a table rather than a plugin system because the value is in the mapping
 * being readable: a developer wondering why their `.ts` file gets no diagnostics should be
 * able to read the answer in ten lines, not trace a discovery mechanism.
 *
 * Every entry is a server that speaks LSP over stdio, which is the transport `LspClient`
 * implements. Servers that only speak an RPC of their own do not belong here.
 */

import { spawnSync } from "node:child_process";

export type LspServerDefinition = {
  /** Provenance id, e.g. `typescript` — what a diagnostic line names as its source. */
  id: string;
  /** Executable on PATH; probed before spawn so a missing server is a message, not a crash. */
  command: string;
  /** Arguments that select stdio mode. Empty for servers that default to it. */
  args: readonly string[];
  /** File extensions this server handles, with the dot, lowercase. */
  extensions: readonly string[];
  /** Whole filenames this server owns, for extensionless files like Dockerfile. */
  filenames?: readonly string[];
  /** LSP language ids, used for `didOpen` when the extension is ambiguous. */
  languageIds: readonly string[];
};

export const LANGUAGE_SERVERS: readonly LspServerDefinition[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
  },
  {
    id: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    languageIds: ["python"],
  },
  {
    id: "pylsp",
    command: "pylsp",
    args: [],
    extensions: [".py", ".pyi"],
    languageIds: ["python"],
  },
  {
    id: "rust",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    languageIds: ["rust"],
  },
  {
    id: "go",
    command: "gopls",
    args: [],
    extensions: [".go"],
    languageIds: ["go"],
  },
  {
    id: "lua",
    command: "lua-language-server",
    args: [],
    extensions: [".lua"],
    languageIds: ["lua"],
  },
  {
    id: "json",
    command: "vscode-json-languageserver",
    args: ["--stdio"],
    extensions: [".json", ".jsonc"],
    languageIds: ["json", "jsonc"],
  },
  {
    id: "html",
    command: "vscode-html-languageserver",
    args: ["--stdio"],
    extensions: [".html", ".htm", ".xhtml"],
    languageIds: ["html"],
  },
  {
    id: "css",
    command: "vscode-css-languageserver",
    args: ["--stdio"],
    extensions: [".css", ".scss", ".less"],
    languageIds: ["css", "scss", "less"],
  },
  {
    id: "yaml",
    command: "yaml-language-server",
    args: ["--stdio"],
    extensions: [".yaml", ".yml"],
    languageIds: ["yaml"],
  },
  {
    id: "docker",
    command: "docker-langserver",
    args: ["--stdio"],
    extensions: [],
    filenames: ["dockerfile", "containerfile"],
    languageIds: ["dockerfile"],
  },
  {
    id: "csharp",
    command: "omnisharp",
    args: ["--languageserver"],
    extensions: [".cs"],
    languageIds: ["csharp"],
  },
  {
    id: "bash",
    command: "bash-language-server",
    args: ["start"],
    extensions: [".sh", ".bash"],
    languageIds: ["shellscript"],
  },
  {
    id: "markdown",
    command: "marksman",
    args: [],
    extensions: [".md", ".markdown"],
    languageIds: ["markdown"],
  },
];

/** The server for a file extension (`.ts`), or undefined when no known server claims it. */
export function serverForExtension(extension: string): LspServerDefinition | undefined {
  const normalized = extension.toLowerCase();
  return LANGUAGE_SERVERS.find((server) => server.extensions.includes(normalized));
}

/**
 * The server for a file, by its whole name first (`Dockerfile` has no extension to match on) and
 * by its extension otherwise. Accepts a path; only the last segment is considered.
 */
export function serverForFilename(filename: string, servers: readonly LspServerDefinition[] = LANGUAGE_SERVERS): LspServerDefinition | undefined {
  const base = filename.split(/[\\/]/).pop()!.toLowerCase();
  const dot = base.lastIndexOf(".");
  return servers.find((server) => server.filenames?.includes(base))
    ?? (dot > 0 ? servers.find((server) => server.extensions.includes(base.slice(dot))) : undefined);
}

const LANGUAGE_ID_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
  ".jsonc": "jsonc", ".scss": "scss", ".less": "less",
};

/** The LSP language id to open a file as: its own where the server handles several, else the server's first. */
export function languageIdForFile(filename: string, server: LspServerDefinition): string {
  const dot = filename.lastIndexOf(".");
  const extension = dot === -1 ? "" : filename.slice(dot).toLowerCase();
  return LANGUAGE_ID_BY_EXTENSION[extension] ?? server.languageIds[0] ?? "plaintext";
}

/** The server for an LSP language id, for callers that know the language and not the file. */
export function serverForLanguageId(languageId: string): LspServerDefinition | undefined {
  return LANGUAGE_SERVERS.find((server) => server.languageIds.includes(languageId));
}

export type CommandProbe = (command: string) => Promise<boolean>;

/**
 * Whether an executable is on PATH.
 *
 * `where` on Windows, `which` everywhere else — the two platforms' own answers to "is this
 * program installed", rather than a hand-rolled PATH walk that would have to agree with both
 * shells' rules for what counts as found. Injected as a type so tests can answer it without
 * touching the machine's PATH.
 */
export async function commandAvailable(command: string, probe: CommandProbe = defaultProbe): Promise<boolean> {
  try {
    return await probe(command);
  } catch {
    // A probe that itself fails is treated as "not available" rather than propagated: the
    // question being answered is "can this server run", and a locator that cannot run means
    // it cannot.
    return false;
  }
}

function defaultProbe(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const locator = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(locator, [command], { stdio: "ignore", windowsHide: true });
    resolve(result.status === 0);
  });
}

/**
 * Every known server whose command is on PATH, in table order.
 *
 * Probed serially: fourteen `which` calls are milliseconds, and a parallel burst of spawns to
 * answer a question with a known-small answer is complexity bought for nothing.
 */
export async function discoverAvailableServers(probe: CommandProbe = defaultProbe): Promise<LspServerDefinition[]> {
  const available: LspServerDefinition[] = [];
  for (const server of LANGUAGE_SERVERS) {
    if (await commandAvailable(server.command, probe)) available.push(server);
  }
  return available;
}
