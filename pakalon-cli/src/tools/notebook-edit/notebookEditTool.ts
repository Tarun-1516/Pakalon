/**
 * Fully-featured Notebook Edit Tool for Pakalon CLI
 *
 * Jupyter notebook (.ipynb) editing with parity to claude_source_code's NotebookEditTool.
 *
 * Operations:
 *   create   – create a new empty notebook
 *   edit     – edit a cell (code: replace/insert_at_line/delete_lines/append; markdown: replace/append_section)
 *   delete   – delete one or more cells by index
 *   reorder  – move a cell from one index to another
 *   replace_all – replace the source of every cell matching a regex pattern
 *
 * Guarantees:
 *   - Atomic writes (temp file + rename)
 *   - Preserves cell IDs, execution counts, metadata, outputs
 *   - Validates notebook structure (throws clear errors)
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { z } from "zod";
import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotebookCellOutput {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  name?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NotebookCell {
  id?: string;
  cell_type: "code" | "markdown" | "raw";
  source: string[];
  metadata: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: NotebookCellOutput[];
}

export interface NotebookMetadata {
  kernelspec?: {
    display_name: string;
    language: string;
    name: string;
  };
  language_info?: {
    name: string;
    version?: string;
    mimetype?: string;
    file_extension?: string;
  };
  [key: string]: unknown;
}

export interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: NotebookMetadata;
  cells: NotebookCell[];
}

// Cell-level edit operations for code cells
export interface CodeCellEditReplace {
  operation: "replace";
  source: string;
}

export interface CodeCellEditInsertAtLine {
  operation: "insert_at_line";
  line: number;
  source: string;
}

export interface CodeCellEditDeleteLines {
  operation: "delete_lines";
  start_line: number;
  end_line: number;
}

export interface CodeCellEditAppend {
  operation: "append";
  source: string;
}

export type CodeCellEdit =
  | CodeCellEditReplace
  | CodeCellEditInsertAtLine
  | CodeCellEditDeleteLines
  | CodeCellEditAppend;

// Cell-level edit operations for markdown cells
export interface MarkdownCellEditReplace {
  operation: "replace";
  source: string;
}

export interface MarkdownCellEditAppendSection {
  operation: "append_section";
  source: string;
}

export type MarkdownCellEdit = MarkdownCellEditReplace | MarkdownCellEditAppendSection;

export type CellEdit = CodeCellEdit | MarkdownCellEdit;

// Top-level operation schemas
export interface NotebookCreateOp {
  operation: "create";
  notebook_path: string;
  kernel?: { name: string; display_name: string; language: string };
}

export interface NotebookEditOp {
  operation: "edit";
  notebook_path: string;
  cell_index: number;
  cell_edit: CellEdit;
}

export interface NotebookDeleteOp {
  operation: "delete";
  notebook_path: string;
  cell_indices: number[];
}

export interface NotebookReorderOp {
  operation: "reorder";
  notebook_path: string;
  old_index: number;
  new_index: number;
}

export interface NotebookReplaceAllOp {
  operation: "replace_all";
  notebook_path: string;
  find_pattern: string;
  replacement: string;
  flags?: string;
  cell_type?: "code" | "markdown" | "raw";
}

export type NotebookOperation =
  | NotebookCreateOp
  | NotebookEditOp
  | NotebookDeleteOp
  | NotebookReorderOp
  | NotebookReplaceAllOp;

export interface NotebookEditResult {
  success: boolean;
  operation: string;
  notebook_path: string;
  cell_count?: number;
  details?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Zod schemas for the tool input
// ---------------------------------------------------------------------------

const cellEditSchema = z.union([
  z.object({
    operation: z.literal("replace"),
    source: z.string().describe("New full source for the cell"),
  }),
  z.object({
    operation: z.literal("insert_at_line"),
    line: z.number().describe("Line number (0-based) at which to insert"),
    source: z.string().describe("Source to insert"),
  }),
  z.object({
    operation: z.literal("delete_lines"),
    start_line: z.number().describe("Start line (0-based, inclusive)"),
    end_line: z.number().describe("End line (0-based, exclusive)"),
  }),
  z.object({
    operation: z.literal("append"),
    source: z.string().describe("Source to append to end of cell"),
  }),
  z.object({
    operation: z.literal("replace"),
    source: z.string().describe("New full source for the cell"),
  }),
  z.object({
    operation: z.literal("append_section"),
    source: z.string().describe("Markdown section to append"),
  }),
]);

export const notebookEditToolSchema = z.object({
  operation: z.enum(["create", "edit", "delete", "reorder", "replace_all"])
    .describe("Operation to perform on the notebook"),
  notebook_path: z.string().describe("Path to the .ipynb notebook file"),
  kernel: z.object({
    name: z.string().default("python3"),
    display_name: z.string().default("Python 3"),
    language: z.string().default("python"),
  }).optional().describe("Kernel spec (only used for create)"),
  cell_index: z.number().optional()
    .describe("0-based cell index (for edit)"),
  cell_edit: cellEditSchema.optional()
    .describe("Cell-level edit payload (for edit operation)"),
  cell_indices: z.array(z.number()).optional()
    .describe("Array of 0-based cell indices to delete (for delete operation)"),
  old_index: z.number().optional()
    .describe("Current index of cell to move (for reorder)"),
  new_index: z.number().optional()
    .describe("Target index for the cell (for reorder)"),
  find_pattern: z.string().optional()
    .describe("Regex pattern to match in cell source (for replace_all)"),
  replacement: z.string().optional()
    .describe("Replacement string (for replace_all)"),
  flags: z.string().optional()
    .describe("Regex flags, e.g. 'gi' (for replace_all)"),
  cell_type: z.enum(["code", "markdown", "raw"]).optional()
    .describe("Filter by cell type (for replace_all)"),
});

export type NotebookEditToolInput = z.infer<typeof notebookEditToolSchema>;

// ---------------------------------------------------------------------------
// Notebook parser / serializer
// ---------------------------------------------------------------------------

/**
 * Normalize cell source to a single string.
 */
function normalizeSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source;
}

/**
 * Convert a source string to the array-of-lines format used in .ipynb files.
 * Each element keeps its trailing newline except the last.
 */
function sourceToArray(source: string): string[] {
  if (source.length === 0) return [""];
  const lines = source.split(/(?<=\n)/);
  // Remove trailing empty string from split if source ended with \n
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Parse a .ipynb file from disk.
 */
export async function readNotebook(filePath: string): Promise<Notebook> {
  const abs = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read notebook: ${abs} — ${err instanceof Error ? err.message : String(err)}`);
  }

  let notebook: Notebook;
  try {
    notebook = JSON.parse(raw) as Notebook;
  } catch {
    throw new Error(`Invalid JSON in notebook: ${abs}`);
  }

  validateNotebookStructure(notebook, abs);
  return notebook;
}

/**
 * Validate that the parsed object has the expected .ipynb structure.
 */
function validateNotebookStructure(nb: Notebook, filePath: string): void {
  if (typeof nb !== "object" || nb === null) {
    throw new Error(`Malformed notebook: ${filePath} — root is not an object`);
  }
  if (typeof nb.nbformat !== "number") {
    throw new Error(`Malformed notebook: ${filePath} — missing or invalid nbformat`);
  }
  if (!Array.isArray(nb.cells)) {
    throw new Error(`Malformed notebook: ${filePath} — missing or non-array cells`);
  }
  if (typeof nb.metadata !== "object" || nb.metadata === null) {
    throw new Error(`Malformed notebook: ${filePath} — missing or invalid metadata`);
  }

  for (let i = 0; i < nb.cells.length; i++) {
    const cell = nb.cells[i];
    if (!cell || typeof cell !== "object") {
      throw new Error(`Malformed notebook: ${filePath} — cell ${i} is not an object`);
    }
    if (!["code", "markdown", "raw"].includes(cell.cell_type)) {
      throw new Error(
        `Malformed notebook: ${filePath} — cell ${i} has invalid cell_type "${cell.cell_type}"`
      );
    }
    if (!Array.isArray(cell.source)) {
      throw new Error(
        `Malformed notebook: ${filePath} — cell ${i} has non-array source`
      );
    }
  }
}

/**
 * Write a notebook to disk atomically (temp file + rename).
 */
export async function writeNotebookAtomic(filePath: string, notebook: Notebook): Promise<void> {
  const abs = path.resolve(filePath);
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });

  const content = JSON.stringify(notebook, null, 1) + "\n";
  const tmpPath = path.join(dir, `.notebook-edit-${Date.now()}-${process.pid}.tmp`);

  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, abs);
  } catch (err) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tmpPath).catch(() => {});
    } catch {
      // ignore cleanup errors
    }
    throw new Error(`Failed to write notebook: ${abs} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Notebook creation
// ---------------------------------------------------------------------------

export function createEmptyNotebook(
  kernel?: { name: string; display_name: string; language: string }
): Notebook {
  const k = kernel ?? { name: "python3", display_name: "Python 3", language: "python" };
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: k.display_name,
        language: k.language,
        name: k.name,
      },
      language_info: {
        name: k.language,
      },
    },
    cells: [],
  };
}

