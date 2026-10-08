import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyTextEdits,
  editTextFile,
  editTextFileWithEdits,
  FileReadTracker,
  parseEditArguments,
  parseGitignore,
  parseRipgrepJsonLine,
  ripgrepArguments,
  DEFAULT_WORKSPACE_LIMITS,
  globToRegExp,
  globWorkspace,
  grepWorkspace,
  looksBinary,
  readBinaryFile,
  walkWorkspace,
  readTextFile,
  resolveInWorkspace,
  writeTextFile,
  WorkspaceViolation,
} from "./workspace";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-workspace-"));
  await fs.mkdir(path.join(root, "src", "deep"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "main.ts"), "export const value = 1;\nconst other = 2;\n");
  await fs.writeFile(path.join(root, "src", "deep", "util.ts"), "export function help() { return 'value'; }\n");
  await fs.writeFile(path.join(root, "README.md"), "# Project\nvalue lives in src\n");
  await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "value\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("workspace confinement", () => {
  it("refuses paths that climb out of the project", () => {
    expect(() => resolveInWorkspace(root, "../secrets.txt")).toThrow(WorkspaceViolation);
    expect(() => resolveInWorkspace(root, "src/../../etc/passwd")).toThrow(WorkspaceViolation);
    expect(() => resolveInWorkspace(root, "/etc/passwd")).toThrow(WorkspaceViolation);
    expect(resolveInWorkspace(root, "src/main.ts")).toBe(path.join(root, "src", "main.ts"));
  });

  it("refuses to read through a symlink that points outside the project", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "credentials\n");
    try {
      await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    } catch {
      return; // Symlinks unavailable on this platform; the lexical check above still applies.
    }
    await expect(readTextFile(root, "link.txt")).rejects.toThrow(/outside the workspace root/);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("reports paths relative to the spelling of an aliased workspace root", async () => {
    const alias = `${root}-alias`;
    try {
      await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // Some locked-down Windows environments do not permit links.
    }
    try {
      expect((await readTextFile(alias, "src/main.ts")).path).toBe("src/main.ts");
    } finally {
      await fs.unlink(alias).catch(() => undefined);
    }
  });

  it("refuses binary files and oversized reads rather than feeding them to the model", async () => {
    await fs.writeFile(path.join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    await expect(readTextFile(root, "image.bin")).rejects.toThrow(/binary/);
    expect(looksBinary(Buffer.from("plain text"))).toBe(false);

    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(2_000));
    await expect(readTextFile(root, "big.txt", { limits: { maxReadBytes: 100, maxWriteBytes: 100, ignoredDirectories: [] } })).rejects.toThrow(/read limit/);
  });

  it("reads raw bytes for rendering under the same confinement and size limit", async () => {
    await fs.writeFile(path.join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const read = await readBinaryFile(root, "image.bin");
    expect(read.path).toBe("image.bin");
    expect([...read.bytes]).toEqual([0x89, 0x50, 0x00, 0x01, 0x02]);
    await expect(readBinaryFile(root, "../escape.png")).rejects.toThrow(WorkspaceViolation);
    await expect(readBinaryFile(root, "missing.png")).rejects.toThrow(/does not exist/);
    await expect(readBinaryFile(root, "image.bin", { maxReadBytes: 2, maxWriteBytes: 2, ignoredDirectories: [] })).rejects.toThrow(/read limit/);
  });
});

describe("reading and editing", () => {
  it("returns a line window with an honest header when asked for one", async () => {
    const whole = await readTextFile(root, "src/main.ts");
    expect(whole.truncated).toBe(false);
    expect(whole.totalLines).toBe(3);

    const window = await readTextFile(root, "src/main.ts", { offset: 2, limit: 1 });
    expect(window.content).toBe("const other = 2;");
    expect(window.truncated).toBe(true);
  });

  it("replaces an exact string and refuses an ambiguous one", async () => {
    await fs.writeFile(path.join(root, "dup.ts"), "a();\nb();\na();\n");
    await expect(editTextFile(root, "dup.ts", "a();", "c();")).rejects.toThrow(/appears 2 times/);

    const all = await editTextFile(root, "dup.ts", "a();", "c();", { replaceAll: true });
    expect(all.replacements).toBe(2);
    expect(await fs.readFile(path.join(root, "dup.ts"), "utf8")).toBe("c();\nb();\nc();\n");
  });

  it("refuses an edit whose target text is absent, instead of writing something new", async () => {
    await expect(editTextFile(root, "src/main.ts", "not present", "x")).rejects.toThrow(/was not found/);
  });

  it("creates parent directories on write and reports the bytes written", async () => {
    const result = await writeTextFile(root, "src/new/nested.ts", "export const x = 1;\n");
    expect(result.path).toBe("src/new/nested.ts");
    expect(result.bytesWritten).toBe(20);
    expect(await fs.readFile(path.join(root, "src", "new", "nested.ts"), "utf8")).toContain("export const x");
  });
});

