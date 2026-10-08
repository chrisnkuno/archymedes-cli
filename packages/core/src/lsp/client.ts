/**
 * A Language Server Protocol client over stdio: spawn, handshake, requests, diagnostics.
 *
 * The same shape as `McpConnection` — a spawned child, a request id table, a timeout per
 * request — with two differences that are LSP's own. The framing is `Content-Length` headers
 * rather than one JSON object per line (see `protocol.ts`), and the interesting traffic flows
 * the other way: diagnostics are *pushed* by the server as notifications, so the client is
 * as much a collector as it is a requester. `hover` and `definition` are ordinary
 * request/response; the diagnostics land whether or not anyone asked.
 *
 * The server is spawned in the constructor, like `McpConnection`, so a caller holding an
 * `LspClient` always holds a live process and must `close()` it. Every failure mode — spawn
 * error, exit, timeout, malformed message — rejects the pending requests and records a
 * `closedError`, so a caller that ignores the result of one call cannot be bitten by a
 * half-dead connection later.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { sanitizeCommandEnvironment } from "../cli/command";
import { DiagnosticsCollection, parsePublishDiagnostics } from "./diagnostics";
import {
  appendLspFrame,
  encodeLspMessage,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type HoverResult,
  type LspLocation,
  type LspPosition,
  type PublishDiagnosticsParams,
} from "./protocol";

export type LspServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * How long a request may go unanswered. A constructor option (not only the default) so a
   * test can prove the timeout fires without waiting the real fifteen seconds for it.
   */
  requestTimeoutMs?: number;
  /**
   * Run the command through the platform shell. Needed on Windows for servers installed as npm
   * shims (`.cmd` files), which cannot be spawned directly.
   */
  shell?: boolean;
  /**
   * Keep the server from holding the host's event loop open. For a long-lived client (one kept
   * warm for a whole session) the host must still exit when its own work is done; the process is
   * then reaped by `close()` or the exit hook `killProcessTree` installs.
   */
  unref?: boolean;
};

/** The server's own capabilities, as reported by the `initialize` handshake. */
export type LspServerCapabilities = {
  hoverProvider?: boolean;
  definitionProvider?: boolean;
  textDocumentSync?: number | { openClose?: boolean; change?: number };
};

export class LspClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspClientError";
  }
}

