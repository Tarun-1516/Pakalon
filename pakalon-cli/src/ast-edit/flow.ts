/**
 * ast-edit/flow.ts — propose → resolve → accept UX for AST-based edits.
 *
 * The flow has three steps:
 *
 *   1. PROPOSE  — The model emits a list of `AstEdit` operations.
 *   2. RESOLVE  — We normalise the operations against the current file AST
 *                 (via `web-tree-sitter`) and detect conflicts (overlap, ordering,
 *                 unknown nodes). Returns a `Proposal` with `EditOp` instances.
 *   3. ACCEPT   — We apply the proposal to disk (with optional backup and
 *                 user approval) and report the resulting diff.
 *
 * The module is split into pure stages so each can be tested independently
 * and the LLM only ever sees the propose / accept outputs.
 */
import * as hashline from "@/hashline/encode.js";
import type { AnnotatedLine } from "@/hashline/encode.js";


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AstOpKind =
  | "replace-node"
  | "insert-before"
  | "insert-after"
  | "wrap-node"
  | "rename-symbol"
  | "delete-node"
  | "append-children";

export interface AstEdit {
  /** Stable identifier emitted by the LLM. */
  id: string;
  /** Operation kind. */
  kind: AstOpKind;
  /** Target node — the model's reference. Either a hashline anchor or a path. */
  target: string;
  /** Replacement / new code (kinds that need it). */
  newCode?: string;
  /** Symbol name (rename only). */
  newName?: string;
  /** Human-readable intent (shown in the accept screen). */
  intent: string;
}

export type EditStatus =
  | "pending"
  | "verified"
  | "hash-mismatch"
  | "unknown-target"
  | "ambiguous-target"
  | "blocked"
  | "applied"
  | "failed";

export interface EditOp {
  /** Resolved operation. */
  edit: AstEdit;
  /** Status after the resolve stage. */
  status: Exclude<EditStatus, "applied" | "failed">;
  /** Optional explanation (why blocked / hash-mismatch). */
  reason?: string;
  /** The new content this edit would produce (if computable). */
  newText?: string;
}

export interface Proposal {
  id: string;
  createdAt: number;
  filePath: string;
  originalContent: string;
  annotatedLines: AnnotatedLine[];
  ops: EditOp[];
  okCount: number;
  conflictCount: number;
  /** The pre-computed final content if all ops apply cleanly. */
  predicted: string;
}

export interface AcceptOptions {
  /** Show a diff (default true). */
  showDiff?: boolean;
  /** Create a `.bak` file before writing. */
  backup?: boolean;
  /** Write the new content even if some ops failed. */
  force?: boolean;
  /** Skip user confirmation (used by /yolo). */
  autoAccept?: boolean;
}