describe("search", () => {
  it("translates the glob syntax people actually type", () => {
    expect(globToRegExp("**/*.ts").test("src/deep/util.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/main.ts")).toBe(true);
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/README.md")).toBe(false);
    expect(globToRegExp("**/*.{js,ts}").test("a/b.js")).toBe(true);
  });

  it("globs the project and skips vendored directories", async () => {
    const matches = await globWorkspace(root, "**/*.ts");
    expect(matches).toEqual(["src/deep/util.ts", "src/main.ts"]);
    expect(await globWorkspace(root, "**/*.js")).toEqual([]);
  });

  it("greps content with line numbers, honouring an include filter", async () => {
    const all = await grepWorkspace(root, "value");
    expect(all.map((match) => match.path).sort()).toEqual(["README.md", "src/deep/util.ts", "src/main.ts"]);
    expect(all.every((match) => match.line > 0)).toBe(true);

    const scoped = await grepWorkspace(root, "value", { include: "src/**/*.ts" });
    expect(scoped.map((match) => match.path).sort()).toEqual(["src/deep/util.ts", "src/main.ts"]);

    const pattern = await grepWorkspace(root, "^export", { regex: true, include: "**/*.ts" });
    expect(pattern).toHaveLength(2);
  });
});

describe("walking and searching concurrently", () => {
  /** A tree wide and deep enough that a level-at-a-time walk actually has something to parallelize. */
  async function tree(base: string): Promise<void> {
    for (let directory = 0; directory < 12; directory += 1) {
      const nested = path.join(base, `pkg-${directory}`, "src");
      await fs.mkdir(nested, { recursive: true });
      for (let file = 0; file < 6; file += 1) {
        await fs.writeFile(path.join(nested, `mod-${file}.ts`), `export const marker = "needle-${directory}-${file}";\n`.repeat(4));
      }
    }
    // Generated output: present, and never searched.
    await fs.mkdir(path.join(base, "coverage"), { recursive: true });
    await fs.writeFile(path.join(base, "coverage", "report.ts"), 'export const marker = "needle-coverage";\n');
    await fs.mkdir(path.join(base, "node_modules", "left-pad"), { recursive: true });
    await fs.writeFile(path.join(base, "node_modules", "left-pad", "index.ts"), 'export const marker = "needle-vendor";\n');
  }

  it("yields the same entries in the same order on every run", async () => {
    // Determinism is the property a concurrent walk most easily loses, and losing it would make
    // glob_files return a different list each call for an unchanged tree.
    await tree(root);
    const runs: string[][] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const seen: string[] = [];
      for await (const entry of walkWorkspace(root)) seen.push(entry.relative);
      runs.push(seen);
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(runs[0].length).toBeGreaterThan(70);
  });

  it("finds every match, in a stable order, and never searches generated output", async () => {
    await tree(root);
    // Above the 200 default, so the assertion is about what the search finds rather than where it stops.
    const first = await grepWorkspace(root, "needle-", { maxResults: 1_000 });
    const second = await grepWorkspace(root, "needle-", { maxResults: 1_000 });
    expect(second).toEqual(first);
    expect(first.length).toBe(12 * 6 * 4);
    expect(first.some((match) => match.path.includes("coverage"))).toBe(false);
    expect(first.some((match) => match.path.includes("node_modules"))).toBe(false);
    // Matches from one file stay together and in line order — the concurrent reads are reassembled
    // in walk order, not completion order.
    const firstFile = first.filter((match) => match.path === first[0].path);
    expect(firstFile.map((match) => match.line)).toEqual([...firstFile.map((match) => match.line)].sort((a, b) => a - b));
  });

  it("truncates at maxResults deterministically", async () => {
    await tree(root);
    const limited = await grepWorkspace(root, "needle-", { maxResults: 7 });
    expect(limited).toHaveLength(7);
    expect(limited).toEqual((await grepWorkspace(root, "needle-", { maxResults: 7 })));
    expect(limited).toEqual((await grepWorkspace(root, "needle-", { maxResults: 1_000 })).slice(0, 7));
  });

  it("still matches a regex query, where the byte prefilter cannot help", async () => {
    await tree(root);
    const found = await grepWorkspace(root, "needle-\\d+-[0-5]", { regex: true, maxResults: 1_000 });
    expect(found.length).toBe(12 * 6 * 4);
  });
});

