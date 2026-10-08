import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverMcpServers, parseMcpServerConfig } from "./config";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-mcp-config-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A workspace double over a real temp directory — the same `readFile` contract `ArchymedesWorkspace` has. */
async function writeConfig(contents: string | null): Promise<{ readFile(path: string): Promise<{ content: string }> }> {
  if (contents !== null) {
    await fs.mkdir(path.join(root, ".archymedes"), { recursive: true });
    await fs.writeFile(path.join(root, ".archymedes/mcp.json"), contents);
  }
  return {
    readFile: async (requested: string) => {
      const full = path.join(root, requested);
      if (!full.startsWith(root)) throw new Error("outside root");
      return { content: await fs.readFile(full, "utf8") };
    },
  };
}

describe("parseMcpServerConfig", () => {
  it("parses a stdio server with its args and env", () => {
    const config = parseMcpServerConfig("mcp.json", 0, { id: "fs", command: "npx", args: ["-y", "server"], env: { TOKEN: "t" } });
    expect(config).toEqual({ id: "fs", command: "npx", args: ["-y", "server"], env: { TOKEN: "t" } });
  });

  it("parses an HTTP server with its headers", () => {
    const config = parseMcpServerConfig("mcp.json", 2, { id: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } });
    expect(config).toEqual({ id: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } });
  });

  it("rejects a server declaring both transports, or neither", () => {
    // The decision of which transport to use belongs to the config's shape; a declaration that
    // leaves it ambiguous is a mistake to name here, not a runtime failure to discover later.
    expect(() => parseMcpServerConfig("mcp.json", 0, { id: "x", command: "npx", url: "https://e.com" })).toThrow(/exactly one/);
    expect(() => parseMcpServerConfig("mcp.json", 0, { id: "x" })).toThrow(/exactly one/);
  });

  it("names the exact bad entry in every other failure mode", () => {
    expect(() => parseMcpServerConfig("mcp.json", 3, "nope")).toThrow(/mcpServers\[3\] must be an object/);
    expect(() => parseMcpServerConfig("mcp.json", 3, { command: "npx" })).toThrow(/mcpServers\[3\]\.id/);
    expect(() => parseMcpServerConfig("mcp.json", 3, { id: "x", command: "" })).toThrow(/command must be a non-empty string/);
    expect(() => parseMcpServerConfig("mcp.json", 3, { id: "x", command: "npx", args: [1] })).toThrow(/args must be an array of strings/);
    expect(() => parseMcpServerConfig("mcp.json", 3, { id: "x", command: "npx", env: { A: 1 } })).toThrow(/env must be an object of strings/);
    expect(() => parseMcpServerConfig("mcp.json", 3, { id: "x", url: "" })).toThrow(/url must be a non-empty string/);
    expect(() => parseMcpServerConfig("mcp.json", 3, { id: "x", url: "https://e.com", headers: { A: 1 } })).toThrow(/headers must be an object of strings/);
  });
});

describe("discoverMcpServers", () => {
  it("treats a missing file as zero servers, not an error", async () => {
    expect(await discoverMcpServers(await writeConfig(null))).toEqual([]);
  });

  it("reads both transport kinds from one file", async () => {
    const workspace = await writeConfig(JSON.stringify({
      servers: [
        { id: "local", command: "node", args: ["server.js"] },
        { id: "remote", url: "https://example.com/mcp" },
      ],
    }));
    expect(await discoverMcpServers(workspace)).toEqual([
      { id: "local", command: "node", args: ["server.js"] },
      { id: "remote", url: "https://example.com/mcp" },
    ]);
  });

  it("rejects a malformed file with its path in the message", async () => {
    await expect(discoverMcpServers(await writeConfig("not json"))).rejects.toThrow(/mcp\.json.*invalid JSON/);
    await expect(discoverMcpServers(await writeConfig("{}"))).rejects.toThrow(/servers/);
  });

  it("rejects duplicate ids, which would make provenance ambiguous", async () => {
    const workspace = await writeConfig(JSON.stringify({ servers: [{ id: "same", command: "a" }, { id: "same", command: "b" }] }));
    await expect(discoverMcpServers(workspace)).rejects.toThrow(/duplicate mcpServers id "same"/);
  });
});
