import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient } from "../lsp/client";
import { severityName } from "../lsp/diagnostics";
import type { LspDiagnostic } from "../lsp/protocol";
import { commandAvailable, languageIdForFile, serverForFilename, LANGUAGE_SERVERS, type CommandProbe, type LspServerDefinition } from "../lsp/servers";

/**
 * Language-server diagnostics for one file the agent just edited, so the model sees the error it
 * introduced in the same tool result instead of discovering it three steps later.
 *
 * Deliberately narrower than `/diagnostics` (`lsp/collect.ts`): no workspace walk, one server per
 * language, one file per check, and a short deadline. Anything that goes wrong — no server claims
 * the extension, the server is not installed, it is still starting, it crashes — yields
 * `undefined`, and the edit's result is returned unchanged. This is a hint for the model, never a
 * gate on the edit.
 *
 * One server per language is started lazily on the first edit and kept warm for the session: a
 * cold `tsserver` routinely needs longer than any deadline worth imposing on an edit, so starting a
 * fresh one per edit (the original design) meant most edits waited the full deadline for nothing.
 * Now the first edit may time out silently while the server warms in the background, and every
 * later edit is a `didChange` against a server that already has the project loaded. The servers
 * are shut down — whole process tree — by `close()`, after an idle period, or at process exit.
 */

export type EditDiagnosticsOptions = {
  /** Deadline for one check against a warm server. Default 1500ms. */
  timeoutMs?: number;
  /**
   * Deadline for a check that has to start the server first. Defaults to `timeoutMs`. Running
   * out is silent: the server keeps starting, and the next edit finds it warm.
   */
  startupTimeoutMs?: number;
  /** After the first publish for this version, how long to wait for a refined one. Default 250ms. */
  refineMs?: number;
  /** Command availability probe; injectable so tests need no real servers on PATH. */
  probe?: CommandProbe;
  /** The server table; defaults to the built-in one. */
  servers?: readonly LspServerDefinition[];
  /** Most diagnostic lines returned. Default 20. */
  maxLines?: number;
  /** Shut the servers down after this long without an edit. Default 10 minutes. */
  idleShutdownMs?: number;
};

export type EditDiagnostics = (filePath: string) => Promise<string | undefined>;

/** The hook plus the means to stop the language servers it keeps warm. */
export type LspEditDiagnostics = EditDiagnostics & {
  /** Stops every server this hook started (process tree included). Idempotent; a later edit restarts lazily. */
  close(): void;
  /** Process ids of the servers currently running, for diagnostics and tests. */
  serverPids(): number[];
};

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_REFINE_MS = 250;
const DEFAULT_MAX_LINES = 20;
const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60_000;
/** A server that keeps dying is not restarted forever — each restart is a cold start the edit pays for. */
const MAX_STARTS_PER_SERVER = 3;
/** Only the handshake is a request; a cold server indexing a large project may need a while. */
const INITIALIZE_TIMEOUT_MS = 120_000;

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

type Publication = { seq: number; version?: number; diagnostics: readonly LspDiagnostic[] };

type ServerSession = {
  client: LspClient;
  ready: Promise<boolean>;
  isReady: boolean;
  /** Open documents by normalized path, with the last version sent. */
  documents: Map<string, { uri: string; version: number }>;
  /** Latest publication per normalized path. Servers may normalize URIs, so matching is by path. */
  publications: Map<string, Publication>;
  seq: number;
  waiters: Set<() => void>;
};

/** Every live client across all hooks, so a process exit can reap them synchronously. */
const liveClients = new Set<LspClient>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const client of liveClients) client.close({ sync: true });
    liveClients.clear();
  });
}

/**
 * Builds the `afterEdit` hook `ArchymedesAgent` accepts, for a workspace on this machine.
 *
 * Errors and warnings only, at most `maxLines` lines, each `path:line:col severity message`.
 * Returns `undefined` for a clean file as well as for an unavailable server: "no news" costs the
 * model nothing to read.
 */
