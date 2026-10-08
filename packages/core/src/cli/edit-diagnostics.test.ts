import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLspEditDiagnostics, type LspEditDiagnostics } from "./edit-diagnostics";
import { FAKE_SERVER_SCRIPT } from "../lsp/fake-server";
import type { LspServerDefinition } from "../lsp/servers";

let root: string;
let serverPath: string;
let servers: LspServerDefinition[];
const hooks: LspEditDiagnostics[] = [];
function track(hook: LspEditDiagnostics): LspEditDiagnostics {
  hooks.push(hook);
  return hook;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-edit-diag-"));
  serverPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-edit-diag-server-")), "fake-server.js");
  await fs.writeFile(serverPath, FAKE_SERVER_SCRIPT);
  servers = [
    { id: "typescript", command: process.execPath, args: [serverPath], extensions: [".ts"], languageIds: ["typescript"] },
    { id: "pyright", command: path.join(root, "no-such-server"), args: [], extensions: [".py"], languageIds: ["python"] },
  ];
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "x;\n  y;\n");
  await fs.writeFile(path.join(root, "src", "a.py"), "x\n");
  await fs.writeFile(path.join(root, "notes.md"), "# notes\n");
});

afterEach(async () => {
  for (const hook of hooks.splice(0)) hook.close();
  // Give taskkill / SIGTERM a moment so the temp directories are not held open on Windows.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  await fs.rm(path.dirname(serverPath), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const fakeProbe = async (command: string): Promise<boolean> => command === process.execPath;

describe("createLspEditDiagnostics", () => {
  it("reports the edited file's errors and warnings as compact lines", async () => {
    const diagnose = track(createLspEditDiagnostics(root, { probe: fakeProbe, servers, timeoutMs: 10_000, refineMs: 50 }));
    const report = await diagnose("src/a.ts");
    expect(report?.split("\n")).toEqual([
      "src/a.ts:1:1 error Cannot find name 'x'. (fake)",
      "src/a.ts:2:3 warning Unused expression",
    ]);
  });

  it("caps the number of lines", async () => {
    const diagnose = track(createLspEditDiagnostics(root, { probe: fakeProbe, servers, timeoutMs: 10_000, refineMs: 50, maxLines: 1 }));
    expect((await diagnose(path.join(root, "src", "a.ts")))?.split("\n")).toEqual([
      "src/a.ts:1:1 error Cannot find name 'x'. (fake)",
      "… 1 more",
    ]);
  });

  it("is silent when no server claims the file, the server is missing, or the path leaves the workspace", async () => {
    const diagnose = track(createLspEditDiagnostics(root, { probe: fakeProbe, servers, timeoutMs: 2_000 }));
    expect(await diagnose("notes.md")).toBeUndefined();
    expect(await diagnose("src/a.py")).toBeUndefined();
    expect(await diagnose("../elsewhere.ts")).toBeUndefined();
    expect(await diagnose("src/missing.ts")).toBeUndefined();
  });

  it("gives up within its deadline when the server never answers", async () => {
    const silent = path.join(path.dirname(serverPath), "silent.js");
    await fs.writeFile(silent, "process.stdin.resume();\n");
    const diagnose = track(createLspEditDiagnostics(root, {
      probe: fakeProbe,
      servers: [{ id: "typescript", command: process.execPath, args: [silent], extensions: [".ts"], languageIds: ["typescript"] }],
      timeoutMs: 300,
    }));
    const started = Date.now();
    expect(await diagnose("src/a.ts")).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps one warm server per language and reports diagnostics for the edited version", async () => {
    const starts = path.join(path.dirname(serverPath), "starts.log");
    const diagnose = track(createLspEditDiagnostics(root, {
      probe: fakeProbe,
      servers: [{ id: "typescript", command: process.execPath, args: [serverPath, "0", starts], extensions: [".ts"], languageIds: ["typescript"] }],
      timeoutMs: 5_000,
      refineMs: 20,
    }));
    // First edit opens the document (the fake server's didOpen diagnostics).
    expect(await diagnose("src/a.ts")).toContain("Cannot find name 'x'.");
    // Later edits are didChange against the same server, and the report is for the new text.
    await fs.writeFile(path.join(root, "src", "a.ts"), "ok\nERR one\n");
    expect(await diagnose("src/a.ts")).toBe("src/a.ts:2:1 error v2 ERR one (fake)");
    await fs.writeFile(path.join(root, "src", "a.ts"), "ok\n");
    expect(await diagnose("src/a.ts")).toBeUndefined();
    await fs.writeFile(path.join(root, "src", "b.ts"), "ERR b\n");
    expect(await diagnose("src/b.ts")).toContain("Cannot find name 'x'.");
    await fs.writeFile(path.join(root, "src", "b.ts"), "ERR b2\n");
    expect(await diagnose("src/b.ts")).toBe("src/b.ts:1:1 error v2 ERR b2 (fake)");
    expect((await fs.readFile(starts, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(diagnose.serverPids()).toHaveLength(1);
  });

  it("lets a slow first start time out silently and is warm for the next edit", async () => {
    const starts = path.join(path.dirname(serverPath), "starts.log");
    const diagnose = track(createLspEditDiagnostics(root, {
      probe: fakeProbe,
      servers: [{ id: "typescript", command: process.execPath, args: [serverPath, "600", starts], extensions: [".ts"], languageIds: ["typescript"] }],
      timeoutMs: 3_000,
      startupTimeoutMs: 100,
      refineMs: 20,
    }));
    const started = Date.now();
    expect(await diagnose("src/a.ts")).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await diagnose("src/a.ts")).toContain("Cannot find name 'x'.");
    expect((await fs.readFile(starts, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("stops its servers on close and restarts lazily on the next edit", async () => {
    const diagnose = track(createLspEditDiagnostics(root, { probe: fakeProbe, servers, timeoutMs: 5_000, refineMs: 20 }));
    expect(await diagnose("src/a.ts")).toBeDefined();
    const [pid] = diagnose.serverPids();
    expect(pid).toBeTypeOf("number");
    diagnose.close();
    expect(diagnose.serverPids()).toEqual([]);
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid!, 0); await new Promise((resolve) => setTimeout(resolve, 50)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
    expect(await diagnose("src/a.ts")).toContain("Cannot find name 'x'.");
    expect(diagnose.serverPids()).toHaveLength(1);
  });
});
