import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "../../agent-runtime";
import { createRepoMapTools, rankFile } from "./repo-map";
import { SymbolIndex } from "./symbols";

const context = { taskId: "t", runId: "r", stepId: "s" };
let root: string;
let tools: Map<string, AgentTool>;
let index: SymbolIndex;

async function write(relative: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
}

function setup(ripgrep: string | null = null): void {
  index = new SymbolIndex(root);
  tools = new Map(createRepoMapTools({ root, ripgrep }, index).map((tool) => [tool.name, tool]));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-repomap-"));
  await write("src/index.ts", "import { Server } from './server';\nexport function main() {\n  new Server().start();\n}\n");
  await write("src/server.ts", "export class Server {\n  start() {\n    return 1;\n  }\n  stop() {}\n}\nfunction internal() {}\n");
  await write("src/server.test.ts", "import { Server } from './server';\ntest('x', () => new Server());\n");
  await write("py/app.py", "class App:\n    def run(self):\n        pass\n\ndef start():\n    pass\n");
  await write("README.md", "# readme mentions Server\n");
  await write("docs/guide.md", "guide\n");
  await write("node_modules/dep/index.js", "export function Server() {}\n");
  await write("out/bundle.js", "export function Server() {}\n");
  await write(".gitignore", "out/\n");
  setup();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("repo_map", () => {
  it("is declared read-only and parallel-safe", () => {
    const tool = tools.get("repo_map")!;
    expect(tool).toMatchObject({ effect: "none", parallelSafe: true, requiresApproval: false });
  });

  it("lists files with their symbols, ignoring node_modules and gitignored output", async () => {
    const result = await tools.get("repo_map")!.execute({}, context);
    expect(result.content).toContain("src/server.ts\n  1: export class Server\n    2: start()\n    5: stop() {}\n  7: function internal() {}");
    expect(result.content).toContain("py/app.py\n  1: class App:\n    2: def run(self):\n  5: def start():");
    expect(result.content).toContain("Other files:");
    expect(result.content).toContain("docs/ (1): guide.md");
    expect(result.content).not.toContain("node_modules");
    expect(result.content).not.toContain("bundle.js");
    expect(result.data).toMatchObject({ totalFiles: 7, filesWithSymbols: 3, omittedFiles: 0 });
    // A source file with no declarations is still listed, among the plain files.
    expect(result.content).toContain("src/ (1): server.test.ts");
  });

  it("scopes to a subdirectory", async () => {
    const result = await tools.get("repo_map")!.execute({ path: "py" }, context);
    expect(result.content).toContain("py/app.py");
    expect(result.content).not.toContain("src/server.ts");
    expect(result.data).toMatchObject({ path: "py", totalFiles: 1 });
  });

  it("filters by query over paths and symbol names", async () => {
    const result = await tools.get("repo_map")!.execute({ query: "stop" }, context);
    expect(result.content).toContain("src/server.ts\n    5: stop() {}");
    expect(result.content).not.toContain("start()");
    expect(result.content).not.toContain("py/app.py");
    const none = await tools.get("repo_map")!.execute({ query: "zzz-nothing" }, context);
    expect(none.content).toContain("No files or symbols matched.");
  });

  it("refuses paths outside the workspace and non-directories", async () => {
    await expect(tools.get("repo_map")!.execute({ path: "../" }, context)).rejects.toThrow(/escapes the workspace root/);
    await expect(tools.get("repo_map")!.execute({ path: "README.md" }, context)).rejects.toThrow(/not a directory/);
    await expect(tools.get("repo_map")!.execute({ path: "missing" }, context)).rejects.toThrow(/does not exist/);
  });

  it("fits the budget, keeping the best-ranked files and reporting the rest", async () => {
    for (let file = 0; file < 60; file += 1) {
      await write(`gen/deep/f${file}.ts`, Array.from({ length: 10 }, (_, symbol) => `function f${file}_${symbol}(argument: string): void {}`).join("\n"));
    }
    const result = await tools.get("repo_map")!.execute({ maxChars: 2_000 }, context);
    expect(result.content.length).toBeLessThanOrEqual(2_000);
    expect(result.content).toContain("src/index.ts");
    expect(result.content).toMatch(/more files? omitted to fit 2000 chars/);
    expect((result.data as { omittedFiles: number }).omittedFiles).toBeGreaterThan(0);
  });

  it("ranks exported entry points above tests", () => {
    const entry = rankFile({ path: "src/index.ts", language: "typescript", size: 1, symbols: [{ name: "main", kind: "function", line: 1, signature: "", exported: true }] });
    const test = rankFile({ path: "src/server.test.ts", language: "typescript", size: 1, symbols: [{ name: "x", kind: "function", line: 1, signature: "", exported: true }] });
    expect(entry).toBeGreaterThan(test);
  });

  it("re-parses only changed files between calls (mtime cache)", async () => {
    await tools.get("repo_map")!.execute({}, context);
    const parsed = index.parsedCount;
    await tools.get("repo_map")!.execute({}, context);
    expect(index.parsedCount).toBe(parsed);
    const target = path.join(root, "src", "server.ts");
    await fs.writeFile(target, "export class Server {}\nexport function added() {}\n");
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(target, later, later);
    const result = await tools.get("repo_map")!.execute({}, context);
    expect(index.parsedCount).toBe(parsed + 1);
    expect(result.content).toContain("export function added()");
  });
});

describe("find_symbol", () => {
  it("finds definitions with file:line and signature, exported first", async () => {
    const result = await tools.get("find_symbol")!.execute({ name: "start" }, context);
    expect(result.content).toBe([
      "py/app.py:5: [function] def start():",
      "src/server.ts:2: [method in Server] start()",
    ].join("\n"));
    expect(result.data).toMatchObject({ exact: true, total: 2 });
  });

  it("supports Parent.member and kind filters", async () => {
    const qualified = await tools.get("find_symbol")!.execute({ name: "Server.start" }, context);
    expect(qualified.content).toBe("src/server.ts:2: [method in Server] start()");
    const byKind = await tools.get("find_symbol")!.execute({ name: "start", kind: "function" }, context);
    expect(byKind.content).toBe("py/app.py:5: [function] def start():");
  });

  it("falls back to case-insensitive matches and suggests similar names", async () => {
    const folded = await tools.get("find_symbol")!.execute({ name: "server" }, context);
    expect(folded.content).toContain("src/server.ts:1: [class] export class Server");
    expect(folded.content).toContain("no exact-case match");
    const missing = await tools.get("find_symbol")!.execute({ name: "intern" }, context);
    expect(missing.content).toBe("No definition of 'intern' found. Similar names: internal.");
  });

  it("finds whole-word references (JS fallback) and marks the definition line", async () => {
    const result = await tools.get("find_symbol")!.execute({ name: "Server", mode: "references" }, context);
    const data = result.data as { matches: Array<{ path: string; line: number; definition: boolean }> };
    const where = data.matches.map((match) => `${match.path}:${match.line}`);
    expect(where).toContain("src/index.ts:1");
    expect(where).toContain("src/index.ts:3");
    expect(where).toContain("src/server.test.ts:2");
    expect(where).toContain("README.md:1");
    expect(where).not.toContain("node_modules/dep/index.js:1");
    expect(where).not.toContain("out/bundle.js:1");
    expect(data.matches.find((match) => match.path === "src/server.ts" && match.line === 1)?.definition).toBe(true);
    expect(result.content).toContain("src/server.ts:1: (definition) export class Server {");
  });

  it("respects word boundaries and path scoping in references", async () => {
    await write("src/other.ts", "const ServerX = 1;\nconst aServer = 2;\n");
    const result = await tools.get("find_symbol")!.execute({ name: "Server", mode: "references", path: "src" }, context);
    const paths = (result.data as { matches: Array<{ path: string }> }).matches.map((match) => match.path);
    expect(paths).not.toContain("src/other.ts");
    expect(paths).not.toContain("README.md");
  });

  it("truncates references at maxResults", async () => {
    const result = await tools.get("find_symbol")!.execute({ name: "Server", mode: "references", maxResults: 2 }, context);
    expect((result.data as { matches: unknown[]; truncated: boolean }).matches).toHaveLength(2);
    expect(result.data).toMatchObject({ truncated: true });
    expect(result.content).toContain("more references not shown");
  });

  it("rejects an unknown mode", async () => {
    await expect(tools.get("find_symbol")!.execute({ name: "x", mode: "callers" }, context)).rejects.toThrow(/mode must be one of/);
  });
});
