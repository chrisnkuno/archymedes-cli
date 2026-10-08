import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractSymbols, languageForPath, SymbolIndex, type CodeSymbol } from "./symbols";

const names = (symbols: CodeSymbol[]) => symbols.map((symbol) => (symbol.parent ? `${symbol.parent}.${symbol.name}` : symbol.name));
const find = (symbols: CodeSymbol[], name: string) => symbols.find((symbol) => symbol.name === name);

describe("languageForPath", () => {
  it("maps extensions to languages", () => {
    expect(languageForPath("a/b.tsx")).toBe("typescript");
    expect(languageForPath("types.d.ts")).toBe("typescript");
    expect(languageForPath("x.mjs")).toBe("javascript");
    expect(languageForPath("x.py")).toBe("python");
    expect(languageForPath("x.go")).toBe("go");
    expect(languageForPath("x.rs")).toBe("rust");
    expect(languageForPath("X.java")).toBe("java");
    expect(languageForPath("X.cs")).toBe("csharp");
    expect(languageForPath("README.md")).toBeUndefined();
  });
});

describe("extractSymbols: TypeScript/JavaScript", () => {
  const source = [
    "import { x } from './x';",
    "/**",
    " * Docs.",
    " */",
    "export async function load(path: string): Promise<void> {",
    "  if (path) {",
    "    return;",
    "  }",
    "}",
    "function helper() {}",
    "export default class Server extends Base {",
    "  private port = 3;",
    "  constructor(port: number) {",
    "    super();",
    "    if (port) this.start();",
    "  }",
    "  async start(): Promise<void> {",
    "    for (const x of y) {}",
    "  }",
    "  private stop() {}",
    "  handle = async (event: Event) => {",
    "  };",
    "  static get instance() { return 1; }",
    "}",
    "export interface Options {",
    "  name: string;",
    "  run(): void;",
    "}",
    "export type Mode = 'a' | 'b';",
    "type Generic<T> = T[];",
    "export const enum Color { Red }",
    "export const handler = async (req) => {",
    "};",
    "export const LIMIT = 10;",
    "const compute = function () {};",
    "exports.legacy = 1;",
    "declare namespace Foo.Bar {",
    "}",
  ].join("\n");
  const symbols = extractSymbols(source, "typescript");

  it("finds top-level declarations of every kind", () => {
    expect(names(symbols)).toEqual([
      "load", "helper", "Server", "Server.constructor", "Server.start", "Server.stop", "Server.handle", "Server.instance",
      "Options", "Options.run", "Mode", "Generic", "Color", "handler", "LIMIT", "compute", "legacy", "Foo.Bar",
    ]);
  });

  it("classifies kinds, lines and export status", () => {
    expect(find(symbols, "load")).toMatchObject({ kind: "function", line: 5, exported: true, signature: "export async function load(path: string): Promise<void>" });
    expect(find(symbols, "helper")).toMatchObject({ kind: "function", exported: false });
    expect(find(symbols, "Server")).toMatchObject({ kind: "class", exported: true });
    expect(find(symbols, "stop")).toMatchObject({ kind: "method", parent: "Server", exported: false });
    expect(find(symbols, "start")).toMatchObject({ kind: "method", parent: "Server", exported: true, line: 17 });
    expect(find(symbols, "Options")?.kind).toBe("interface");
    expect(find(symbols, "Mode")?.kind).toBe("type");
    expect(find(symbols, "Color")?.kind).toBe("enum");
    expect(find(symbols, "handler")?.kind).toBe("function");
    expect(find(symbols, "LIMIT")?.kind).toBe("variable");
    expect(find(symbols, "compute")?.kind).toBe("function");
    expect(find(symbols, "legacy")).toMatchObject({ kind: "variable", exported: true });
    expect(find(symbols, "Foo.Bar")?.kind).toBe("namespace");
  });

  it("never mistakes control flow or calls inside bodies for members", () => {
    expect(names(symbols)).not.toContain("Server.if");
    expect(names(symbols)).not.toContain("Server.super");
    expect(names(symbols)).not.toContain("Server.for");
    expect(names(symbols)).not.toContain("load.if");
  });

  it("handles CRLF line endings", () => {
    expect(names(extractSymbols("export function a() {\r\n}\r\nclass B {\r\n  m() {}\r\n}\r\n", "javascript"))).toEqual(["a", "B", "B.m"]);
  });

  it("does not open a container for a one-line class", () => {
    expect(names(extractSymbols("class A {}\n  weird() {}\nfunction b() {}", "typescript"))).toEqual(["A", "b"]);
  });
});

