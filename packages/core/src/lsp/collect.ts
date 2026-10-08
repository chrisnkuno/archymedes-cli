/**
 * Collecting diagnostics for a whole workspace: which servers to start, what to open, and how
 * long to wait.
 *
 * The flow a `/diagnostics` needs and a single request cannot have: walk the tree, group the
 * files by the server that claims each extension, start each server that is installed, open
 * its files, then wait. The wait is the part that looks like a hack and is not — a server
 * publishes diagnostics when its own analysis finishes, which is a race the client cannot
 * observe, so the only honest way to answer "what does this workspace's code look like to
 * its language server" is to open everything and give the servers a moment to answer.
 *
 * Every failure is per-server and returned, not thrown: one server that refuses to start (not
 * installed, crashes on handshake, times out) must not cost the user the diagnostics of the
 * three servers that worked. The caller decides what to do with a server that reported
 * nothing — usually to say so, since silence and failure look identical otherwise.
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient, type LspServerConfig } from "./client";
import { severityName, type DiagnosticCounts } from "./diagnostics";
import { commandAvailable, languageIdForFile, serverForFilename, LANGUAGE_SERVERS, type CommandProbe, type LspServerDefinition } from "./servers";
import { globToRegExp, readTextFile, walkWorkspace, DEFAULT_WORKSPACE_LIMITS, type WorkspaceLimits } from "../cli/workspace";
import type { LspDiagnostic } from "./protocol";

export type CollectOptions = {
  /**
   * How long to wait for servers to publish after the last didOpen.
   *
   * A server publishes diagnostics when its own analysis finishes, which is a race the
   * client cannot observe. The default (2500ms) is a compromise: long enough for most
   * servers to finish, short enough that a `/diagnostics` command feels responsive.
   * A caller that needs faster results can lower it at the cost of potentially missing
   * diagnostics from slower servers.
   */
  settleMs?: number;
  /** Per-server request timeout, forwarded to the client. Default 15000ms. */
  requestTimeoutMs?: number;
  /** Command availability probe; injectable so tests need no real servers on PATH. */
  probe?: CommandProbe;
  /** Glob filter for which files to include, e.g. `src/**`. */
  include?: string;
  /** Maximum files to open per server. Default 100. */
  maxFilesPerServer?: number;
  /** Workspace walk limits, forwarded to the reader. */
  limits?: WorkspaceLimits;
  /** The server table to match files against. Defaults to the built-in one; tests supply their own. */
  servers?: readonly LspServerDefinition[];
};

export type ServerDiagnostics = {
  server: LspServerDefinition;
  ok: boolean;
  /** Why the server could not be used, when `ok` is false. */
  error?: string;
  files: Array<{ path: string; diagnostics: readonly LspDiagnostic[] }>;
};

export type WorkspaceDiagnostics = {
  servers: ServerDiagnostics[];
  /** Every file with at least one diagnostic, sorted by path, across all servers. */
  files: Array<{ path: string; diagnostics: readonly LspDiagnostic[] }>;
  counts: DiagnosticCounts;
};

const DEFAULT_SETTLE_MS = 2_500;
const DEFAULT_MAX_FILES_PER_SERVER = 100;
const MAX_FILES_TOTAL = 500;

export async function collectWorkspaceDiagnostics(root: string, options: CollectOptions = {}): Promise<WorkspaceDiagnostics> {
  const limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS;
  const include = options.include ? globToRegExp(options.include) : null;

  // One walk, grouped by the server that claims each file. A file no known server claims
  // (the majority of files in most repos — lockfiles, generated output) is skipped here
  // rather than opened into a server that would ignore it.
  const byServer = new Map<LspServerDefinition, string[]>();
  let seen = 0;
  for await (const entry of walkWorkspace(root, limits)) {
    if (entry.isDirectory) continue;
    if (seen >= MAX_FILES_TOTAL) break;
    if (include && !include.test(entry.relative)) continue;
    const definition = serverForFilename(entry.relative, options.servers ?? LANGUAGE_SERVERS);
    if (!definition) continue;
    const files = byServer.get(definition) ?? [];
    files.push(entry.relative);
    byServer.set(definition, files);
    seen += 1;
  }

  const servers: ServerDiagnostics[] = [];
  for (const [definition, files] of byServer) {
    if (!(await commandAvailable(definition.command, options.probe))) {
      servers.push({ server: definition, ok: false, error: `${definition.command} is not installed`, files: [] });
      continue;
    }
    servers.push(await collectFromServer(root, definition, files.slice(0, options.maxFilesPerServer ?? DEFAULT_MAX_FILES_PER_SERVER), options));
  }

  const files: WorkspaceDiagnostics["files"] = [];
  const counts: DiagnosticCounts = { error: 0, warning: 0, information: 0, hint: 0, total: 0 };
  for (const result of servers) {
    for (const file of result.files) {
      files.push(file);
      for (const diagnostic of file.diagnostics) {
        counts[severityName(diagnostic.severity)] += 1;
        counts.total += 1;
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { servers, files, counts };
}

async function collectFromServer(
  root: string,
  definition: LspServerDefinition,
  files: readonly string[],
  options: CollectOptions,
): Promise<ServerDiagnostics> {
  const workspaceRoot = path.resolve(root);
  const config: LspServerConfig & { rootUri: string; workspaceRoot: string } = {
    command: definition.command,
    args: [...definition.args],
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    rootUri: pathToFileURL(workspaceRoot).href,
    workspaceRoot,
    // Servers installed through npm are `.cmd` shims on Windows, which only a shell can start.
    shell: process.platform === "win32" && !path.isAbsolute(definition.command),
  };
  const client = new LspClient(config);
  try {
    await client.initialize();
    for (const file of files) {
      const read = await readTextFile(root, file, { limits: options.limits }).catch(() => null);
      if (!read) continue;
      client.didOpen(pathToFileURL(path.resolve(workspaceRoot, file)).href, languageIdForFile(file, definition), read.content);
    }
    await delay(options.settleMs ?? DEFAULT_SETTLE_MS);
    const collected = client.diagnostics.all().map(({ uri, diagnostics }) => ({
      // Workspace-relative with forward slashes: what a person reads, and the same on every platform.
      path: path.relative(workspaceRoot, fileURLToPath(uri)).split(path.sep).join("/"),
      diagnostics,
    }));
    return { server: definition, ok: true, files: collected };
  } catch (error) {
    return { server: definition, ok: false, error: error instanceof Error ? error.message : String(error), files: [] };
  } finally {
    client.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