describe("edit robustness", () => {
  it("inserts newText literally, never expanding $& $$ $' or $` replacement patterns", async () => {
    await fs.writeFile(path.join(root, "price.sh"), "echo PRICE\n");
    await editTextFile(root, "price.sh", "PRICE", "$$5 $& $' $` $1");
    expect(await fs.readFile(path.join(root, "price.sh"), "utf8")).toBe("echo $$5 $& $' $` $1\n");
  });

  it("matches LF oldText in a CRLF file and keeps the file CRLF", async () => {
    await fs.writeFile(path.join(root, "win.ts"), "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n");
    await editTextFile(root, "win.ts", "const a = 1;\nconst b = 2;", "const a = 10;\nconst b = 20;\nconst bb = 21;");
    expect(await fs.readFile(path.join(root, "win.ts"), "utf8")).toBe("const a = 10;\r\nconst b = 20;\r\nconst bb = 21;\r\nconst c = 3;\r\n");
  });

  it("matches CRLF oldText in an LF file and keeps the file LF", async () => {
    await editTextFile(root, "src/main.ts", "export const value = 1;\r\nconst other = 2;", "export const value = 5;\r\nconst other = 6;");
    expect(await fs.readFile(path.join(root, "src", "main.ts"), "utf8")).toBe("export const value = 5;\nconst other = 6;\n");
  });

  it("falls back to a unique trailing-whitespace-insensitive line match", () => {
    const result = applyTextEdits("a  \nb\t\nc\n", [{ oldText: "a\nb", newText: "x\ny" }], "f");
    expect(result).toEqual({ content: "x\ny\nc\n", replacements: 1 });
  });

  it("refuses an ambiguous whitespace-insensitive match", () => {
    expect(() => applyTextEdits("a \nb\na\t\nb\n", [{ oldText: "a\nb", newText: "x" }], "f")).toThrow(/matches 2 places when trailing whitespace is ignored/);
  });

  it("names the nearest similar line when oldText is not found", () => {
    expect(() => applyTextEdits("one\n    const total = price * qty;\nthree\n", [{ oldText: "const total = price * quantity;", newText: "x" }], "f.ts"))
      .toThrow(/oldText was not found in f\.ts\. Closest line is 2: "    const total = price \* qty;"/);
  });

  it("applies several edits in order, all or nothing", async () => {
    const result = await editTextFileWithEdits(root, "src/main.ts", [
      { oldText: "value = 1", newText: "value = 2" },
      { oldText: "value = 2", newText: "value = 3" },
      { oldText: "other", newText: "another" },
    ]);
    expect(result.replacements).toBe(3);
    expect(await fs.readFile(path.join(root, "src", "main.ts"), "utf8")).toBe("export const value = 3;\nconst another = 2;\n");

    await expect(editTextFileWithEdits(root, "src/main.ts", [
      { oldText: "value = 3", newText: "value = 4" },
      { oldText: "missing", newText: "x" },
    ])).rejects.toThrow(/edits\[1\]: oldText was not found/);
    expect(await fs.readFile(path.join(root, "src", "main.ts"), "utf8")).toBe("export const value = 3;\nconst another = 2;\n");
  });

  it("parses the single and the multi-edit argument forms", () => {
    expect(parseEditArguments({ oldText: "a", newText: "b" })).toEqual([{ oldText: "a", newText: "b", replaceAll: false }]);
    expect(parseEditArguments({ edits: JSON.stringify([{ oldText: "a", newText: "b", replaceAll: true }]) })).toEqual([{ oldText: "a", newText: "b", replaceAll: true }]);
    expect(parseEditArguments({ edits: [{ oldText: "a", newText: "b" }] })).toEqual([{ oldText: "a", newText: "b", replaceAll: false }]);
    expect(() => parseEditArguments({ edits: "[]" })).toThrow(/non-empty array/);
    expect(() => parseEditArguments({ edits: "not json" })).toThrow(/JSON array/);
    expect(() => parseEditArguments({ edits: "[]", oldText: "a" })).toThrow(/not both/);
    expect(() => parseEditArguments({ newText: "b" })).toThrow(/oldText must be/);
  });

  it("tracks staleness only for files it has seen", () => {
    const tracker = new FileReadTracker();
    expect(() => tracker.assertFresh("a.ts", "anything")).not.toThrow();
    tracker.record("a.ts", "one");
    expect(() => tracker.assertFresh("a.ts", "one")).not.toThrow();
    expect(() => tracker.assertFresh("a.ts", "two")).toThrow(/changed on disk since it was last read; re-read it/);
  });
});

