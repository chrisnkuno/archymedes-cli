/**
 * MCP (Model Context Protocol) support for Archymedes: connect to servers over stdio or HTTP, list
 * and call their tools, and expose them to the agent as ordinary external tools.
 *
 * Module map, for a reader arriving from the CLI's `.archymedes/mcp.json`:
 * - `config.ts` — parses server declarations (the "which servers" file).
 * - `stdio-transport.ts` / `http-transport.ts` — the two JSON-RPC transports.
 * - `connection.ts` — the MCP protocol over either transport (`McpConnection`).
 * - `client.ts` — the caller-facing handle and the `ToolProvider` adapter.
 * - `types.ts` — the shared vocabulary.
 */

export { MCP_CONFIG_PATH, parseMcpServerConfig, discoverMcpServers } from "./config";
export { McpConnection } from "./connection";
export { McpClient, McpToolProvider } from "./client";
export { StdioMcpTransport } from "./stdio-transport";
export { HttpMcpTransport } from "./http-transport";
export type { McpServerConfig, McpToolDefinition, McpToolResult, JsonRpcTransport, JsonRpcNotificationHandler } from "./types";
