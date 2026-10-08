import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "../../agent-runtime";
import { applyNotebookEdit, createNotebookTools, detectJsonIndent, serializeNotebook, toSourceLines } from "./notebook";

const context = { taskId: "t", runId: "r", stepId: "s" };
let root: string;
let tool: AgentTool;

/** Exactly how Jupyter writes a notebook: indent 1, key order, trailing newline. */
function jupyterText(notebook: unknown): string {
  return `${JSON.stringify(notebook, null, 1)}\n`;
}

function sampleNotebook(minor = 5) {
  return {
    cells: [
      { cell_type: "markdown", id: "intro", metadata: {}, source: ["# Title\n", "Some text"] },
      {
        cell_type: "code",
        execution_count: 3,
        id: "calc",
        metadata: { tags: ["keep"] },
        outputs: [{ name: "stdout", output_type: "stream", text: ["2\n"] }],
        source: ["x = 1\n", "print(x + 1)"],
      },
      { cell_type: "code", execution_count: null, id: "empty", metadata: {}, outputs: [], source: [] },
    ],
    metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python", version: "3.11.0" } },
    nbformat: 4,
    nbformat_minor: minor,
  };
}

async function writeNotebook(name: string, text: string): Promise<string> {
  await fs.writeFile(path.join(root, name), text);
  return name;
}

