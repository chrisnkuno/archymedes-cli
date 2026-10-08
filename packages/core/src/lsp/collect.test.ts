import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectWorkspaceDiagnostics } from "./collect";
import { FAKE_SERVER_SCRIPT } from "./fake-server";
import type { LspServerDefinition } from "./servers";

let root: string;
let serverPath: string;
let servers: LspServerDefinition[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-lsp-collect-"));
  // Outside the workspace being walked, so the server's own script is not one of the files collected.
  serverPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-lsp-server-")), "fake-server.js");
  await fs.writeFile(serverPath, FAKE_SERVER_SCRIPT);
  servers = [
    { id: "typescript", command: process.execPath, args: [serverPath], extensions: [".ts"], languageIds: ["typescript"] },
    { id: "pyright", command: path.join(root, "no-such-server"), args: [], extensions: [".py"], languageIds: ["python"] },
  ];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  await fs.rm(path.dirname(serverPath), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

async function write(relative: string, content: string): Promise<void> {
  const absolute = path.join(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

/** Reports the fake server as installed and nothing else, so no test depends on the machine's PATH. */
const fakeProbe = async (command: string): Promise<boolean> => command === process.execPath;

describe("collectWorkspaceDiagnostics", () => {
  it("collects diagnostics from the server that claims the workspace's files", async () => {
    await write("src/a.ts", "const x = 1;\n");
    await write("src/b.ts", "const y = 2;\n");
    const result = await collectWorkspaceDiagnostics(root, { probe: fakeProbe, settleMs: 500, servers });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].ok).toBe(true);
    expect(result.servers[0].server.id).toBe("typescript");
    expect(result.files).toHaveLength(2);
    expect(result.files.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.counts.total).toBe(4); // two diagnostics per file, two files
    expect(result.counts.error).toBe(2);
    expect(result.counts.warning).toBe(2);
  });

  it("reports a server whose command is not installed as unavailable, not as a failure", async () => {
    await write("src/a.ts", "const x = 1;\n");
    const result = await collectWorkspaceDiagnostics(root, { probe: async () => false, settleMs: 10, servers });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].ok).toBe(false);
    expect(result.servers[0].error).toMatch(/not installed/);
    expect(result.files).toEqual([]);
    expect(result.counts.total).toBe(0);
  });

  it("skips files no known server claims", async () => {
    await write("README.md", "# hi\n");
    await write("data.txt", "plain text\n");
    await write("src/a.ts", "const x = 1;\n");
    const result = await collectWorkspaceDiagnostics(root, { probe: fakeProbe, settleMs: 500, servers });
    expect(result.servers).toHaveLength(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("src/a.ts");
  });

  it("filters files by the include glob", async () => {
    await write("src/a.ts", "const x = 1;\n");
    await write("lib/b.ts", "const y = 2;\n");
    const result = await collectWorkspaceDiagnostics(root, { probe: fakeProbe, settleMs: 500, include: "src/**", servers });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("src/a.ts");
  });

  it("returns an empty result for a workspace with no files a server claims", async () => {
    await write("README.md", "# hi\n");
    const result = await collectWorkspaceDiagnostics(root, { probe: fakeProbe, settleMs: 10, servers });
    expect(result.servers).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.counts.total).toBe(0);
  });

  it("caps how many files each server is asked to open", async () => {
    for (let index = 0; index < 5; index += 1) await write(`src/file${index}.ts`, `const x${index} = ${index};\n`);
    const result = await collectWorkspaceDiagnostics(root, { probe: fakeProbe, settleMs: 500, maxFilesPerServer: 2, servers });
    expect(result.files).toHaveLength(2);
  });

  it("keeps the other servers' diagnostics when one server cannot start", async () => {
    await write("src/a.ts", "const x = 1;\n");
    await write("note.py", "x = 1\n");
    // Both servers are "installed" as far as the probe says, but the second one's command does
    // not exist — the spawn fails, and that server's failure is returned alongside
    // the working one's diagnostics instead of taking the whole result down.
    const result = await collectWorkspaceDiagnostics(root, { probe: async () => true, settleMs: 500, servers });
    const typescript = result.servers.find((server) => server.server.id === "typescript");
    const python = result.servers.find((server) => server.server.id === "pyright");
    expect(typescript?.ok).toBe(true);
    expect(python?.ok).toBe(false);
    expect(python?.error).toBeDefined();
    expect(result.counts.total).toBe(2); // the TypeScript file's diagnostics still count
  });
});
