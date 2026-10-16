import { spawn } from "node:child_process";

/**
 * JSON-RPC 2.0 with `codex app-server`, one message per line on its stdin and stdout.
 *
 * Three kinds of incoming line: an answer to one of our requests (by id), a notification (method,
 * no id), and a request from Codex to us (method and id: an approval), which `onRequest` answers.
 * The transport is a pair of streams so tests can stand in for the process.
 */

export type JsonRpcMessage = { jsonrpc?: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

export type CodexTransport = {
  write(line: string): void;
  /** Every line Codex prints, in order. */
  onLine(listener: (line: string) => void): void;
  /** Codex is gone: exited, crashed, or was closed. */
  onExit(listener: (reason: string) => void): void;
  close(): void;
};

export class CodexRpcError extends Error {
  constructor(readonly method: string, message: string, readonly code?: number) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export class CodexRpc {
  private nextId = 1;
  private readonly pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closed?: string;

  constructor(
    private readonly transport: CodexTransport,
    private readonly handlers: {
      onNotification: (method: string, params: Record<string, unknown>) => void;
      onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      onExit?: (reason: string) => void;
    },
  ) {
    transport.onLine((line) => this.receive(line));
    transport.onExit((reason) => this.gone(reason));
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new CodexRpcError(method, `Codex is not running (${this.closed})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(method, `Codex did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  get running(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.transport.close();
    this.gone("closed");
  }

  private send(message: JsonRpcMessage): void {
    this.transport.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // not protocol: a stray line is not a reason to stop
    }
    if (message.method && message.id !== undefined) {
      const id = message.id;
      this.handlers.onRequest(message.method, asRecord(message.params)).then(
        (result) => this.send({ jsonrpc: "2.0", id, result }),
        (error: unknown) => this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }),
      );
      return;
    }
    if (message.method) {
      this.handlers.onNotification(message.method, asRecord(message.params));
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    if (message.error) waiting.reject(new CodexRpcError(waiting.method, message.error.message ?? "Codex refused the request", message.error.code));
    else waiting.resolve(message.result);
  }

  private gone(reason: string): void {
    if (this.closed) return;
    this.closed = reason;
    for (const [, waiting] of this.pending) waiting.reject(new CodexRpcError(waiting.method, `Codex stopped: ${reason}`));
    this.pending.clear();
    this.handlers.onExit?.(reason);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** `codex app-server` as a child process, its stderr kept for saying why it stopped. */
export function spawnCodexAppServer(executable: string, cwd: string, environment: Record<string, string | undefined>): CodexTransport & { stderr(): string } {
  const child = spawn(executable, ["app-server"], { cwd, env: environment as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
  const lineListeners: Array<(line: string) => void> = [];
  const exitListeners: Array<(reason: string) => void> = [];
  let buffer = "";
  let stderr = "";
  let exited = false;
  const exit = (reason: string) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener(reason);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      for (const listener of lineListeners) listener(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_000); });
  child.on("error", (error) => exit(error.message));
  child.on("exit", (code, signal) => exit(signal ? `signal ${signal}` : `exit ${code}`));
  child.stdin.on("error", () => undefined); // a write after exit: the exit says why
  return {
    write: (line) => { if (!exited) child.stdin.write(line); },
    onLine: (listener) => { lineListeners.push(listener); },
    onExit: (listener) => { exitListeners.push(listener); },
    close: () => { child.stdin.end(); child.kill(); },
    stderr: () => stderr,
  };
}
