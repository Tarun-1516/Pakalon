/**
 * hashline/encode.ts — content-hash edit anchors.
 *
 * Replaces the `LINE#HASH` edit anchor format used by some Aider-like tools.
 * Each line is annotated with a short hash of its current contents. The AI can
 * then refer to a specific line by `LINE#HASH` (e.g. `42#a3f9`) and the
 * client verifies the hash before applying an edit. This catches stale
 * references (the file changed under us) and broken edits (the AI miscopied
 * the hash).
 *
 * The format is intentionally compact:
 *   - Hash: 4 hex chars (16 bits) — collision probability per 10K line file ≈ 1.5e-4
 *   - 8 hex chars available via `encodeLineAnchor8` for higher-stakes edits
 *
 * No external deps.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Hashing primitives
// ---------------------------------------------------------------------------

/**
 * Compute the anchor hash for one line.
 *
 * The hash is the first 2 bytes of SHA-1(line) → 4 hex chars. (SHA-1 is used
 * for its tiny output; we only need uniqueness within a file, not collision
 * resistance. SHA-1's collision flaws don't apply here.)
 */
export function lineHash(line: string, bytes = 2): string {
  const buf = createHash("sha1").update(line, "utf8").digest();
  return buf.subarray(0, bytes).toString("hex");
}

/** 4-char anchor — fast, compact, fits in `42#a3f9`. */
export function lineHash4(line: string): string {
  return lineHash(line, 2);
}

/** 8-char anchor — for high-stakes single-line edits. */
export function lineHash8(line: string): string {
  return lineHash(line, 4);
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export interface AnnotatedLine {
  /** 1-based line number. */
  lineno: number;
  /** Original line content (no newline). */
  text: string;
  /** 4-char content hash. */
  hash: string;
  /** 8-char content hash (only when `with8` is true). */
  hash8?: string;
}

export interface EncodeOptions {
  /** Whether to also compute 8-char hashes (slower). */
  with8?: boolean;
  /** Skip blank lines. */
  skipBlank?: boolean;
  /** Skip hash for blank lines. */
  hashBlank?: boolean;
}

/**
 * Encode a block of text into line-anchored form.
 *
 * @example
 *   const lines = encodeLines("a\nb\nc");
 *   // → [
 *   //   { lineno: 1, text: "a", hash: "86be" },
 *   //   { lineno: 2, text: "b", hash: "a17a" },
 *   //   { lineno: 3, text: "c", hash: "84a9" }
 *   // ]
 */
export function encodeLines(content: string, opts: EncodeOptions = {}): AnnotatedLine[] {
  const { with8 = false, skipBlank = false, hashBlank = true } = opts;
  const raw = splitLines(content);
  const out: AnnotatedLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i] ?? "";
    if (skipBlank && text.trim() === "") continue;
    const isBlank = text.trim() === "";
    const h = !hashBlank && isBlank ? "" : lineHash4(text);
    out.push(with8 ? { lineno: i + 1, text, hash: h, hash8: lineHash8(text) } : { lineno: i + 1, text, hash: h });
  }
  return out;
}

/**
 * Render line annotations as a single string for inclusion in a prompt.
 *
 * Default format: `  42#a3f9  return x + 1;`
 * When `with8` is true, both hashes are emitted: `  42#a3f9#4a7e109b  return x + 1;`
 */
export interface RenderOptions extends EncodeOptions {
  /** When true, also emit 8-char hashes. */
  with8?: boolean;
  /** Include the line text after the anchor. */
  withText?: boolean;
  /** Minimum line number width (zero-padded). */
  linenoWidth?: number;
}