// ---------------------------------------------------------------------------
// Cell operations
// ---------------------------------------------------------------------------

/**
 * Get a cell by index, supporting negative indexing.
 */
function getCell(notebook: Notebook, index: number): NotebookCell {
  const idx = index < 0 ? notebook.cells.length + index : index;
  if (idx < 0 || idx >= notebook.cells.length) {
    throw new Error(
      `Cell index ${index} out of range (notebook has ${notebook.cells.length} cells)`
    );
  }
  return notebook.cells[idx]!;
}

function getCellIndex(notebook: Notebook, index: number): number {
  const idx = index < 0 ? notebook.cells.length + index : index;
  if (idx < 0 || idx >= notebook.cells.length) {
    throw new Error(
      `Cell index ${index} out of range (notebook has ${notebook.cells.length} cells)`
    );
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Code cell edit operations
// ---------------------------------------------------------------------------

function applyCodeCellEdit(cell: NotebookCell, edit: CodeCellEdit): void {
  const currentSource = normalizeSource(cell.source);

  switch (edit.operation) {
    case "replace": {
      cell.source = sourceToArray(edit.source);
      // Preserve cell IDs, metadata, execution_count, outputs
      break;
    }
    case "insert_at_line": {
      const lines = currentSource.split("\n");
      const insertAt = Math.max(0, Math.min(edit.line, lines.length));
      const newLines = edit.source.split("\n");
      lines.splice(insertAt, 0, ...newLines);
      cell.source = sourceToArray(lines.join("\n"));
      break;
    }
    case "delete_lines": {
      const lines = currentSource.split("\n");
      const start = Math.max(0, edit.start_line);
      const end = Math.min(lines.length, edit.end_line);
      if (start >= end) break;
      lines.splice(start, end - start);
      cell.source = sourceToArray(lines.join("\n"));
      break;
    }
    case "append": {
      const separator = currentSource.endsWith("\n") ? "" : "\n";
      cell.source = sourceToArray(currentSource + separator + edit.source);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown cell edit operations
// ---------------------------------------------------------------------------

function applyMarkdownCellEdit(cell: NotebookCell, edit: MarkdownCellEdit): void {
  const currentSource = normalizeSource(cell.source);

  switch (edit.operation) {
    case "replace": {
      cell.source = sourceToArray(edit.source);
      break;
    }
    case "append_section": {
      const separator = currentSource.endsWith("\n") ? "" : "\n\n";
      cell.source = sourceToArray(currentSource + separator + edit.source);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level operation handlers
// ---------------------------------------------------------------------------

async function handleCreate(op: NotebookCreateOp): Promise<NotebookEditResult> {
  const notebook = createEmptyNotebook(op.kernel);
  await writeNotebookAtomic(op.notebook_path, notebook);
  return {
    success: true,
    operation: "create",
    notebook_path: op.notebook_path,
    cell_count: 0,
    details: `Created new notebook with kernel ${notebook.metadata.kernelspec?.name ?? "python3"}`,
  };
}

async function handleEdit(op: NotebookEditOp): Promise<NotebookEditResult> {
  const notebook = await readNotebook(op.notebook_path);
  const idx = getCellIndex(notebook, op.cell_index);
  const cell = notebook.cells[idx]!;

  if (!op.cell_edit) {
    throw new Error("cell_edit is required for edit operation");
  }

  const cellType = cell.cell_type;
  const editOp = op.cell_edit;

  // Dispatch based on cell type
  if (cellType === "code") {
    // Validate code cell edit operations
    const validCodeOps = ["replace", "insert_at_line", "delete_lines", "append"];
    if (!validCodeOps.includes(editOp.operation)) {
      throw new Error(
        `Invalid code cell edit operation "${editOp.operation}". Valid: ${validCodeOps.join(", ")}`
      );
    }
    applyCodeCellEdit(cell, editOp as CodeCellEdit);
  } else if (cellType === "markdown") {
    // Validate markdown cell edit operations
    const validMdOps = ["replace", "append_section"];
    if (!validMdOps.includes(editOp.operation)) {
      throw new Error(
        `Invalid markdown cell edit operation "${editOp.operation}". Valid: ${validMdOps.join(", ")}`
      );
    }
    applyMarkdownCellEdit(cell, editOp as MarkdownCellEdit);
  } else {
    // raw cells only support replace
    if (editOp.operation !== "replace") {
      throw new Error(`Raw cells only support "replace" operation, got "${editOp.operation}"`);
    }
    cell.source = sourceToArray((editOp as { source: string }).source);
  }

  await writeNotebookAtomic(op.notebook_path, notebook);
  return {
    success: true,
    operation: "edit",
    notebook_path: op.notebook_path,
    cell_count: notebook.cells.length,
    details: `Edited cell ${idx} (${cellType}) using ${editOp.operation}`,
  };
}

async function handleDelete(op: NotebookDeleteOp): Promise<NotebookEditResult> {
  const notebook = await readNotebook(op.notebook_path);

  if (!op.cell_indices || op.cell_indices.length === 0) {
    throw new Error("cell_indices is required for delete operation");
  }

  // Sort indices descending so we remove from the end first
  const sorted = [...op.cell_indices]
    .map((i) => getCellIndex(notebook, i))
    .sort((a, b) => b - a);

  // Check for duplicates
  const unique = new Set(sorted);
  if (unique.size !== sorted.length) {
    throw new Error("Duplicate cell indices in delete operation");
  }

  const deletedCount = sorted.length;
  for (const idx of sorted) {
    notebook.cells.splice(idx, 1);
  }

  await writeNotebookAtomic(op.notebook_path, notebook);
  return {
    success: true,
    operation: "delete",
    notebook_path: op.notebook_path,
    cell_count: notebook.cells.length,
    details: `Deleted ${deletedCount} cell(s)`,
  };
}

async function handleReorder(op: NotebookReorderOp): Promise<NotebookEditResult> {
  const notebook = await readNotebook(op.notebook_path);
  const fromIdx = getCellIndex(notebook, op.old_index);
  let toIdx = op.new_index < 0 ? notebook.cells.length + op.new_index : op.new_index;

  if (toIdx < 0 || toIdx >= notebook.cells.length) {
    throw new Error(
      `new_index ${op.new_index} out of range (notebook has ${notebook.cells.length} cells)`
    );
  }

  const [cell] = notebook.cells.splice(fromIdx, 1);
  // Adjust toIdx if we removed an element before it
  if (fromIdx < toIdx) toIdx--;
  notebook.cells.splice(toIdx, 0, cell!);

  await writeNotebookAtomic(op.notebook_path, notebook);
  return {
    success: true,
    operation: "reorder",
    notebook_path: op.notebook_path,
    cell_count: notebook.cells.length,
    details: `Moved cell from index ${fromIdx} to ${toIdx}`,
  };
}

async function handleReplaceAll(op: NotebookReplaceAllOp): Promise<NotebookEditResult> {
  const notebook = await readNotebook(op.notebook_path);

  if (!op.find_pattern) {
    throw new Error("find_pattern is required for replace_all operation");
  }
  if (op.replacement === undefined) {
    throw new Error("replacement is required for replace_all operation");
  }

  let regex: RegExp;
  try {
    regex = new RegExp(op.find_pattern, op.flags);
  } catch (err) {
    throw new Error(
      `Invalid regex: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let matchCount = 0;

  for (const cell of notebook.cells) {
    // Filter by cell_type if specified
    if (op.cell_type && cell.cell_type !== op.cell_type) continue;

    const source = normalizeSource(cell.source);
    if (!regex.test(source)) continue;

    // Reset lastIndex after test
    regex.lastIndex = 0;
    const newSource = source.replace(regex, op.replacement);
    if (newSource !== source) {
      matchCount++;
      cell.source = sourceToArray(newSource);
    }
  }

  await writeNotebookAtomic(op.notebook_path, notebook);
  return {
    success: true,
    operation: "replace_all",
    notebook_path: op.notebook_path,
    cell_count: notebook.cells.length,
    details: `Replaced pattern in ${matchCount} cell(s)`,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function executeNotebookEdit(
  input: NotebookEditToolInput
): Promise<NotebookEditResult> {
  try {
    switch (input.operation) {
      case "create":
        return await handleCreate({
          operation: "create",
          notebook_path: input.notebook_path,
          kernel: input.kernel,
        });
      case "edit":
        return await handleEdit({
          operation: "edit",
          notebook_path: input.notebook_path,
          cell_index: input.cell_index ?? 0,
          cell_edit: input.cell_edit!,
        });
      case "delete":
        return await handleDelete({
          operation: "delete",
          notebook_path: input.notebook_path,
          cell_indices: input.cell_indices ?? [],
        });
      case "reorder":
        return await handleReorder({
          operation: "reorder",
          notebook_path: input.notebook_path,
          old_index: input.old_index ?? 0,
          new_index: input.new_index ?? 0,
        });
      case "replace_all":
        return await handleReplaceAll({
          operation: "replace_all",
          notebook_path: input.notebook_path,
          find_pattern: input.find_pattern ?? "",
          replacement: input.replacement ?? "",
          flags: input.flags,
          cell_type: input.cell_type,
        });
      default:
        return {
          success: false,
          operation: "unknown",
          notebook_path: input.notebook_path,
          error: `Unknown operation: ${String(input.operation)}`,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[notebook-edit] ${msg}`);
    return {
      success: false,
      operation: input.operation,
      notebook_path: input.notebook_path,
      error: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool definition (ToolDefinition format for the registry)
// ---------------------------------------------------------------------------

export const notebookEditToolDefinition = {
  name: "notebook_edit",
  description:
    "Create, edit, delete, reorder, and bulk-replace cells in Jupyter Notebook (.ipynb) files. " +
    "Supports code, markdown, and raw cell types. Code cells support line-level edits " +
    "(replace, insert_at_line, delete_lines, append). Markdown cells support replace and append_section. " +
    "All operations are atomic (temp file + rename). Preserves cell IDs, execution counts, metadata, and outputs.",
  parameters: notebookEditToolSchema,
  requiresPermission: true,

  async execute(input: NotebookEditToolInput): Promise<NotebookEditResult> {
    return executeNotebookEdit(input);
  },
};

// ---------------------------------------------------------------------------
// Backward-compatible exports (re-export from parent module for index.ts)
// ---------------------------------------------------------------------------

export {
  readNotebook as readNotebookCompat,
  writeNotebookAtomic as writeNotebookCompat,
  createEmptyNotebook as createNotebookCompat,
};
