import { randomBytes } from "node:crypto";
import type { AgentTool } from "../../agent-runtime";
import { ARCHYMEDES_CAPABILITIES } from "../permissions";
import { readTextFile, writeTextFile, WorkspaceViolation } from "../workspace";
import { oneOf, optionalString, requiredString, resolvedLimits, type ExtraToolOptions } from "./shared";

/**
 * Cell-level editing of Jupyter notebooks.
 *
 * `edit_file` on an .ipynb means editing JSON-escaped source by exact string match, which models
 * get wrong constantly (escaped quotes, `\n` inside list items). This edits the cell structure
 * instead and writes the notebook back the way Jupyter does: same indentation, key order, final
 * newline and line endings, every untouched cell and all metadata byte-for-byte the same after a
 * round trip. An edited code cell's outputs and execution count are cleared, because outputs that
 * no longer correspond to the source are worse than no outputs.
 */

type NotebookCell = {
  cell_type: string;
  id?: string;
  metadata?: Record<string, unknown>;
  source: string | string[];
  outputs?: unknown[];
  execution_count?: number | null;
  attachments?: unknown;
  [key: string]: unknown;
};

type Notebook = { cells: NotebookCell[]; nbformat?: number; nbformat_minor?: number; [key: string]: unknown };

export type NotebookOperation = "replace" | "insert" | "delete";