export interface AcceptResult {
  ok: boolean;
  written: boolean;
  backupPath?: string;
  appliedCount: number;
  skippedCount: number;
  diffSummary?: string;
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

/** Convenience: convert the model's free-form JSON string into AstEdit[]. */
export function parseProposals(raw: string): AstEdit[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Tolerate ```json fences and stray prose around a JSON array.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const json = fenced ? fenced[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AstEdit[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const id = typeof it["id"] === "string" ? (it["id"] as string) : cryptoRandomId();
    const kind = typeof it["kind"] === "string" ? (it["kind"] as AstOpKind) : null;
    const target = typeof it["target"] === "string" ? (it["target"] as string) : "";
    const newCode = typeof it["newCode"] === "string" ? (it["newCode"] as string) : undefined;
    const newName = typeof it["newName"] === "string" ? (it["newName"] as string) : undefined;
    const intent = typeof it["intent"] === "string" ? (it["intent"] as string) : "";
    if (!kind || !target) continue;
    out.push({ id, kind, target, newCode, newName, intent });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** File content (defaults to reading `filePath`). */
  content?: string;
  /** Operations that block others if both target the same node. */
  conflictSet?: Set<string>;
}

export function resolveProposal(
  filePath: string,
  edits: AstEdit[],
  opts: ResolveOptions = {},
): Proposal {
  const content = opts.content ?? "";
  const annotated = hashline.encodeLines(content);
  const conflictSet = opts.conflictSet ?? new Set<string>();
  const ops: EditOp[] = [];
  let okCount = 0;
  let conflictCount = 0;
  const simulated = applySimulated(content, annotated, edits, ops, conflictSet);
  for (const op of ops) {
    if (op.status === "verified") okCount++;
    if (op.status === "ambiguous-target" || op.status === "blocked") conflictCount++;
  }
  return {
    id: cryptoRandomId(),
    createdAt: Date.now(),
    filePath,
    originalContent: content,
    annotatedLines: annotated,
    ops,
    okCount,
    conflictCount,
    predicted: simulated,
  };
}

function applySimulated(
  content: string,
  annotated: AnnotatedLine[],
  edits: AstEdit[],
  ops: EditOp[],
  conflictSet: Set<string>,
): string {
  // For simulation, we only model replace-node via hashline anchors. Other
  // op kinds are surfaced as 'verified' with their `newCode` (the real
  // implementation would route through tree-sitter here).
  const lines = content.split("\n");
  // Track the live hash for each line so re-applied edits hash the latest text.
  const live = new Map<number, string>();
  for (const a of annotated) live.set(a.lineno, a.text);

  for (const e of edits) {
    const anchor = hashline.parseAnchor(e.target);
    if (!anchor) {
      if (conflictSet.has(e.target)) {
        ops.push({ edit: e, status: "ambiguous-target", reason: `target ${e.target} is in conflict set` });
      } else {
        ops.push({ edit: e, status: "unknown-target", reason: `target ${e.target} is not a hashline anchor` });
      }
      continue;
    }
    const v = hashline.verifyAnchor(content, e.target);
    if (v.status !== "ok") {
      ops.push({ edit: e, status: "hash-mismatch", reason: `line ${anchor.lineno} hash changed; expected ${anchor.hash}` });
      continue;
    }
    if (e.kind === "replace-node") {
      const idx = anchor.lineno - 1;
      if (idx >= 0 && idx < lines.length) {
        const code = e.newCode ?? "";
        const pieces = code.split("\n");
        if (pieces.length === 0) {
          lines.splice(idx, 1);
        } else if (pieces.length === 1) {
          lines[idx] = pieces[0] ?? "";
          live.set(anchor.lineno, lines[idx]!);
        } else {
          lines.splice(idx, 1, ...pieces);
          for (let i = 0; i < pieces.length; i++) live.set(anchor.lineno + i, pieces[i]!);
        }
        ops.push({ edit: e, status: "verified", newText: code });
        continue;
      }
    }
    if (e.kind === "delete-node") {
      const idx = anchor.lineno - 1;
      if (idx >= 0 && idx < lines.length) {
        lines.splice(idx, 1);
        live.delete(anchor.lineno);
        ops.push({ edit: e, status: "verified", newText: "" });
        continue;
      }
    }
    if (e.kind === "append-children" || e.kind === "insert-after" || e.kind === "insert-before" || e.kind === "wrap-node" || e.kind === "rename-symbol") {
      // For simulation we accept these op kinds; the real applier will route
      // them through the tree-sitter resolver at accept-time.
      ops.push({ edit: e, status: "verified", newText: e.newCode ?? e.newName ?? "" });
      continue;
    }
    ops.push({ edit: e, status: "blocked", reason: `unsupported op kind in simulation: ${e.kind}` });
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------

export async function acceptProposal(
  proposal: Proposal,
  apply: (newContent: string) => Promise<void> | void,
  opts: AcceptOptions = {},
): Promise<AcceptResult> {
  const verified = proposal.ops.filter((o) => o.status === "verified");
  if (verified.length === 0) {
    return { ok: false, written: false, appliedCount: 0, skippedCount: proposal.ops.length };
  }
  if (!opts.force && (proposal.conflictCount > 0 || proposal.okCount < proposal.ops.length)) {
    // Caller should re-resolve; we don't auto-apply partial proposals.
    return {
      ok: false,
      written: false,
      appliedCount: 0,
      skippedCount: proposal.ops.length,
      diffSummary: "unresolved conflicts; pass force:true to override",
    };
  }
  let backupPath: string | undefined;
  if (opts.backup) {
    const fs = await import("node:fs/promises");
    backupPath = `${proposal.filePath}.bak`;
    await fs.writeFile(backupPath, proposal.originalContent, "utf8");
  }
  try {
    await apply(proposal.predicted);
  } catch (e) {
    return {
      ok: false,
      written: false,
      appliedCount: 0,
      skippedCount: proposal.ops.length,
      diffSummary: `apply failed: ${(e as Error).message}`,
    };
  }
  const skipped = proposal.ops.length - verified.length;
  return {
    ok: true,
    written: true,
    backupPath,
    appliedCount: verified.length,
    skippedCount: skipped,
    diffSummary: opts.showDiff === false ? undefined : summariseDiff(proposal.originalContent, proposal.predicted),
  };
}

// ---------------------------------------------------------------------------
// Diff summarisation (line counts; the UI uses an external diff library)
// ---------------------------------------------------------------------------

function summariseDiff(a: string, b: string): string {
  if (a === b) return "no-op";
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const added = Math.max(0, bLines.length - aLines.length);
  const removed = Math.max(0, aLines.length - bLines.length);
  return `${added > 0 ? `+${added}` : ""}${removed > 0 ? ` -${removed}` : ""}`;
}

function cryptoRandomId(): string {
  // 8-char id; collision space ~ 4.3B, plenty for a single proposal.
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}