describe(".gitignore", () => {
  it("parses directories, globs, anchoring and negation", () => {
    const ignored = parseGitignore("# comment\n\n*.log\n!keep.log\nout/\n/top.txt\nsrc/gen/*.ts\n");
    expect(ignored("a.log", false)).toBe(true);
    expect(ignored("deep/b.log", false)).toBe(true);
    expect(ignored("deep/keep.log", false)).toBe(false);
    expect(ignored("out", true)).toBe(true);
    expect(ignored("pkg/out", true)).toBe(true);
    expect(ignored("out", false)).toBe(false);
    expect(ignored("top.txt", false)).toBe(true);
    expect(ignored("sub/top.txt", false)).toBe(false);
    expect(ignored("src/gen/x.ts", false)).toBe(true);
    expect(ignored("src/x.ts", false)).toBe(false);
  });

  it("filters the walk, glob and the JS grep by the root .gitignore", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "generated/\n*.secret\n");
    await fs.mkdir(path.join(root, "generated"), { recursive: true });
    await fs.writeFile(path.join(root, "generated", "out.ts"), "value\n");
    await fs.writeFile(path.join(root, "src", "key.secret"), "value\n");
    const walked: string[] = [];
    for await (const entry of walkWorkspace(root)) walked.push(entry.relative);
    expect(walked).not.toContain("generated");
    expect(walked).not.toContain("generated/out.ts");
    expect(walked).not.toContain("src/key.secret");
    expect(walked).toContain(".gitignore");
    expect(await globWorkspace(root, "**/*")).not.toContain("src/key.secret");
    const matches = await grepWorkspace(root, "value", { ripgrep: null });
    expect(matches.map((match) => match.path)).not.toContain("generated/out.ts");
    expect(matches.map((match) => match.path)).not.toContain("src/key.secret");
    // An empty ignore list (config discovery) sees everything.
    const all: string[] = [];
    for await (const entry of walkWorkspace(root, { ...DEFAULT_WORKSPACE_LIMITS, ignoredDirectories: [] })) all.push(entry.relative);
    expect(all).toContain("generated/out.ts");
  });
});

describe("ripgrep", () => {
  it("parses rg --json match lines into the JS search's result shape", () => {
    const line = JSON.stringify({ type: "match", data: { path: { text: ".\\src\\main.ts" }, lines: { text: "export const value = 1;\r\n" }, line_number: 1, submatches: [] } });
    expect(parseRipgrepJsonLine(line)).toEqual({ path: "src/main.ts", line: 1, text: "export const value = 1;\r" });
    const bytes = JSON.stringify({ type: "match", data: { path: { bytes: Buffer.from("./a.txt").toString("base64") }, lines: { bytes: Buffer.from(`${"x".repeat(500)}\n`).toString("base64") }, line_number: 7 } });
    expect(parseRipgrepJsonLine(bytes)).toEqual({ path: "a.txt", line: 7, text: "x".repeat(400) });
    expect(parseRipgrepJsonLine(JSON.stringify({ type: "begin", data: { path: { text: "a" } } }))).toBeNull();
    expect(parseRipgrepJsonLine("not json")).toBeNull();
  });

  it("builds equivalent arguments", () => {
    const args = ripgrepArguments("a.b", { include: "src/**/*.ts", regex: false, limits: DEFAULT_WORKSPACE_LIMITS });
    expect(args).toEqual(expect.arrayContaining(["--json", "--hidden", "--no-require-git", "--fixed-strings", "--glob", "src/**/*.ts", "!node_modules"]));
    expect(args.slice(-4)).toEqual(["--regexp", "a.b", "--", "."]);
    expect(ripgrepArguments("a.b", { regex: true, limits: DEFAULT_WORKSPACE_LIMITS })).not.toContain("--fixed-strings");
  });

  it("falls back to the JS search when rg cannot run", async () => {
    const viaMissingBinary = await grepWorkspace(root, "value", { ripgrep: path.join(root, "no-such-rg") });
    const viaJs = await grepWorkspace(root, "value", { ripgrep: null });
    expect(viaMissingBinary).toEqual(viaJs);
    expect(viaJs.length).toBeGreaterThan(0);
  });
});
