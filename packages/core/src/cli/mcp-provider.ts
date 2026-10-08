/**
 * Compatibility shim: MCP now lives in `../mcp/`, and this module re-exports it unchanged.
 *
 * The implementation moved so that MCP, hooks and skills share one layer under `src/` rather than
 * three modules buried beside the CLI's own command handlers. Existing imports — this package's
 * `index.ts`, `external-tools.ts`, `plugins.ts` and the tests that pin the stdio behaviour — keep
 * working against the same names, and the new module is where changes land.
 */
export { MCP_CONFIG_PATH, parseMcpServerConfig, discoverMcpServers, McpConnection, McpClient, McpToolProvider, StdioMcpTransport, HttpMcpTransport } from "../mcp";
export type { McpServerConfig, McpToolDefinition, McpToolResult, JsonRpcTransport } from "../mcp";