/** nbformat's source convention: a list of lines, each keeping its `\n` except the last. */
export function toSourceLines(source: string): string[] {
  if (source === "") return [];
  const lines = source.split("\n").map((line, index, all) => (index < all.length - 1 ? `${line}\n` : line));
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function sourceText(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source;
}

/** The indentation the file was written with (Jupyter: one space), detected from its second line. */
export function detectJsonIndent(text: string): string | number {
  const match = /^\{\r?\n([ \t]+)"/.exec(text);
  if (!match) return text.trimStart().startsWith("{\n") || text.includes("\n") ? 1 : 0;
  return match[1].startsWith("\t") ? "\t" : match[1].length;
}

export function serializeNotebook(notebook: Notebook, original: string): string {
  const indent = detectJsonIndent(original);
  let text = JSON.stringify(notebook, null, indent);
  if (original.endsWith("\n")) text += "\n";
  if (original.includes("\r\n")) text = text.replace(/\n/g, "\r\n");
  return text;
}

function newCellId(existing: ReadonlySet<string>): string {
  let id = randomBytes(4).toString("hex");
  while (existing.has(id)) id = randomBytes(4).toString("hex");
  return id;
}

/** nbformat 4.5+ requires cell ids; older notebooks must not gain them. */
function usesCellIds(notebook: Notebook): boolean {
  return (notebook.nbformat ?? 4) > 4 || ((notebook.nbformat ?? 4) === 4 && (notebook.nbformat_minor ?? 0) >= 5);
}

function shapeCell(cell: NotebookCell, cellType: "code" | "markdown" | "raw"): void {
  cell.cell_type = cellType;
  if (cellType === "code") {
    cell.execution_count = null;
    cell.outputs = [];
    delete cell.attachments;
  } else {
    delete cell.outputs;
    delete cell.execution_count;
  }
  cell.metadata ??= {};
}

export type NotebookEditRequest = {
  operation: NotebookOperation;
  cellIndex?: number;
  cellId?: string;
  cellType?: "code" | "markdown" | "raw";
  source?: string;
};

export type NotebookEditOutcome = { index: number; cellType: string; cellId?: string; outputsCleared: boolean; totalCells: number };

/** Applies one edit in place. Throws a model-readable message for anything ambiguous or out of range. */
export function applyNotebookEdit(notebook: Notebook, request: NotebookEditRequest): NotebookEditOutcome {
  if (!Array.isArray(notebook.cells)) throw new Error("not a Jupyter notebook: it has no cells array");
  const cells = notebook.cells;
  const ids = new Set(cells.map((cell) => cell.id).filter((id): id is string => typeof id === "string"));

  const locate = (): number => {
    if (request.cellId !== undefined) {
      const index = cells.findIndex((cell) => cell.id === request.cellId);
      if (index === -1) throw new Error(`no cell has id '${request.cellId}'${ids.size === 0 ? " (this notebook has no cell ids; use cell_index)" : ""}`);
      if (request.cellIndex !== undefined && request.cellIndex !== index) throw new Error(`cell_id '${request.cellId}' is cell ${index}, not cell ${request.cellIndex}`);
      return index;
    }
    if (request.cellIndex === undefined) throw new Error("cell_index or cell_id is required");
    if (request.cellIndex >= cells.length) throw new Error(`cell_index ${request.cellIndex} is out of range: the notebook has ${cells.length} cell${cells.length === 1 ? "" : "s"} (0-${cells.length - 1})`);
    return request.cellIndex;
  };

  if (request.operation === "delete") {
    const index = locate();
    const [removed] = cells.splice(index, 1);
    return { index, cellType: removed.cell_type, cellId: removed.id, outputsCleared: false, totalCells: cells.length };
  }

  if (request.source === undefined) throw new Error(`source is required for ${request.operation}`);

  if (request.operation === "replace") {
    const index = locate();
    const cell = cells[index];
    const cellType = request.cellType ?? (cell.cell_type as "code" | "markdown" | "raw");
    const hadOutputs = Array.isArray(cell.outputs) && cell.outputs.length > 0;
    const keepString = typeof cell.source === "string";
    if (cellType !== cell.cell_type || cellType === "code") shapeCell(cell, cellType);
    cell.source = keepString ? request.source : toSourceLines(request.source);
    return { index, cellType, cellId: cell.id, outputsCleared: cellType === "code" && hadOutputs, totalCells: cells.length };
  }

  // insert: at cell_index (before the cell there; == length appends), after cell_id, or at the end.
  let position: number;
  if (request.cellId !== undefined) {
    position = cells.findIndex((cell) => cell.id === request.cellId);
    if (position === -1) throw new Error(`no cell has id '${request.cellId}'`);
    position += 1;
  } else if (request.cellIndex !== undefined) {
    if (request.cellIndex > cells.length) throw new Error(`cell_index ${request.cellIndex} is out of range for insert: use 0-${cells.length}`);
    position = request.cellIndex;
  } else {
    position = cells.length;
  }
  if (!request.cellType) throw new Error("cell_type ('code' or 'markdown') is required for insert");
  const cell: NotebookCell = { cell_type: request.cellType, metadata: {}, source: toSourceLines(request.source) };
  if (usesCellIds(notebook)) cell.id = newCellId(ids);
  shapeCell(cell, request.cellType);
  // Jupyter's own key order, so a later save by Jupyter produces no spurious diff.
  const ordered: NotebookCell = request.cellType === "code"
    ? { cell_type: "code", execution_count: null, ...(cell.id ? { id: cell.id } : {}), metadata: {}, outputs: [], source: cell.source }
    : { cell_type: request.cellType, ...(cell.id ? { id: cell.id } : {}), metadata: {}, source: cell.source };
  cells.splice(position, 0, ordered);
  return { index: position, cellType: request.cellType, cellId: ordered.id, outputsCleared: false, totalCells: cells.length };
}

function optionalCellIndex(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error("cell_index must be a non-negative integer (0-based)");
  return value as number;
}

export function createNotebookTools(options: ExtraToolOptions): AgentTool[] {
  const { root } = options;
  const limits = resolvedLimits(options);
  return [
    {
      name: "notebook_edit",
      description:
        "Edit a .ipynb by cell (cell_index or cell_id): replace, insert (at cell_index, after cell_id, or at the end; needs cell_type) or delete. "
        + "Editing a code cell clears its outputs.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          operation: { type: "string", description: "'replace' (default), 'insert' or 'delete'." },
          cell_index: { type: "integer", description: "0-based." },
          cell_id: { type: "string" },
          cell_type: { type: "string", description: "'code' or 'markdown'." },
          source: { type: "string", description: "Full new cell source." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      capabilityId: ARCHYMEDES_CAPABILITIES.write,
      effect: "workspace",
      requiresApproval: true,
      parallelSafe: false,
      async execute(args) {
        const filePath = requiredString(args.path, "path");
        if (!/\.ipynb$/i.test(filePath)) throw new WorkspaceViolation(`${filePath} is not a .ipynb notebook`);
        const operation = oneOf(args.operation, "operation", ["replace", "insert", "delete"] as const, "replace");
        const cellTypeValue = optionalString(args.cell_type, "cell_type");
        const cellType = cellTypeValue === undefined ? undefined : oneOf(cellTypeValue, "cell_type", ["code", "markdown", "raw"] as const, "code");
        const source = args.source === undefined || args.source === null ? undefined : String(args.source);
        const existing = await readTextFile(root, filePath, { limits });
        let notebook: Notebook;
        try {
          notebook = JSON.parse(existing.content.replace(/^﻿/, "")) as Notebook;
        } catch (error) {
          throw new Error(`${existing.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        const outcome = applyNotebookEdit(notebook, {
          operation,
          cellIndex: optionalCellIndex(args.cell_index),
          cellId: optionalString(args.cell_id, "cell_id"),
          cellType,
          source,
        });
        const written = await writeTextFile(root, filePath, serializeNotebook(notebook, existing.content), limits);
        const verb = operation === "replace" ? "Replaced" : operation === "insert" ? "Inserted" : "Deleted";
        const idNote = outcome.cellId ? ` (id ${outcome.cellId})` : "";
        const cleared = outcome.outputsCleared ? "; cleared its outputs" : "";
        return {
          content: `${verb} ${outcome.cellType} cell ${outcome.index}${idNote} in ${written.path}${cleared}. The notebook now has ${outcome.totalCells} cell${outcome.totalCells === 1 ? "" : "s"}.`,
          data: { path: written.path, operation, ...outcome, cellId: outcome.cellId ?? null },
        };
      },
    },
  ];
}

export { sourceText as notebookCellSource };
