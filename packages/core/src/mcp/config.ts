import type { McpServerConfig } from "./types";

/**
 * Reading MCP server declarations from `.archymedes/mcp.json` — the "which servers" half of MCP,
 * kept apart from the "how to talk to them" half in `transports.ts`/`connection.ts`.
 *
 * The file is `{ "servers": [...] }`, one entry per server, each either stdio (`command`, optional
 * `args`/`env`) or HTTP (`url`, optional `headers`). A missing file is zero servers, not an error —
 * most projects have no MCP servers, and a missing manifest is their ordinary state.
 *
 * Read through the workspace like every other `.archymedes` manifest, so the declaration travels with
 * the repository and behaves identically on a local, E2B or Docker session.
 */
export const MCP_CONFIG_PATH = ".archymedes/mcp.json";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses and validates one server entry from a `mcpServers` array — shared by `.archymedes/mcp.json` and a plugin's own manifest. */
export function parseMcpServerConfig(displayPath: string, index: number, value: unknown): McpServerConfig {
  if (!isPlainObject(value)) throw new Error(`${displayPath}: mcpServers[${index}] must be an object`);
  const { id, command, args, env, url, headers } = value;
  if (typeof id !== "string" || !id.trim()) throw new Error(`${displayPath}: mcpServers[${index}].id must be a non-empty string`);
  // A server is reached one way or the other. Accepting both, or neither, here would push the
  // decision onto the connection, where it would surface as a runtime failure against a config the
  // user can see and fix — the error belongs at the declaration, naming the exact entry.
  const hasCommand = command !== undefined;
  const hasUrl = url !== undefined;
  if (hasCommand === hasUrl) {
    throw new Error(`${displayPath}: mcpServers[${index}] must declare exactly one of "command" (stdio) or "url" (HTTP)`);
  }
  if (hasCommand) {
    if (typeof command !== "string" || !command.trim()) throw new Error(`${displayPath}: mcpServers[${index}].command must be a non-empty string`);
    if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== "string"))) {
      throw new Error(`${displayPath}: mcpServers[${index}].args must be an array of strings`);
    }
    if (env !== undefined && (!isPlainObject(env) || Object.values(env).some((item) => typeof item !== "string"))) {
      throw new Error(`${displayPath}: mcpServers[${index}].env must be an object of strings`);
    }
    return { id, command, args: args as string[] | undefined, env: env as Record<string, string> | undefined };
  }
  if (typeof url !== "string" || !url.trim()) throw new Error(`${displayPath}: mcpServers[${index}].url must be a non-empty string`);
  if (headers !== undefined && (!isPlainObject(headers) || Object.values(headers).some((item) => typeof item !== "string"))) {
    throw new Error(`${displayPath}: mcpServers[${index}].headers must be an object of strings`);
  }
  return { id, url, headers: headers as Record<string, string> | undefined };
}

/**
 * Every server declared in `.archymedes/mcp.json`. A missing file yields an empty list; a malformed
 * one throws with the file's path in the message, the same contract `discoverSkillManifests` holds.
 *
 * Duplicate ids are rejected: two entries sharing an id would make every provenance tag and error
 * message ambiguous about which server is meant, and the second would silently shadow the first.
 */
export async function discoverMcpServers(workspace: { readFile(path: string): Promise<{ content: string }> }): Promise<McpServerConfig[]> {
  const file = await workspace.readFile(MCP_CONFIG_PATH).catch(() => null);
  if (!file) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch (error) {
    throw new Error(`${MCP_CONFIG_PATH}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.servers)) throw new Error(`${MCP_CONFIG_PATH}: must be an object with a "servers" array`);
  const servers = parsed.servers.map((server, index) => parseMcpServerConfig(MCP_CONFIG_PATH, index, server));
  const ids = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) throw new Error(`${MCP_CONFIG_PATH}: duplicate mcpServers id "${server.id}"`);
    ids.add(server.id);
  }
  return servers;
}
