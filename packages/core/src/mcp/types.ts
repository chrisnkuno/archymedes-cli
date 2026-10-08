/**
 * The MCP module's shared vocabulary: what a configured server is, what its tools look like, and the
 * transport contract both connection mechanisms implement.
 *
 * Split from the transports and the connection so that `config.ts` (which only needs to *parse* a
 * declaration) and `client.ts` (which only needs to *use* tools) can both depend on these shapes
 * without depending on either mechanism — the same layering `cli/tool-providers.ts` draws between a
 * provider's own tool description and what the runtime needs from it.
 */

/**
 * One MCP server declaration, from `.archymedes/mcp.json` or a plugin manifest.
 *
 * A server is *either* stdio *or* HTTP — the two transports share nothing about how they are reached,
 * so a union with a discriminant (`command` vs `url`) is the honest shape: a config that declared
 * both, or neither, is a mistake `parseMcpServerConfig` rejects rather than something a connection
 * would have to arbitrate at runtime.
 *
 * An MCP server is a process Archymedes spawns (or a URL it calls) on the machine Archymedes itself
 * runs on, which is true regardless of whether the workspace's files live locally or in a sandbox.
 */
export type McpServerConfig =
  | {
      /** Provenance id — must be unique among configured servers. */
      id: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      id: string;
      /** Streamable HTTP endpoint. `http:` and `https:` only — see `HttpMcpTransport`. */
      url: string;
      headers?: Record<string, string>;
    };

/** One tool as a server's `tools/list` describes it, before it becomes an `ExternalTool`. */
export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** The parsed result of one `tools/call` — text content plus the server's own error flag. */
export type McpToolResult = {
  content: string;
  isError?: boolean;
};

/**
 * The JSON-RPC 2.0 plumbing both transports speak: one request/response exchange, one fire-and-forget
 * notification, and a close.
 *
 * Deliberately transport-shaped rather than MCP-shaped — `McpConnection` above it is the half that
 * knows the protocol (initialize handshake, `tools/list`, `tools/call`), so a transport only has to
 * move messages. That is what lets a stdio server and an HTTP server be interchangeable to every
 * caller above them, and it is why neither transport file mentions a tool.
 */
export interface JsonRpcTransport {
  /** Sends one request and resolves with the response's `result`, rejecting with the `error`. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Sends one notification — no id, no response expected, failures are not this client's to see. */
  notify(method: string, params: unknown): void;
  /** Releases the underlying process or HTTP resources. Idempotent. */
  close(): void;
}

/** A server-initiated message: a method, and deliberately no id to answer. */
export type JsonRpcNotificationHandler = (method: string, params: unknown) => void;