export function renderAnnotated(
  content: string,
  opts: RenderOptions = {},
): string {
  const lines = encodeLines(content, opts);
  const width = opts.linenoWidth ?? Math.max(3, String(lines.at(-1)?.lineno ?? 0).length);
  const sep = "  ";
  return lines
    .map((l) => {
      const ln = String(l.lineno).padStart(width, " ");
      const anchor = opts.with8 ? `${l.hash}#${l.hash8 ?? ""}` : l.hash;
      const text = opts.withText === false ? "" : `${sep}${l.text}`;
      return `${ln}#${anchor}${text}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Decoding / verification
// ---------------------------------------------------------------------------

/**
 * Parse a single anchor reference like `42#a3f9` or `42#a3f9#4a7e109b`.
 * Returns null if malformed.
 */
export function parseAnchor(ref: string): { lineno: number; hash: string; hash8?: string } | null {
  const m = ref.match(/^(\d+)(?:#([0-9a-f]{4}))?(?:#([0-9a-f]{8}))?$/i);
  if (!m) return null;
  const lineno = Number(m[1]);
  const hash = m[2] ?? "";
  const hash8 = m[3];
  if (lineno < 1) return null;
  if (!hash) return null;
  return { lineno, hash, hash8 };
}

export type VerifyStatus = "ok" | "hash-mismatch" | "line-missing" | "no-anchor" | "line-empty";

export interface VerifyResult {
  status: VerifyStatus;
  lineno: number;
  expected: string;
  actual?: string;
  text?: string;
}

/**
 * Verify that an anchor matches the line at `lineno` in `content`.
 * Returns a structured result; never throws.
 */
export function verifyAnchor(content: string, anchor: string, opts: { require8?: boolean } = {}): VerifyResult {
  const parsed = parseAnchor(anchor);
  if (!parsed) {
    return { status: "no-anchor", lineno: 0, expected: "" };
  }
  const lines = splitLines(content);
  const idx = parsed.lineno - 1;
  if (idx < 0 || idx >= lines.length) {
    return { status: "line-missing", lineno: parsed.lineno, expected: parsed.hash };
  }
  const text = lines[idx] ?? "";
  const actual = lineHash4(text);
  if (actual !== parsed.hash) {
    return { status: "hash-mismatch", lineno: parsed.lineno, expected: parsed.hash, actual, text };
  }
  if (opts.require8 && parsed.hash8) {
    const actual8 = lineHash8(text);
    if (actual8 !== parsed.hash8) {
      return { status: "hash-mismatch", lineno: parsed.lineno, expected: parsed.hash8, actual: actual8, text };
    }
  }
  return { status: "ok", lineno: parsed.lineno, expected: parsed.hash, actual, text };
}

// ---------------------------------------------------------------------------
// Edit application
// ---------------------------------------------------------------------------

export interface LineEdit {
  /** `LINE#HASH` reference. */
  anchor: string;
  /** Replacement text. Use empty string to delete the line. */
  newText: string;
}

export interface ApplyResult {
  /** New content. */
  content: string;
  /** Per-edit verification results. */
  results: VerifyResult[];
  /** True if every edit passed verification and was applied. */
  ok: boolean;
  /** Number of edits skipped because verification failed. */
  skipped: number;
}

/**
 * Apply a list of line-anchored edits to `content`.
 *
 * - All edits are verified; failing edits are skipped (no partial application).
 * - When two edits target the same line, the second wins (last-writer).
 * - Edits are applied bottom-up so earlier line numbers stay stable.
 * - The new line for an edit is itself re-hashed and may cascade.
 */
export function applyLineEdits(
  content: string,
  edits: LineEdit[],
  opts: { require8?: boolean } = {},
): ApplyResult {
  const lines = splitLines(content);
  const sorted = [...edits]
    .map((e) => ({ edit: e, parsed: parseAnchor(e.anchor) }))
    .filter((e): e is { edit: LineEdit; parsed: NonNullable<ReturnType<typeof parseAnchor>> } => e.parsed !== null)
    .sort((a, b) => b.parsed.lineno - a.parsed.lineno);

  const results: VerifyResult[] = [];
  let skipped = 0;
  for (const { edit, parsed } of sorted) {
    const v = verifyAnchor(content, edit.anchor, opts);
    results.push(v);
    if (v.status !== "ok") {
      skipped++;
      continue;
    }
    const idx = parsed.lineno - 1;
    if (idx < 0 || idx >= lines.length) {
      skipped++;
      continue;
    }
    // Replace / insert: split newText on newlines; if multi-line, splice in.
    const pieces = splitLines(edit.newText);
    if (pieces.length === 0) {
      lines.splice(idx, 1);
    } else if (pieces.length === 1) {
      lines[idx] = pieces[0] ?? "";
    } else {
      lines.splice(idx, 1, ...pieces);
    }
  }
  return { content: lines.join("\n"), results, ok: skipped === 0, skipped };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Split a block of text into lines, preserving content of each line.
 * Drops a single trailing empty entry created by a final newline.
 */
export function splitLines(content: string): string[] {
  if (content === "") return [""];
  const out = content.split("\n");
  if (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}