type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class LspClient {
  private readonly child: ChildProcess;
  private readonly collection = new DiagnosticsCollection();
  private readonly protocolErrors: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer: Buffer = Buffer.alloc(0);
  private initializePromise: Promise<LspServerCapabilities> | null = null;
  private closedError: Error | undefined;
  private readonly requestTimeoutMs: number;
  private readonly publishListeners = new Set<(params: PublishDiagnosticsParams) => void>();

  constructor(private readonly config: LspServerConfig & { rootUri: string; workspaceRoot: string }) {
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.child = spawn(config.command, config.args ?? [], {
      cwd: config.workspaceRoot,
      // A language server is third-party code Archymedes spawns, exactly like a command
      // `run_command` runs, and it gets the same treatment: Archymedes's own provider keys are
      // stripped before it starts. A server's own credentials still reach it through
      // `config.env`, which is applied after sanitizing and so is never stripped.
      env: { ...sanitizeCommandEnvironment(process.env), ...config.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: config.shell ?? false,
      windowsHide: true,
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin!.on("error", (error) => this.fail(error));
    // Wait for stdout to drain before rejecting outstanding replies from an exiting server.
    this.child.on("close", (code) => this.fail(new Error(`language server '${config.command}' exited (code ${code})`)));
    // Server diagnostics on stderr are not protocol messages. An unread pipe eventually blocks
    // the server, so the bytes are drained and dropped — the user asked for diagnostics on the
    // workspace, not on the server.
    this.child.stderr!.resume();
    // Frames are cut by byte count, so the bytes stay bytes until a whole body has arrived.
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const { messages, rest } = appendLspFrame(this.buffer);
      this.buffer = rest;
      for (const message of messages) this.handleMessage(message);
    });
    if (config.unref) {
      this.child.unref();
      for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
        if (stream && "unref" in stream && typeof stream.unref === "function") stream.unref();
      }
    }
  }

  /** The server's process id, for a caller that tracks live servers (undefined if spawn failed). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** True once the connection has failed or been closed; nothing more will be sent or received. */
  get closed(): boolean {
    return this.closedError !== undefined;
  }

  /**
   * Called on every valid `publishDiagnostics`, after the collection is updated. Returns the
   * unsubscribe function. Lets a caller wait for *the next* publication for a document instead
   * of polling the collection.
   */
  onPublishDiagnostics(listener: (params: PublishDiagnosticsParams) => void): () => void {
    this.publishListeners.add(listener);
    return () => { this.publishListeners.delete(listener); };
  }

  /** What the servers have published so far. Read-only view of the live collection. */
  get diagnostics(): DiagnosticsCollection {
    return this.collection;
  }

  /** Protocol-level failures recorded while reading, for a caller that wants to show them. */
  get errors(): readonly string[] {
    return this.protocolErrors;
  }

  private fail(error: Error): void {
    this.closedError ??= error;
    this.rejectAllPending(this.closedError);
  }

  private rejectAllPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private handleMessage(parsed: unknown): void {
    if (isJsonRpcRequest(parsed)) {
      // Servers ask the client things too (configuration, capability registration). Nothing here
      // implements them, and saying so is what keeps a server from waiting on an answer forever.
      if (!this.closedError) this.child.stdin!.write(encodeLspMessage({ jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: `Method not supported: ${parsed.method}` } }));
      return;
    }
    if (isJsonRpcResponse(parsed)) {
      const waiting = this.pending.get(parsed.id);
      if (!waiting) return;
      this.pending.delete(parsed.id);
      if (parsed.error) waiting.reject(new LspClientError(`language server '${this.config.command}': ${parsed.error.message} (code ${parsed.error.code})`));
      else waiting.resolve(parsed.result);
      return;
    }
    if (isJsonRpcNotification(parsed) && parsed.method === "textDocument/publishDiagnostics") {
      let params: PublishDiagnosticsParams;
      try {
        params = parsePublishDiagnostics(parsed.params);
        this.collection.publish(params);
      } catch (error) {
        // A payload that does not parse is recorded against the server rather than thrown:
        // one server publishing something unexpected must not take the diagnostics of every
        // other server down with it.
        this.protocolErrors.push(error instanceof Error ? error.message : String(error));
        return;
      }
      for (const listener of this.publishListeners) {
        try { listener(params); } catch { /* a listener's failure is its own */ }
      }
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const message = encodeLspMessage({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspClientError(`language server '${this.config.command}' did not respond to '${method}' within ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin!.write(message);
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closedError) throw this.closedError;
    this.child.stdin!.write(encodeLspMessage({ jsonrpc: "2.0", method, params }));
  }

  /**
   * The LSP handshake: `initialize`, then `initialized`.
   *
   * Idempotent — every caller awaits the same handshake rather than repeating it — and the
   * server's capabilities are kept so a caller can check `hoverProvider` before offering a
   * hover affordance. The `rootUri` is sent so a server can resolve workspace-relative
   * configuration; a server that has not indexed yet publishes nothing until it has, which
   * is why the collect step waits after opening files.
   */
  initialize(): Promise<LspServerCapabilities> {
    if (this.closedError) return Promise.reject(this.closedError);
    this.initializePromise ??= (async () => {
      const result = await this.request("initialize", {
        processId: process.pid,
        capabilities: { textDocument: { publishDiagnostics: {} } },
        clientInfo: { name: "archymedes", version: "1" },
        rootUri: this.config.rootUri,
        workspaceFolders: [{ uri: this.config.rootUri, name: "workspace" }],
      }) as { capabilities?: LspServerCapabilities } | null;
      this.notify("initialized", {});
      return result?.capabilities ?? {};
    })();
    return this.initializePromise;
  }

  /**
   * Tells the server a document is open, with its full text.
   *
   * A server analyses what it knows about; a file Archymedes has not opened is, to the server,
   * a file it has never seen, and it will not publish diagnostics for it. The text is sent
   * with the document so the server's first publication reflects what is on disk now rather
   * than whatever it last indexed.
   */
  didOpen(uri: string, languageId: string, text: string, version = 1): void {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  /**
   * Replaces an open document's text (full-document sync: one content change with no range).
   *
   * Every server accepts a whole-text change regardless of the incremental sync it advertises,
   * and for the one-file-after-an-edit use this exists for, computing a minimal range edit would
   * cost more than sending the file. `version` must increase per document.
   */
  didChange(uri: string, version: number, text: string): void {
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /** Tells the server a document is no longer open; it may drop its diagnostics. */
  didClose(uri: string): void {
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  /** What the server says is under a position, or null when it says nothing is. */
  async hover(uri: string, position: LspPosition): Promise<HoverResult | null> {
    await this.initialize();
    const result = await this.request("textDocument/hover", { textDocument: { uri }, position });
    return (result as HoverResult | null) ?? null;
  }

  /** Where the symbol at a position is defined — one location, several, or none. */
  async definition(uri: string, position: LspPosition): Promise<LspLocation[]> {
    await this.initialize();
    const result = await this.request("textDocument/definition", { textDocument: { uri }, position });
    return toLocations(result);
  }

  /**
   * Ends the connection and the server's whole process tree.
   *
   * `sync` is for a process `exit` hook, where nothing asynchronous will run: on Windows it waits
   * for `taskkill` instead of firing it off.
   */
  close(options: { sync?: boolean } = {}): void {
    this.fail(new LspClientError(`language server '${this.config.command}' connection closed`));
    try { this.child.stdin?.end(); } catch { /* already gone */ }
    killProcessTree(this.child, options.sync ?? false);
  }
}

/**
 * Kills a spawned server and everything it started.
 *
 * On Windows `child.kill()` ends only the direct child — with `shell: true` that is `cmd.exe`, and
 * the real server (and a `tsserver` it forked) would be orphaned. `taskkill /T /F` walks the tree.
 * Elsewhere the server gets SIGTERM, and its stdin was already closed, which LSP servers (and the
 * compilers they fork, which watch their parent's pipe) treat as the signal to exit.
 */
export function killProcessTree(child: ChildProcess, sync: boolean): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === "win32" && pid) {
    const args = ["/PID", String(pid), "/T", "/F"];
    try {
      if (sync) spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: 5_000 });
      else spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).on("error", () => child.kill()).unref();
      return;
    } catch {
      // taskkill unavailable: fall through to killing the direct child at least.
    }
  }
  try { child.kill(); } catch { /* exited between the check and the signal */ }
}

function toLocations(result: unknown): LspLocation[] {
  if (result === null || result === undefined) return [];
  const candidates = Array.isArray(result) ? result : [result];
  return candidates.filter((candidate): candidate is LspLocation =>
    typeof candidate === "object" && candidate !== null
    && typeof (candidate as { uri?: unknown }).uri === "string"
    && typeof (candidate as { range?: unknown }).range === "object");
}
