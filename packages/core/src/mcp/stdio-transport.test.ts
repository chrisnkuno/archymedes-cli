import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StdioMcpTransport } from "./stdio-transport";

let root: string;
let serverPath: string;

/**
 * A tiny, real MCP server over stdio — newline-delimited JSON-RPC 2.0, exactly what `StdioMcpTransport`
 * speaks. Not a mock of the protocol: this is the actual message shape a real MCP server sends, run
 * as a real subprocess, so a bug in framing or field names shows up the same way it would against a
 * genuine server.
 */
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
  if (request.method === "notifications/initialized") return; // no response — it's a notification
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "add", description: "Adds two integers.", inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false } }] } });
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-mcp-stdio-"));
  serverPath = path.join(root, "fake-server.js");
  await fs.writeFile(serverPath, FAKE_SERVER_SCRIPT);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("StdioMcpTransport", () => {
  it("answers a request with its result", async () => {
    const transport = new StdioMcpTransport({ id: "fake", command: "node", args: [serverPath] }, 5_000, () => {});
    try {
      const result = await transport.request("tools/list", {});
      expect(result).toMatchObject({ tools: [{ name: "add" }] });
    } finally {
      transport.close();
    }
  });

  it("surfaces a JSON-RPC error as a rejected promise naming the server", async () => {
    const transport = new StdioMcpTransport({ id: "fake", command: "node", args: [serverPath] }, 5_000, () => {});
    try {
      await expect(transport.request("unknown/method", {})).rejects.toThrow(/fake.*Unknown method/s);
    } finally {
      transport.close();
    }
  });

  it("routes a server notification to the handler", async () => {
    // A server that announces a tool-list change the way a real one does: an unsolicited
    // notification with no id, arriving between this client's own requests.
    const announcingPath = path.join(root, "announcing-server.js");
    await fs.writeFile(announcingPath, `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const request = JSON.parse(line);
        if (request.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
          return;
        }
        if (request.method === "notifications/initialized") return;
        if (request.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\\n");
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } }) + "\\n");
          return;
        }
      });
    `);
    const seen: string[] = [];
    const transport = new StdioMcpTransport({ id: "announcing", command: "node", args: [announcingPath] }, 5_000, (method) => seen.push(method));
    try {
      await transport.request("tools/list", {});
      expect(seen).toEqual(["notifications/tools/list_changed"]);
    } finally {
      transport.close();
    }
  });

  it("rejects a request that never gets a response within the timeout", async () => {
    const silentServerPath = path.join(root, "silent-server.js");
    await fs.writeFile(silentServerPath, "setInterval(() => {}, 1000);"); // never reads stdin, never replies
    const transport = new StdioMcpTransport({ id: "silent", command: "node", args: [silentServerPath] }, 100, () => {});
    try {
      await expect(transport.request("tools/list", {})).rejects.toThrow(/did not respond/);
    } finally {
      transport.close();
    }
  });

  it("rejects every pending request when the server process exits", async () => {
    const transport = new StdioMcpTransport({ id: "dying", command: "node", args: ["-e", "process.exit(1)"] }, 5_000, () => {});
    await expect(transport.request("tools/list", {})).rejects.toThrow(/exited/);
  });

  it("never sees Archymedes's own provider keys, matching what run_command already guaranteed", async () => {
    const reportPath = path.join(root, "seen.json");
    const scriptPath = path.join(root, "env-server.js");
    await fs.writeFile(scriptPath, `
      require("node:fs").writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
        anthropic: process.env.ANTHROPIC_API_KEY ?? null,
        ownCredential: process.env.MY_SERVER_TOKEN ?? null,
        path: Boolean(process.env.PATH),
      }));
      ${FAKE_SERVER_SCRIPT}
    `);
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-live-secret-value";
    const transport = new StdioMcpTransport({ id: "probe", command: "node", args: [scriptPath], env: { MY_SERVER_TOKEN: "server-own" } }, 5_000, () => {});
    try {
      await transport.request("tools/list", {});
      const seen = JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(seen.anthropic).toBeNull();
      expect(seen.ownCredential).toBe("server-own");
      expect(seen.path).toBe(true); // still a working environment, not an empty one
    } finally {
      transport.close();
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });
});
