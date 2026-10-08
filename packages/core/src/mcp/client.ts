import type { ExternalTool, ToolProvider } from "../cli/tool-providers";
import { McpConnection } from "./connection";
import type { McpServerConfig, McpToolDefinition, McpToolResult } from "./types";

/**
 * The one-call shape a caller uses to work with an MCP server: connect, list, call, close.
 *
 * `McpConnection` below the transports is the protocol; this is the handle. It exists so that a
 * caller which wants "the tools of the server declared in this config" — the CLI's external-tool
 * assembly, a `/mcp` inspector, a test — does not have to know that a connection is constructed from
 * a config's shape, and so that the `ToolProvider` half (`McpToolProvider`) and the direct half
 * share one code path rather than two implementations of "list this server's tools".
 */
export class McpClient {
  private readonly connection: McpConnection;

  private constructor(readonly id: string, connection: McpConnection) {
    this.connection = connection;
  }

  /** Connects to the server named by `config`, choosing the transport from the config's own shape. */
  static connect(config: McpServerConfig, requestTimeoutMs?: number): McpClient {
    return new McpClient(config.id, new McpConnection(config, requestTimeoutMs));
  }

  /** The server's tools, as the protocol describes them. */
  listTools(): Promise<McpToolDefinition[]> {
    return this.connection.listTools();
  }

  /** Calls one tool by name with validated arguments. */
  callTool(name: string, argumentsValue: Record<string, unknown>): Promise<McpToolResult> {
    return this.connection.callTool(name, argumentsValue);
  }

  close(): void {
    this.connection.close();
  }
}

/**
 * Exposes one MCP server's tools as a `ToolProvider`, so an MCP server merges into the agent's tool
 * set exactly like a skill or a plugin does — one wrapping point (`toolsFromProvider`) for schema
 * validation, approval gating and provenance tagging, regardless of where a tool came from.
 *
 * Schemas outside Archymedes's supported subset (see tool-schema.ts) fail loudly at registration
 * rather than reaching the model unvalidated — that check lives in `toolsFromProvider`, which every
 * provider passes through.
 */
export class McpToolProvider implements ToolProvider {
  readonly kind = "mcp" as const;
  readonly id: string;

  constructor(private readonly connection: McpConnection, id: string) {
    this.id = id;
  }

  /** Builds a provider straight from a server declaration — the one call the CLI's assembly makes. */
  static forServer(config: McpServerConfig, requestTimeoutMs?: number): McpToolProvider {
    return new McpToolProvider(new McpConnection(config, requestTimeoutMs), config.id);
  }

  async listTools(): Promise<ExternalTool[]> {
    const tools = await this.connection.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      invoke: (argumentsValue) => this.connection.callTool(tool.name, argumentsValue),
    }));
  }

  /** Releases the underlying connection's process or HTTP resources. Idempotent. */
  close(): void {
    this.connection.close();
  }
}
