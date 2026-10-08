import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient, McpToolProvider } from "./client";

let root: string;
let serverPath: string;

const FAKE_SERVER_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
    return;
  }
  if (request.method === "notifications/initialized") return;
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0", id: request.id,
      result: { tools: [{ name: "add", description: "Adds two integers.", inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false } }] },
    });
    return;
  }
  if (request.method === "tools/call") {
    const { name, arguments: args } = request.params;
    if (name === "add") {
      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: String(args.a + args.b) }] } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown tool: " + name } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method: " + request.method } });
});
`;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-mcp-client-"));
  serverPath = path.join(root, "fake-server.js");
  await fs.writeFile(serverPath, FAKE_SERVER_SCRIPT);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("McpClient", () => {
  it("connects, lists, calls and closes against a real stdio server", async () => {
    const client = McpClient.connect({ id: "fake", command: "node", args: [serverPath] });
    try {
      expect(client.id).toBe("fake");
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["add"]);
      await expect(client.callTool("add", { a: 10, b: 32 })).resolves.toEqual({ content: "42", isError: undefined });
    } finally {
      client.close();
    }
    await expect(client.callTool("add", { a: 1, b: 2 })).rejects.toThrow(/connection closed/);
  });
});

describe("McpToolProvider", () => {
  it("exposes the connection's tools as invokable ExternalTools", async () => {
    const provider = McpToolProvider.forServer({ id: "fake", command: "node", args: [serverPath] });
    try {
      expect(provider.kind).toBe("mcp");
      expect(provider.id).toBe("fake");
      const tools = await provider.listTools();
      expect(tools).toHaveLength(1);
      const result = await tools[0].invoke({ a: 10, b: 32 });
      expect(result).toEqual({ content: "42", isError: undefined });
    } finally {
      provider.close();
    }
  });
});