describe("extractSymbols: Python", () => {
  const symbols = extractSymbols([
    "import os",
    "MAX_SIZE = 10",
    "_private = 1",
    "@dataclass",
    "class Config(Base):",
    "    \"\"\"Doc.\"\"\"",
    "    def __init__(self):",
    "        def inner():",
    "            pass",
    "    async def load(self):",
    "        if x:",
    "            pass",
    "",
    "def main():",
    "    pass",
    "async def _helper():",
    "    pass",
  ].join("\n"), "python");

  it("finds classes, methods, functions and constants", () => {
    expect(names(symbols)).toEqual(["MAX_SIZE", "Config", "Config.__init__", "Config.load", "main", "_helper"]);
    expect(find(symbols, "_helper")?.exported).toBe(false);
    expect(find(symbols, "main")).toMatchObject({ kind: "function", exported: true, line: 14 });
    expect(find(symbols, "load")).toMatchObject({ kind: "method", parent: "Config" });
  });
});

describe("extractSymbols: Go", () => {
  const symbols = extractSymbols([
    "package main",
    "type Server struct {",
    "\tport int",
    "}",
    "type Handler interface {",
    "\tServe()",
    "}",
    "type ID string",
    "type (",
    "\tA struct{}",
    "\tB int",
    ")",
    "const (",
    "\tMaxRetries = 3",
    "\tminDelay = 1",
    ")",
    "var Version = \"1\"",
    "func (s *Server) Start() error {",
    "}",
    "func (h handler[T]) serve() {}",
    "func main() {",
    "}",
  ].join("\n"), "go");

  it("finds types, grouped declarations, functions and methods with receivers", () => {
    expect(names(symbols)).toEqual(["Server", "Handler", "ID", "A", "B", "MaxRetries", "minDelay", "Version", "Server.Start", "handler.serve", "main"]);
    expect(find(symbols, "Server")?.kind).toBe("struct");
    expect(find(symbols, "Handler")?.kind).toBe("interface");
    expect(find(symbols, "A")?.kind).toBe("struct");
    expect(find(symbols, "Start")).toMatchObject({ kind: "method", parent: "Server", exported: true });
    expect(find(symbols, "main")?.exported).toBe(false);
  });
});

describe("extractSymbols: Rust", () => {
  const symbols = extractSymbols([
    "use std::io;",
    "pub struct Config {",
    "    pub name: String,",
    "}",
    "enum State { A, B }",
    "pub trait Runner {",
    "    fn run(&self);",
    "}",
    "impl<T> Runner for Wrapper<T> {",
    "    fn run(&self) {",
    "        let x = 1;",
    "    }",
    "}",
    "impl Config {",
    "    pub async fn load() -> Self {",
    "    }",
    "}",
    "pub(crate) fn helper() {}",
    "pub const LIMIT: usize = 3;",
    "mod tests {",
    "}",
    "macro_rules! hello {",
    "}",
  ].join("\n"), "rust");

  it("finds items, trait and impl members", () => {
    expect(names(symbols)).toEqual(["Config", "State", "Runner", "Runner.run", "Wrapper.run", "Config.load", "helper", "LIMIT", "tests", "hello"]);
    expect(find(symbols, "Config")).toMatchObject({ kind: "struct", exported: true });
    expect(find(symbols, "State")?.exported).toBe(false);
    expect(find(symbols, "load")).toMatchObject({ kind: "method", parent: "Config", exported: true });
    expect(find(symbols, "hello")?.kind).toBe("macro");
  });
});

