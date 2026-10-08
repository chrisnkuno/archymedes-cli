import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LspClient, LspClientError } from "./client";
import { FAKE_SERVER_SCRIPT } from "./fake-server";

let root: string;

/** A server whose publishDiagnostics payload has no uri — malformed, but only for that one message. */
const BROKEN_PUBLISH_SCRIPT = FAKE_SERVER_SCRIPT.replace(
  "params: { uri: message.params.textDocument.uri, diagnostics: [",
  "params: { diagnostics: [",
);

/** A server that answers every request with a JSON-RPC error. */
const ERROR_SERVER_SCRIPT = FAKE_SERVER_SCRIPT.replace(
  "function handle(message) {",
  'function handle(message) {\n  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "nope" } });\n  return;',
);

/** A server whose definition answer is null rather than a location list. */
const NULL_DEFINITION_SCRIPT = FAKE_SERVER_SCRIPT.replace(
  'send({ jsonrpc: "2.0", id: message.id, result: [{ uri: "file:///src/other.ts", range: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } } }] });',
  'send({ jsonrpc: "2.0", id: message.id, result: null });',
);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-lsp-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

async function writeServer(name: string, script: string): Promise<string> {
  const serverPath = path.join(root, name);
  await fs.writeFile(serverPath, script);
  return serverPath;
}

function client(serverPath: string, requestTimeoutMs?: number): LspClient {
  return new LspClient({
    command: process.execPath,
    args: [serverPath],
    rootUri: "file:///src",
    workspaceRoot: root,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
}

describe("LspClient", () => {
  it("completes the initialize handshake and reports the server's capabilities", async () => {
    const connection = client(await writeServer("fake-server.js", FAKE_SERVER_SCRIPT));
    try {
      const capabilities = await connection.initialize();
      expect(capabilities.hoverProvider).toBe(true);
      expect(capabilities.definitionProvider).toBe(true);
    } finally {
      connection.close();
    }
  });

  it("collects diagnostics the server publishes after didOpen", async () => {
    const connection = client(await writeServer("fake-server.js", FAKE_SERVER_SCRIPT));
    try {
      await connection.initialize();
      connection.didOpen("file:///src/a.ts", "typescript", "const x = 1;\n");
      // The publish is pushed by the server in response to didOpen, so wait for it to land.
      await vi.waitFor(() => expect(connection.diagnostics.get("file:///src/a.ts")).toHaveLength(2), { timeout: 5_000 });
      const diagnostics = connection.diagnostics.get("file:///src/a.ts");
      expect(diagnostics[0].message).toBe("Cannot find name 'x'.");
      expect(diagnostics[0].severity).toBe(1);
      expect(diagnostics[1].severity).toBe(2);
      expect(connection.diagnostics.counts().total).toBe(2);
    } finally {
      connection.close();
    }
  });

  it("sends full-text didChange and notifies listeners of each versioned publication", async () => {
    const connection = client(await writeServer("fake-server.js", FAKE_SERVER_SCRIPT));
    const published: Array<{ version?: number; count: number }> = [];
    const unsubscribe = connection.onPublishDiagnostics((params) => published.push({ version: params.version, count: params.diagnostics.length }));
    try {
      await connection.initialize();
      connection.didOpen("file:///src/a.ts", "typescript", "x;\n");
      connection.didChange("file:///src/a.ts", 2, "ERR one\nfine\nERR two\n");
      await vi.waitFor(() => expect(published).toHaveLength(2), { timeout: 5_000 });
      expect(published[1]).toEqual({ version: 2, count: 2 });
      expect(connection.diagnostics.get("file:///src/a.ts").map((diagnostic) => diagnostic.message)).toEqual(["v2 ERR one", "v2 ERR two"]);
      unsubscribe();
      connection.didChange("file:///src/a.ts", 3, "clean\n");
      await vi.waitFor(() => expect(connection.diagnostics.get("file:///src/a.ts")).toHaveLength(0), { timeout: 5_000 });
      expect(published).toHaveLength(2);
      expect(connection.pid).toBeTypeOf("number");
      expect(connection.closed).toBe(false);
    } finally {
      connection.close();
    }
    expect(connection.closed).toBe(true);
    expect(() => connection.didChange("file:///src/a.ts", 4, "")).toThrow();
  });

  it("answers a hover request with the server's contents", async () => {
    const connection = client(await writeServer("fake-server.js", FAKE_SERVER_SCRIPT));
    try {
      const hover = await connection.hover("file:///src/a.ts", { line: 0, character: 2 });
      expect(hover).toEqual({ contents: { kind: "markdown", value: "const x: string" } });
    } finally {
      connection.close();
    }
  });

  it("answers a definition request with the locations the server returned", async () => {
    const connection = client(await writeServer("fake-server.js", FAKE_SERVER_SCRIPT));
    try {
      const locations = await connection.definition("file:///src/a.ts", { line: 0, character: 2 });
      expect(locations).toEqual([{ uri: "file:///src/other.ts", range: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } } }]);
    } finally {
      connection.close();
    }
  });

  it("returns an empty location list when the server answers null", async () => {
    const connection = client(await writeServer("null-definition-server.js", NULL_DEFINITION_SCRIPT));
    try {
      expect(await connection.definition("file:///src/a.ts", { line: 0, character: 2 })).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("surfaces a JSON-RPC error from the server as a rejected promise naming the code", async () => {
    const connection = client(await writeServer("error-server.js", ERROR_SERVER_SCRIPT));
    try {
      await expect(connection.initialize()).rejects.toThrow(/nope \(code -32601\)/);
    } finally {
      connection.close();
    }
  });

  it("rejects every pending request when the server process exits", async () => {
    const connection = new LspClient({ command: process.execPath, args: ["-e", "process.exit(1)"], rootUri: "file:///src", workspaceRoot: root });
    await expect(connection.initialize()).rejects.toThrow(/exited \(code 1\)/);
    await expect(connection.initialize()).rejects.toThrow(/exited/);
  });

  it("rejects a request that never gets a response within the timeout", async () => {
    const silentServer = await writeServer("silent-server.js", "setInterval(() => {}, 1000);"); // never reads stdin, never replies
    const connection = client(silentServer, 100);
    try {
      await expect(connection.initialize()).rejects.toThrow(/did not respond to 'initialize' within 100ms/);
    } finally {
      connection.close();
    }
  });

  it("rejects requests after close immediately instead of writing to a dead pipe", async () => {
    const connection = client(await writeServer("fake-server.js", FAKE_SERVER_SCRIPT));
    await connection.initialize();
    connection.close();
    await expect(connection.initialize()).rejects.toThrow(/connection closed/);
    expect(() => connection.didOpen("file:///src/b.ts", "typescript", "")).toThrow(LspClientError);
  });

  it("records a malformed publishDiagnostics payload as a protocol error, not a crash", async () => {
    const connection = client(await writeServer("broken-publish-server.js", BROKEN_PUBLISH_SCRIPT));
    try {
      await connection.initialize();
      connection.didOpen("file:///src/a.ts", "typescript", "const x = 1;\n");
      await vi.waitFor(() => expect(connection.errors.length).toBeGreaterThan(0), { timeout: 5_000 });
      expect(connection.errors[0]).toMatch(/uri must be a non-empty string/);
      expect(connection.diagnostics.counts().total).toBe(0);
    } finally {
      connection.close();
    }
  });
});
