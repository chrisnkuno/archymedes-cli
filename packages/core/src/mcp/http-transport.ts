import type { JsonRpcNotificationHandler, JsonRpcTransport, McpServerConfig } from "./types";

/**
 * JSON-RPC 2.0 over MCP's Streamable HTTP transport — for servers reached at a URL rather than
 * spawned as a process. Each request is one POST; the reply comes back either as a single
 * `application/json` body or as a `text/event-stream` of server-sent `message` events, both of
 * which are parsed here into the same promise the stdio transport produces.
 *
 * The session half of the protocol is handled because it is one header: a server that answers with
 * `Mcp-Session-Id` expects it back on every later request, and a client that does not send it gets
 * its second request rejected as unknown-session. Everything else about the exchange is ordinary
 * HTTP, which is what makes this transport testable against a plain `node:http` server.
 */
export class HttpMcpTransport implements JsonRpcTransport {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closedError: Error | undefined;
  private sessionId: string | undefined;
  private readonly inFlight = new Set<AbortController>();

  constructor(
    private readonly config: Extract<McpServerConfig, { url: string }>,
    private readonly requestTimeoutMs: number,
    private readonly onNotification: JsonRpcNotificationHandler,
  ) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.config.headers ?? {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };
  }

  /**
   * POSTs one JSON-RPC message and awaits the reply.
   *
   * `Accept` names both content types because a server chooses per response: a plain request gets
   * JSON back, while one that triggers server-initiated messages gets an event stream. Sending only
   * `application/json` would make the stream a protocol error at the server.
   *
   * A failure belongs to the request that hit it. An HTTP error or a timeout rejects that one call
   * and leaves the transport usable, since each request is its own connection — unlike stdio, where
   * a dead pipe is dead for everyone.
   */
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closedError) throw this.closedError;
    const id = this.nextId++;
    const abort = new AbortController();
    this.inFlight.add(abort);
    return new Promise((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.inFlight.delete(abort);
      };
      const timer = setTimeout(() => {
        settle();
        abort.abort();
        reject(new Error(`MCP server '${this.config.id}' did not respond to '${method}' within ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => { settle(); resolve(value); },
        reject: (error) => { settle(); abort.abort(); reject(error); },
      });
      this.post(JSON.stringify({ jsonrpc: "2.0", id, method, params }), abort.signal).then(
        // The body ended without an answer to this request: say so rather than wait for the timeout.
        () => this.pending.get(id)?.reject(new Error(`MCP server '${this.config.id}' answered '${method}' without a JSON-RPC response`)),
        (error: unknown) => this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  private async post(body: string, signal: AbortSignal): Promise<void> {
    const response = await fetch(this.config.url, { method: "POST", headers: this.headers(), body, signal });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`MCP server '${this.config.id}' answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      await this.consumeEventStream(response);
      return;
    }
    const text = await response.text();
    if (!text.trim()) throw new Error(`MCP server '${this.config.id}' answered with an empty body`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`MCP server '${this.config.id}' answered with a body that is not JSON`);
    }
    this.deliver(parsed);
  }
  /**
   * Reads an SSE stream to its end, dispatching each `data:` payload.
   *
   * A stream is how a server sends notifications alongside — or instead of — a response, so it is
   * drained fully rather than closed at the first message: the response to the request that opened
   * it may be the second event, and notifications after it are still this client's to receive.
   */
  private async consumeEventStream(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`MCP server '${this.config.id}' opened an event stream with no body`);
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line; a `data:` line carries one JSON payload.
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trim()).join("\n");
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch {
          continue; // A malformed event is the server's noise, not a protocol failure to act on.
        }
        this.deliver(parsed);
      }
    }
  }

  /** Routes one parsed JSON-RPC message: a notification to the handler, a response to its waiter. */
  private deliver(message: unknown): void {
    if (!isPlainObject(message)) return;
    if (isJsonRpcNotification(message)) {
      this.onNotification(message.method, message.params ?? {});
      return;
    }
    if (!isJsonRpcResponse(message)) return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    if (message.error) waiting.reject(new Error(`MCP server '${this.config.id}': ${message.error.message} (code ${message.error.code})`));
    else waiting.resolve(message.result);
  }

  notify(method: string, params: unknown): void {
    if (this.closedError) throw this.closedError;
    // A notification has no reply to wait for, so it is fire-and-forget. A failure here is not the
    // turn's to see: nothing depended on the notification arriving.
    fetch(this.config.url, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method, params }) })
      .then((response) => {
        const sessionId = response.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        return response.body?.cancel();
      })
      .catch(() => undefined);
  }

  close(): void {
    this.closedError ??= new Error(`MCP server '${this.config.id}' connection closed`);
    for (const { reject } of [...this.pending.values()]) reject(this.closedError);
    for (const abort of this.inFlight) abort.abort();
    this.inFlight.clear();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } };

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isPlainObject(value) && "jsonrpc" in value && "id" in value && typeof value.id === "number" && !("method" in value);
}

function isJsonRpcNotification(value: unknown): value is { jsonrpc: "2.0"; method: string; params?: unknown } {
  return isPlainObject(value) && "jsonrpc" in value && !("id" in value) && typeof value.method === "string";
}