describe("extractSymbols: Java", () => {
  const symbols = extractSymbols([
    "package com.acme;",
    "@Service",
    "public class UserService implements Svc {",
    "    private final Repo repo;",
    "    public UserService(Repo repo) {",
    "        this.repo = repo;",
    "    }",
    "    @Override",
    "    public List<User> findAll(int page) throws IOException {",
    "        return repo.findAll();",
    "    }",
    "    static <T> T identity(T value) { return value; }",
    "    public enum Kind { A }",
    "    interface Inner {",
    "        void go();",
    "    }",
    "}",
    "record Point(int x, int y) {}",
  ].join("\n"), "java");

  it("finds types (nested too) and methods, ignoring statements", () => {
    expect(names(symbols)).toEqual(["UserService", "UserService.UserService", "UserService.findAll", "UserService.identity", "UserService.Kind", "UserService.Inner", "Inner.go", "Point"]);
    expect(find(symbols, "findAll")).toMatchObject({ kind: "method", exported: true });
    expect(find(symbols, "identity")?.exported).toBe(false);
    expect(find(symbols, "Kind")?.kind).toBe("enum");
    expect(find(symbols, "Point")?.kind).toBe("record");
  });
});

describe("extractSymbols: C#", () => {
  const symbols = extractSymbols([
    "using System;",
    "namespace Acme.App",
    "{",
    "    public class Widget : IWidget",
    "    {",
    "        public string Name { get; set; }",
    "        public int Size => 3;",
    "        public Widget(string name) { }",
    "        public async Task<int> RenderAsync(int x)",
    "        {",
    "            return await Do(x);",
    "        }",
    "        private static void Helper<T>() { }",
    "    }",
    "    internal record struct Pair(int A, int B);",
    "    public interface IWidget { }",
    "}",
  ].join("\n"), "csharp");

  it("finds namespaces, types, properties and methods", () => {
    expect(names(symbols)).toEqual(["Acme.App", "Widget", "Widget.Name", "Widget.Size", "Widget.Widget", "Widget.RenderAsync", "Widget.Helper", "Pair", "IWidget"]);
    expect(find(symbols, "Name")?.kind).toBe("property");
    expect(find(symbols, "RenderAsync")).toMatchObject({ kind: "method", exported: true });
    expect(find(symbols, "Helper")?.exported).toBe(false);
    expect(find(symbols, "Pair")?.kind).toBe("record");
  });
});

describe("SymbolIndex", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-symbols-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await fs.mkdir(path.join(root, "generated"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "export function alpha() {}\n");
    await fs.writeFile(path.join(root, "node_modules", "dep", "index.js"), "function hidden() {}\n");
    await fs.writeFile(path.join(root, "generated", "out.ts"), "export function gen() {}\n");
    await fs.writeFile(path.join(root, ".gitignore"), "generated/\n");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("walks only non-ignored files and caches by mtime", async () => {
    const index = new SymbolIndex(root);
    const files = await index.files();
    expect(files.map((file) => file.relative)).toEqual([".gitignore", "src/a.ts"]);
    const first = await index.symbolsForAll(files);
    expect(first.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(index.parsedCount).toBe(1);
    await index.symbolsForAll(await index.files());
    expect(index.parsedCount).toBe(1);

    const target = path.join(root, "src", "a.ts");
    await fs.writeFile(target, "export function alpha() {}\nexport function beta() {}\n");
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(target, later, later);
    const second = await index.symbolsForAll(await index.files());
    expect(index.parsedCount).toBe(2);
    expect(second[0].symbols.map((symbol) => symbol.name)).toEqual(["alpha", "beta"]);
  });

  it("scopes to a prefix", async () => {
    await fs.writeFile(path.join(root, "top.py"), "def top():\n    pass\n");
    const index = new SymbolIndex(root);
    expect((await index.files("src")).map((file) => file.relative)).toEqual(["src/a.ts"]);
  });
});