export function createLspEditDiagnostics(root: string, options: EditDiagnosticsOptions = {}): LspEditDiagnostics {
  const workspaceRoot = path.resolve(root);
  const servers = options.servers ?? LANGUAGE_SERVERS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? timeoutMs;
  const refineMs = options.refineMs ?? DEFAULT_REFINE_MS;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  // `which`/`where` is a process launch; the answer cannot change mid-session.
  const installed = new Map<string, Promise<boolean>>();
  const sessions = new Map<string, ServerSession>();
  const starts = new Map<string, number>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const stopSession = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    liveClients.delete(session.client);
    session.client.close();
    for (const wake of session.waiters) wake();
  };
  const closeAll = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    for (const id of [...sessions.keys()]) stopSession(id);
  };
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(closeAll, idleShutdownMs);
    idleTimer.unref?.();
  };

  const startSession = (definition: LspServerDefinition): ServerSession | undefined => {
    const count = starts.get(definition.id) ?? 0;
    if (count >= MAX_STARTS_PER_SERVER) return undefined;
    starts.set(definition.id, count + 1);
    let client: LspClient;
    try {
      client = new LspClient({
        command: definition.command,
        args: [...definition.args],
        requestTimeoutMs: INITIALIZE_TIMEOUT_MS,
        rootUri: pathToFileURL(workspaceRoot).href,
        workspaceRoot,
        // Servers installed through npm are `.cmd` shims on Windows, which only a shell can start.
        shell: process.platform === "win32" && !path.isAbsolute(definition.command),
        // A warm server must not keep the CLI alive after its work is done.
        unref: true,
      });
    } catch {
      return undefined;
    }
    installExitHook();
    liveClients.add(client);
    const session: ServerSession = {
      client,
      ready: Promise.resolve(false),
      isReady: false,
      documents: new Map(),
      publications: new Map(),
      seq: 0,
      waiters: new Set(),
    };
    client.onPublishDiagnostics((params) => {
      let key: string;
      try { key = normalizePath(fileURLToPath(params.uri)); } catch { return; }
      session.seq += 1;
      session.publications.set(key, { seq: session.seq, ...(params.version !== undefined ? { version: params.version } : {}), diagnostics: params.diagnostics });
      for (const wake of [...session.waiters]) wake();
    });
    session.ready = client.initialize().then(
      () => { session.isReady = true; return true; },
      () => { if (sessions.get(definition.id) === session) stopSession(definition.id); return false; },
    );
    sessions.set(definition.id, session);
    return session;
  };

  /** Resolves when `predicate` holds or `deadline` passes; true when it held. */
  const waitFor = async (session: ServerSession, predicate: () => boolean, deadline: number): Promise<boolean> => {
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || session.client.closed) return predicate();
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); session.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, remaining);
        session.waiters.add(wake);
      });
    }
    return true;
  };

  const diagnose = async (filePath: string): Promise<string | undefined> => {
    const started = Date.now();
    const absolute = path.resolve(workspaceRoot, filePath);
    const relative = path.relative(workspaceRoot, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    const display = relative.split(path.sep).join("/");
    const definition = serverForFilename(display, servers);
    if (!definition) return undefined;
    let available = installed.get(definition.command);
    if (!available) {
      available = commandAvailable(definition.command, options.probe);
      installed.set(definition.command, available);
    }
    if (!(await available)) return undefined;
    const content = await fs.readFile(absolute, "utf8").catch(() => undefined);
    if (content === undefined) return undefined;
    touch();

    let session = sessions.get(definition.id);
    if (session?.client.closed) {
      stopSession(definition.id);
      session = undefined;
    }
    session ??= startSession(definition);
    if (!session) return undefined;
    const deadline = started + (session.isReady ? timeoutMs : startupTimeoutMs);
    const ready = await Promise.race([session.ready, delay(deadline - Date.now()).then(() => false)]);
    // Not ready in time: say nothing now. The handshake keeps going, so the next edit is warm.
    if (!ready || session.client.closed) return undefined;

    const key = normalizePath(absolute);
    const seqBefore = session.seq;
    let version: number;
    try {
      const open = session.documents.get(key);
      if (open) {
        version = open.version + 1;
        open.version = version;
        session.client.didChange(open.uri, version, content);
      } else {
        version = 1;
        const uri = pathToFileURL(absolute).href;
        session.documents.set(key, { uri, version });
        session.client.didOpen(uri, languageIdForFile(display, definition), content, version);
      }
    } catch {
      stopSession(definition.id);
      return undefined;
    }

    // A publication for this file that came after the change was sent, and — when the server
    // tags publications with a version — for this version, not one still in flight from before.
    const current = () => {
      const publication = session!.publications.get(key);
      if (!publication || publication.seq <= seqBefore) return undefined;
      if (publication.version !== undefined && publication.version < version) return undefined;
      return publication;
    };
    if (!(await waitFor(session, () => current() !== undefined, deadline))) return undefined;
    // Many servers publish fast syntactic results first and semantic ones a moment later.
    const first = current()!.seq;
    await waitFor(session, () => (current()?.seq ?? first) > first, Math.min(deadline, Date.now() + refineMs));
    const diagnostics = (current()?.diagnostics ?? [])
      .filter((diagnostic) => {
        const severity = severityName(diagnostic.severity);
        return severity === "error" || severity === "warning";
      })
      .sort((left, right) => (left.severity ?? 1) - (right.severity ?? 1) || left.range.start.line - right.range.start.line);
    if (diagnostics.length === 0) return undefined;
    const lines = diagnostics.slice(0, maxLines).map((diagnostic) => {
      const message = diagnostic.message.split(/\r?\n/, 1)[0]!.slice(0, 300);
      const source = diagnostic.source ? ` (${diagnostic.source})` : "";
      return `${display}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${severityName(diagnostic.severity)} ${message}${source}`;
    });
    if (diagnostics.length > maxLines) lines.push(`… ${diagnostics.length - maxLines} more`);
    return lines.join("\n");
  };

  return Object.assign(
    (filePath: string) => diagnose(filePath).catch(() => undefined),
    {
      close: closeAll,
      serverPids: () => [...sessions.values()].flatMap(({ client }) => client.pid !== undefined && !client.closed ? [client.pid] : []),
    },
  );
}