async function readJson(name: string) {
  return JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-notebook-"));
  [tool] = createNotebookTools({ root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("helpers", () => {
  it("splits source into nbformat lines", () => {
    expect(toSourceLines("a\nb\n")).toEqual(["a\n", "b\n"]);
    expect(toSourceLines("a\nb")).toEqual(["a\n", "b"]);
    expect(toSourceLines("")).toEqual([]);
  });

  it("detects indentation", () => {
    expect(detectJsonIndent('{\n "a": 1\n}')).toBe(1);
    expect(detectJsonIndent('{\n    "a": 1\n}')).toBe(4);
    expect(detectJsonIndent('{\n\t"a": 1\n}')).toBe("\t");
    expect(detectJsonIndent('{"a":1}')).toBe(0);
  });

  it("round-trips a Jupyter-formatted notebook byte for byte", () => {
    const text = jupyterText(sampleNotebook());
    expect(serializeNotebook(JSON.parse(text), text)).toBe(text);
    const crlf = text.replace(/\n/g, "\r\n");
    expect(serializeNotebook(JSON.parse(crlf), crlf)).toBe(crlf);
  });
});

describe("notebook_edit", () => {
  it("is a workspace-writing, approval-gated, serial tool", () => {
    expect(tool).toMatchObject({ name: "notebook_edit", effect: "workspace", requiresApproval: true, parallelSafe: false });
  });

  it("replaces a code cell by index, clearing outputs and keeping metadata and everything else", async () => {
    const original = jupyterText(sampleNotebook());
    const name = await writeNotebook("nb.ipynb", original);
    const result = await tool.execute({ path: name, cell_index: 1, source: "y = 2\nprint(y)\n" }, context);
    expect(result.content).toBe("Replaced code cell 1 (id calc) in nb.ipynb; cleared its outputs. The notebook now has 3 cells.");
    const after = await readJson(name);
    expect(after.cells[1]).toEqual({ cell_type: "code", execution_count: null, id: "calc", metadata: { tags: ["keep"] }, outputs: [], source: ["y = 2\n", "print(y)\n"] });
    expect(after.cells[0]).toEqual(sampleNotebook().cells[0]);
    expect(after.metadata).toEqual(sampleNotebook().metadata);
    // Only the edited cell's lines differ from the original text.
    const expected = sampleNotebook();
    expected.cells[1] = after.cells[1];
    expect(await fs.readFile(path.join(root, name), "utf8")).toBe(jupyterText(expected));
  });

  it("replaces a markdown cell by id without adding outputs", async () => {
    const name = await writeNotebook("nb.ipynb", jupyterText(sampleNotebook()));
    await tool.execute({ path: name, cell_id: "intro", source: "## New" }, context);
    const after = await readJson(name);
    expect(after.cells[0]).toEqual({ cell_type: "markdown", id: "intro", metadata: {}, source: ["## New"] });
  });

  it("changes a cell's type on replace", async () => {
    const name = await writeNotebook("nb.ipynb", jupyterText(sampleNotebook()));
    await tool.execute({ path: name, cell_index: 1, cell_type: "markdown", source: "text" }, context);
    await tool.execute({ path: name, cell_index: 0, cell_type: "code", source: "1 + 1" }, context);
    const after = await readJson(name);
    expect(after.cells[1]).toEqual({ cell_type: "markdown", id: "calc", metadata: { tags: ["keep"] }, source: ["text"] });
    expect(after.cells[0]).toMatchObject({ cell_type: "code", outputs: [], execution_count: null, source: ["1 + 1"] });
  });

  it("inserts at an index, after an id, or at the end, generating ids for nbformat 4.5", async () => {
    const name = await writeNotebook("nb.ipynb", jupyterText(sampleNotebook()));
    const first = await tool.execute({ path: name, operation: "insert", cell_index: 0, cell_type: "markdown", source: "Top" }, context);
    expect(first.content).toMatch(/^Inserted markdown cell 0 \(id [0-9a-f]{8}\) in nb\.ipynb\. The notebook now has 4 cells\.$/);
    await tool.execute({ path: name, operation: "insert", cell_id: "calc", cell_type: "code", source: "after_calc()" }, context);
    await tool.execute({ path: name, operation: "insert", cell_type: "code", source: "last()" }, context);
    const after = await readJson(name);
    expect(after.cells.map((cell: { source: string[] }) => cell.source.join(""))).toEqual(["Top", "# Title\nSome text", "x = 1\nprint(x + 1)", "after_calc()", "", "last()"]);
    expect(Object.keys(after.cells[3])).toEqual(["cell_type", "execution_count", "id", "metadata", "outputs", "source"]);
    expect(new Set(after.cells.map((cell: { id: string }) => cell.id)).size).toBe(6);
  });

  it("does not add ids to an older notebook", async () => {
    const old = sampleNotebook(4);
    for (const cell of old.cells) delete (cell as { id?: string }).id;
    const name = await writeNotebook("old.ipynb", jupyterText(old));
    await tool.execute({ path: name, operation: "insert", cell_type: "code", source: "x" }, context);
    const after = await readJson(name);
    expect(after.cells[3]).toEqual({ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["x"] });
    await expect(tool.execute({ path: name, cell_id: "calc", source: "x" }, context)).rejects.toThrow(/no cell ids; use cell_index/);
  });

  it("deletes a cell", async () => {
    const name = await writeNotebook("nb.ipynb", jupyterText(sampleNotebook()));
    const result = await tool.execute({ path: name, operation: "delete", cell_id: "calc" }, context);
    expect(result.content).toBe("Deleted code cell 1 (id calc) in nb.ipynb. The notebook now has 2 cells.");
    expect((await readJson(name)).cells.map((cell: { id: string }) => cell.id)).toEqual(["intro", "empty"]);
  });

  it("keeps a string-valued source as a string and preserves 4-space indentation", async () => {
    const notebook = { cells: [{ cell_type: "code", execution_count: 1, metadata: {}, outputs: [{ output_type: "stream" }], source: "a = 1" }], metadata: {}, nbformat: 4, nbformat_minor: 2 };
    const text = JSON.stringify(notebook, null, 4);
    const name = await writeNotebook("str.ipynb", text);
    await tool.execute({ path: name, cell_index: 0, source: "a = 2\nb = 3" }, context);
    const written = await fs.readFile(path.join(root, name), "utf8");
    expect(written.endsWith("\n")).toBe(false);
    expect(written).toBe(JSON.stringify({ ...notebook, cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: "a = 2\nb = 3" }] }, null, 4));
  });

  it("rejects out-of-range indexes, unknown ids, missing arguments and bad types", async () => {
    const name = await writeNotebook("nb.ipynb", jupyterText(sampleNotebook()));
    await expect(tool.execute({ path: name, cell_index: 3, source: "x" }, context)).rejects.toThrow(/out of range: the notebook has 3 cells \(0-2\)/);
    await expect(tool.execute({ path: name, operation: "insert", cell_index: 9, cell_type: "code", source: "x" }, context)).rejects.toThrow(/use 0-3/);
    await expect(tool.execute({ path: name, cell_id: "nope", source: "x" }, context)).rejects.toThrow(/no cell has id 'nope'/);
    await expect(tool.execute({ path: name, cell_index: 0 }, context)).rejects.toThrow(/source is required for replace/);
    await expect(tool.execute({ path: name, operation: "insert", source: "x" }, context)).rejects.toThrow(/cell_type .* is required for insert/);
    await expect(tool.execute({ path: name, source: "x" }, context)).rejects.toThrow(/cell_index or cell_id is required/);
    await expect(tool.execute({ path: name, cell_index: -1, source: "x" }, context)).rejects.toThrow(/non-negative/);
    await expect(tool.execute({ path: name, cell_index: 0, cell_type: "sql", source: "x" }, context)).rejects.toThrow(/cell_type must be one of/);
    await expect(tool.execute({ path: name, operation: "move", cell_index: 0 }, context)).rejects.toThrow(/operation must be one of/);
    await expect(tool.execute({ path: name, cell_id: "calc", cell_index: 0, source: "x" }, context)).rejects.toThrow(/is cell 1, not cell 0/);
    // Nothing was written by any failed call.
    expect(await fs.readFile(path.join(root, name), "utf8")).toBe(jupyterText(sampleNotebook()));
  });

  it("refuses non-notebooks, invalid JSON and paths outside the workspace", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "{}");
    await expect(tool.execute({ path: "a.txt", cell_index: 0, source: "x" }, context)).rejects.toThrow(/not a \.ipynb notebook/);
    await fs.writeFile(path.join(root, "bad.ipynb"), "{ not json");
    await expect(tool.execute({ path: "bad.ipynb", cell_index: 0, source: "x" }, context)).rejects.toThrow(/not valid JSON/);
    await fs.writeFile(path.join(root, "nocells.ipynb"), "{}");
    await expect(tool.execute({ path: "nocells.ipynb", cell_index: 0, source: "x" }, context)).rejects.toThrow(/no cells array/);
    await expect(tool.execute({ path: "../escape.ipynb", cell_index: 0, source: "x" }, context)).rejects.toThrow(/escapes the workspace root/);
    await expect(tool.execute({ path: "missing.ipynb", cell_index: 0, source: "x" }, context)).rejects.toThrow(/does not exist/);
  });

  it("applyNotebookEdit works on an in-memory notebook", () => {
    const notebook = sampleNotebook();
    const outcome = applyNotebookEdit(notebook, { operation: "replace", cellIndex: 2, source: "z" });
    expect(outcome).toEqual({ index: 2, cellType: "code", cellId: "empty", outputsCleared: false, totalCells: 3 });
  });
});
