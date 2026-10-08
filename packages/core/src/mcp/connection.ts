import { HttpMcpTransport } from "./http-transport";
import { StdioMcpTransport } from "./stdio-transport";
import type { JsonRpcTransport, McpServerConfig, McpToolDefinition, McpToolResult } from "./types";

/**
 * A live MCP connection: the protocol half (initialize handshake, `tools/list`, `tools/call`) over
 * whichever transport the server's declaration calls for.
 *
 * One class over two transports is the whole point of the split below it: a caller — and a test —
 * can hold an `McpConnection` without knowing or caring whether the server on the other end is a
 * child process or a URL. The transport is chosen once, from the config's shape, and everything
 * above this line is written against `JsonRpcTransport` alone.
 */
export class McpConnection {
  private readonly transport: JsonRpcTransport;
  private initializePromise: Promise<void> | null = null;
  /** Cached `tools/list` result. Cleared when the server says its tools changed. */
  private toolsPromise: Promise<McpToolDefinition[]> | undefined;
  private closedError: Error | undefined;

  /** `requestTimeoutMs` is a constructor option (not only the default) so a test can prove the timeout fires without waiting 15s for it. */
  constructor(readonly config: McpServerConfig, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
    // The one notification this client cares about is the one that makes caching `tools/list`
    // correct rather than merely fast: a server that adds or removes a tool says so, and the cache
    // is dropped there instead of being re-polled every turn on the chance that it might have.
    const onNotification = (method: string): void => {
      if (method === "notifications/tools/list_changed") this.invalidateTools();
    };
    this.transport = "command" in config
      ? new StdioMcpTransport(config, requestTimeoutMs, onNotification)
      : new HttpMcpTransport(config, requestTimeoutMs, onNotification);
  }

  /** Idempotent — every caller awaits the same handshake rather than repeating it. */
  private initialize(): Promise<void> {
    this.initializePromise ??= (async () => {
      await this.transport.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "archymedes", version: "1" },
      });
      this.transport.notify("notifications/initialized", {});
    })();
    return this.initializePromise;
  }

  /**
   * The server's tool list, fetched once per connection.
   *
   * `createArchymedesTools` runs on every turn, so this was a `tools/list` round trip per turn per
   * server — pure latency on the critical path between the user pressing Enter and the model being
   * asked anything, and it bought nothing: MCP servers announce changes rather than expecting to be
   * re-polled. `notifications/tools/list_changed` is that announcement, and it clears this.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    // Checked before the cache: a listing remembered from before the close is not an answer now.
    if (this.closedError) throw this.closedError;
    await this.initialize();
    this.toolsPromise ??= (async () => {
      const result = await this.transport.request("tools/list", {}) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
      return (result.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: false },
      }));
    })().catch((error) => {
      // A failed listing must not be cached: the next turn should try again rather than inherit
      // this one's bad luck with a server that was still starting up.
      this.toolsPromise = undefined;
      throw error;
    });
    return this.toolsPromise;
  }

  /** Drops the cached tool list, so the next `listTools` asks the server again. */
  invalidateTools(): void {
    this.toolsPromise = undefined;
  }

  /**
   * Calls one tool and parses the result.
   *
   * MCP content blocks are typed (`text`, `image`, `resource`, …) and only `text` carries anything
   * this product can show a model, so the others are dropped rather than stringified — a tool that
   * answers in images is one whose answer would arrive as `[object Object]` if the blocks were
   * serialized whole. The server's own `isError` flag is preserved: it is the tool saying "this
   * failed", which is not the same as the call failing.
   */
  async callTool(name: string, argumentsValue: Record<string, unknown>): Promise<McpToolResult> {
    if (this.closedError) throw this.closedError;
    await this.initialize();
    const result = await this.transport.request("tools/call", { name, arguments: argumentsValue }) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    return { content: text || "(no output)", isError: result.isError };
  }

  close(): void {
    this.closedError ??= new Error(`MCP server '${this.config.id}' connection closed`);
    this.transport.close();
  }
}

const MCP_PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT_MS = 15_000;
