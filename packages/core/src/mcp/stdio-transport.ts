import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { sanitizeCommandEnvironment } from "../cli/command";
import type { JsonRpcNotificationHandler, JsonRpcTransport, McpServerConfig } from "./types";

/**
 * JSON-RPC 2.0 over a child process's stdio — the transport every MCP server supports, unlike the
 * optional HTTP one. One JSON object per line on the child's stdin and stdout; no Content-Length
 * framing (that is LSP's convention, not MCP's).
 *
 * This is the message plumbing only: it moves requests, responses and notifications, and knows
 * nothing about MCP's protocol. `McpConnection` above it is what turns `tools/list` and `tools/call`
 * into something a `ToolProvider` can merge in.
 */
export class StdioMcpTransport implements JsonRpcTransport {
  private readonly child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closedError: Error | undefined;

  /**
   * `requestTimeoutMs` is a constructor option (not only the default) so a test can prove the
   * timeout fires without waiting 15s for it.
   */
  constructor(
    private readonly config: Extract<McpServerConfig, { command: string }>,
    private readonly requestTimeoutMs: number,
    private readonly onNotification: JsonRpcNotificationHandler,
  ) {
    this.child = spawn(config.command, config.args ?? [], {
      // An MCP server is third-party code Archymedes spawns, exactly like a command `run_command` runs,
      // and it gets the same treatment: Archymedes's own provider keys are stripped before it starts.
      // A server's own credentials still reach it through `config.env`, which is applied after
      // sanitizing and so is never stripped.
      env: { ...sanitizeCommandEnvironment(process.env), ...config.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin!.on("error", (error) => this.fail(error));
    // Wait for stdout to drain before rejecting outstanding replies from an exiting server.
    this.child.on("close", (code) => this.fail(new Error(`MCP server '${config.id}' exited (code ${code})`)));
    // Diagnostics are not protocol messages. An unread pipe eventually blocks the server.
    this.child.stderr!.resume();
    const lines = createInterface({ input: this.child.stdout! });
    lines.on("line", (line) => this.handleLine(line));
  }

  private fail(error: Error): void {
    this.closedError ??= error;
    this.rejectAllPending(this.closedError);
  }

  private rejectAllPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // A malformed line from a misbehaving server is not this client's failure to surface mid-stream.
    }
    if (isJsonRpcNotification(parsed)) {
      this.onNotification(parsed.method, parsed.params ?? {});
      return;
    }
    if (!isJsonRpcResponse(parsed)) return;
    const waiting = this.pending.get(parsed.id);
    if (!waiting) return;
    this.pending.delete(parsed.id);
    if (parsed.error) waiting.reject(new Error(`MCP server '${this.config.id}': ${parsed.error.message} (code ${parsed.error.code})`));
    else waiting.resolve(parsed.result);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server '${this.config.id}' did not respond to '${method}' within ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      if (!this.child.stdin!.write(line)) { /* backpressure is fine — Node queues it. */ }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closedError) throw this.closedError;
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    this.fail(new Error(`MCP server '${this.config.id}' connection closed`));
    this.child.kill();
  }
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } };

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return typeof value === "object" && value !== null && "jsonrpc" in value && "id" in value && typeof (value as { id: unknown }).id === "number" && !("method" in value);
}

function isJsonRpcNotification(value: unknown): value is { jsonrpc: "2.0"; method: string; params?: unknown } {
  return typeof value === "object" && value !== null
    && "jsonrpc" in value && !("id" in value)
    && typeof (value as { method?: unknown }).method === "string";
}
