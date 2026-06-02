/**
 * Static prompt template loader.
 *
 * Loads `.md` files from `src/prompts/` (or a custom root) and renders them
 * with simple Mustache-like syntax:
 *   - `{{var}}` — substitution
 *   - `{{{var}}}` or `{{& var}}` — raw substitution (no HTML escape)
 *   - `{{#if cond}}…{{/if}}` — conditional
 *   - `{{#unless cond}}…{{/unless}}` — inverted conditional
 *   - `{{#each items}}…{{/each}}` — iterate an array (current item is `{{this}}` and `{{@index}}`)
 *   - `{{#each items as item}}…{{/each}}` — same, with named binding
 *   - `{{!-- comment --}}` — stripped
 *
 * Two loading modes:
 *   1. **Build-time** — Bun import-attribute:
 *        `import base from "./base.md" with { type: "text" };`
 *      This works in Bun 1.1+ and emits a build-time copy.
 *   2. **Runtime** — `loadPromptFile(path)` reads the file on first use and
 *      caches it. Used as a fallback for environments that don't support
 *      the import attribute, and for the `~/.config/pakalon/prompts/`
 *      override directory.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { sanitizeUnicode } from "@/utils/safe-string.js";

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter + content
// ─────────────────────────────────────────────────────────────────────────────

export interface PromptFrontmatter {
  name?: string;
  description?: string;
  /** Default model id to use. */
  model?: string;
  /** Approximate token cost hint (for budgeting). */
  tokens?: number;
  /** Tags for filtering. */
  tags?: string[];
  /** Free-form variables with default values. */
  defaults?: Record<string, string | number | boolean>;
  /** Free-form extra metadata. */
  [key: string]: unknown;
}

export interface ParsedPrompt {
  frontmatter: PromptFrontmatter;
  body: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// YAML-ish frontmatter parser (no external dep)
// ─────────────────────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export function parsePrompt(raw: string): ParsedPrompt {
  const trimmed = raw.replace(/^\uFEFF/, "");
  const match = FRONTMATTER_RE.exec(trimmed);
  if (!match) return { frontmatter: {}, body: trimmed };
  const [, fmText, body] = match;
  return { frontmatter: parseFrontmatter(fmText), body };
}

function parseFrontmatter(text: string): PromptFrontmatter {
  const out: PromptFrontmatter = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colon).trim();
    let value: string | string[] | Record<string, string> = line
      .slice(colon + 1)
      .trim();
    // Strip optional surrounding quotes
    if (
      typeof value === "string" &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "") {
      // Multi-line block — collect indented lines
      const block: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next.match(/^\s+-\s/)) {
          // YAML list
          const list: string[] = [];
          while (i < lines.length && lines[i].match(/^\s+-\s/)) {
            list.push(lines[i].replace(/^\s+-\s+/, ""));
            i++;
          }
          out[key] = list;
          continue;
        }
        if (next.match(/^\s+\S/)) {
          block.push(next.replace(/^\s+/, ""));
          i++;
          continue;
        }
        break;
      }
      if (block.length) {
        // Try to parse as object (key: value)
        const obj: Record<string, string> = {};
        let isObj = true;
        for (const ln of block) {
          const c = ln.indexOf(":");
          if (c === -1) {
            isObj = false;
            break;
          }
          obj[ln.slice(0, c).trim()] = ln.slice(c + 1).trim();
        }
        out[key] = isObj && Object.keys(obj).length ? obj : block.join("\n");
      }
      continue;
    }
    // Single value
    if (typeof value === "string") {
      // Coerce booleans / numbers
      if (value === "true") out[key] = true;
      else if (value === "false") out[key] = false;
      else if (/^-?\d+$/.test(value)) out[key] = Number(value);
      else if (/^-?\d+\.\d+$/.test(value)) out[key] = Number(value);
      else out[key] = value;
    } else {
      out[key] = value;
    }
    i++;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderContext {
  /** Variables used for `{{var}}` substitution. */
  vars: Record<string, unknown>;
  /** Optional helper that gets called for `{{#helper arg}}…{{/helper}}` blocks. */
  helpers?: Record<
    string,
    (
      args: string,
      content: string,
      ctx: RenderContext,
    ) => string | Promise<string>
  >;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

function toStringValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function isTruthy(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 0 && v !== "false" && v !== "0";
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function lookupVar(name: string, ctx: RenderContext): unknown {
  if (name === ".") return ctx.vars;
  const trimmed = name.trim();
  if (trimmed === "") return undefined;
  // Support dotted paths: `user.name`
  const parts = trimmed.split(".");
  let cur: any = ctx.vars;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (p === "@key" && cur && typeof cur === "object" && !Array.isArray(cur)) {
      // ignored
    }
    cur = cur[p];
  }
  return cur;
}

interface Token {
  type: "text" | "var" | "raw" | "if" | "unless" | "each" | "end" | "comment";
  raw: string;
  expr: string;
  body: Token[];
  /** For `each` with `as`. */
  binding?: string;
  /** True for `{{#each items}}` (no alias). */
  hasAlias: boolean;
  /** Inner text content for blocks. */
  text?: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let buf = "";
  const flushText = () => {
    if (buf) {
      tokens.push({ type: "text", raw: buf, expr: "", body: [], hasAlias: false });
      buf = "";
    }
  };
  while (i < src.length) {
    if (src.startsWith("{{", i)) {
      // Find closing }}
      const close = src.indexOf("}}", i + 2);
      if (close === -1) {
        buf += src[i++];
        continue;
      }
      let inner = src.slice(i + 2, close).trim();
      // Skip triple-stash {{{...}}}
      if (inner.startsWith("{") && inner.endsWith("}")) {
        inner = inner.slice(1, -1).trim();
      }
      flushText();
      if (inner.startsWith("!--")) {
        // {{!-- comment --}}
        tokens.push({ type: "comment", raw: inner, expr: "", body: [], hasAlias: false });
      } else if (inner.startsWith("#if ")) {
        tokens.push({ type: "if", raw: inner, expr: inner.slice(3).trim(), body: [], hasAlias: false });
      } else if (inner.startsWith("#unless ")) {
        tokens.push({ type: "unless", raw: inner, expr: inner.slice(8).trim(), body: [], hasAlias: false });
      } else if (inner.startsWith("#each ")) {
        // {{#each items}} OR {{#each items as item}}
        const expr = inner.slice(6).trim();
        const m = /^(.+?)\s+as\s+(\S+)$/.exec(expr);
        tokens.push({
          type: "each",
          raw: inner,
          expr: m ? m[1].trim() : expr,
          body: [],
          binding: m ? m[2] : undefined,
          hasAlias: !!m,
        });
      } else if (inner === "/if" || inner === "/unless" || inner === "/each") {
        tokens.push({ type: "end", raw: inner, expr: inner, body: [], hasAlias: false });
      } else if (inner.startsWith("& ")) {
        tokens.push({ type: "raw", raw: inner, expr: inner.slice(2).trim(), body: [], hasAlias: false });
      } else {
        tokens.push({ type: "var", raw: inner, expr: inner, body: [], hasAlias: false });
      }
      i = close + 2;
    } else {
      buf += src[i++];
    }
  }
  flushText();
  return tokens;
}

function pair(tokens: Token[]): Token[] {
  const out: Token[] = [];
  const stack: Token[] = [];
  for (const tok of tokens) {
    if (tok.type === "if" || tok.type === "unless" || tok.type === "each") {
      stack.push(tok);
      out.push(tok);
      continue;
    }
    if (tok.type === "end") {
      const top = stack.pop();
      if (!top) {
        throw new RenderError(`Unexpected {{${tok.expr}}} — no open block`, 0);
      }
      continue;
    }
    if (stack.length > 0) {
      stack[stack.length - 1].body.push(tok);
    } else {
      out.push(tok);
    }
  }
  // Attach bodies (we already pushed tokens into top.body as we walked).
  return out;
}

export class RenderError extends Error {
  constructor(message: string, public position: number) {
    super(message);
    this.name = "RenderError";
  }
}

export function render(template: string, ctx: RenderContext): string {
  const tokens = pair(tokenize(template));
  let pos = 0;
  return renderTokens(tokens, ctx, () => pos++);
}

function renderTokens(
  tokens: Token[],
  ctx: RenderContext,
  _advance: () => number,
): string {
  let out = "";
  for (const tok of tokens) {
    switch (tok.type) {
      case "text":
        out += tok.raw;
        break;
      case "comment":
        break;
      case "var": {
        const v = lookupVar(tok.expr, ctx);
        out += escapeHtml(toStringValue(v));
        break;
      }
      case "raw": {
        const v = lookupVar(tok.expr, ctx);
        out += toStringValue(v);
        break;
      }
      case "if": {
        const v = lookupVar(tok.expr, ctx);
        if (isTruthy(v)) {
          out += renderTokens(tok.body, ctx, _advance);
        }
        break;
      }
      case "unless": {
        const v = lookupVar(tok.expr, ctx);
        if (!isTruthy(v)) {
          out += renderTokens(tok.body, ctx, _advance);
        }
        break;
      }
      case "each": {
        const v = lookupVar(tok.expr, ctx);
        if (Array.isArray(v)) {
          for (let idx = 0; idx < v.length; idx++) {
            const itemCtx: RenderContext = {
              ...ctx,
              vars: {
                ...ctx.vars,
                [tok.binding ?? "this"]: v[idx],
                "@index": idx,
                "@first": idx === 0,
                "@last": idx === v.length - 1,
              },
            };
            out += renderTokens(tok.body, itemCtx, _advance);
          }
        } else if (v && typeof v === "object") {
          // Iterate object keys
          const entries = Object.entries(v as Record<string, unknown>);
          for (let idx = 0; idx < entries.length; idx++) {
            const [k, val] = entries[idx];
            const itemCtx: RenderContext = {
              ...ctx,
              vars: {
                ...ctx.vars,
                [tok.binding ?? "this"]: val,
                "@key": k,
                "@index": idx,
                "@first": idx === 0,
                "@last": idx === entries.length - 1,
              },
            };
            out += renderTokens(tok.body, itemCtx, _advance);
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// File loader
// ─────────────────────────────────────────────────────────────────────────────

const PROMPTS_ROOT_HINTS = [
  // Pkg-relative (compiled) – bun's import.meta.resolve isn't always available, so we walk.
  () => {
    try {
      const url = import.meta.url;
      if (url.startsWith("file:")) {
        return join(dirname(fileURLToPath(url)), ".");
      }
    } catch {
      // ignore
    }
    return undefined;
  },
  () => resolve(process.cwd(), "src/prompts"),
  () => resolve(homedir(), ".config/pakalon/prompts"),
];

function findPromptsRoot(): string | undefined {
  for (const hint of PROMPTS_ROOT_HINTS) {
    try {
      const p = hint();
      if (!p) continue;
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return undefined;
}

export interface LoadOptions {
  /** Override the prompts root. */
  root?: string;
  /** Override a single file path. */
  filePath?: string;
  /** Encoding (default "utf-8"). */
  encoding?: BufferEncoding;
}

const fileCache = new Map<string, string>();

export async function loadPromptFile(filePath: string): Promise<string> {
  const cached = fileCache.get(filePath);
  if (cached != null) return cached;
  const text = await readFile(filePath, "utf-8");
  fileCache.set(filePath, text);
  return text;
}

/** Read a prompt by name (e.g. "base", "agent", "safety") from the prompts root. */
export async function loadPromptByName(
  name: string,
  opts: LoadOptions = {},
): Promise<ParsedPrompt> {
  const root = opts.root ?? findPromptsRoot();
  if (!root && !opts.filePath) {
    throw new RenderError(
      `Could not locate prompts/ root. Pass { root: "/abs/path" } or { filePath: "/abs/path.md" }.`,
      0,
    );
  }
  const path = opts.filePath
    ? opts.filePath
    : isAbsolute(name)
    ? name
    : join(root!, `${name}.md`);
  const raw = await loadPromptFile(path);
  return parsePrompt(sanitizeUnicode(raw));
}

/** Render a prompt by name with the given vars. */
export async function renderPrompt(
  name: string,
  vars: Record<string, unknown> = {},
  opts: LoadOptions = {},
): Promise<{ frontmatter: PromptFrontmatter; rendered: string }> {
  const { frontmatter, body } = await loadPromptByName(name, opts);
  // Merge defaults into vars
  const merged: Record<string, unknown> = { ...(frontmatter.defaults ?? {}) };
  for (const [k, v] of Object.entries(vars)) merged[k] = v;
  const ctx: RenderContext = { vars: merged };
  return { frontmatter, rendered: render(body, ctx) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Common helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Compose multiple prompt parts into one (each part is rendered separately then joined). */
export async function composePrompts(
  names: string[],
  vars: Record<string, unknown>,
  opts: LoadOptions = {},
  joiner = "\n\n---\n\n",
): Promise<string> {
  const parts: string[] = [];
  for (const name of names) {
    const { rendered } = await renderPrompt(name, vars, opts);
    parts.push(rendered);
  }
  return parts.join(joiner);
}

/** Invalidate the file cache (used in tests). */
export function clearPromptCache(): void {
  fileCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundled prompt manifest (used by `pakalon prompts list`)
// ─────────────────────────────────────────────────────────────────────────────

export const BUILTIN_PROMPTS = [
  "base",
  "agent",
  "plan",
  "edit",
  "review",
  "safety",
  "tools",
  "compact-summary",
  "pr-review",
  "doc-gen",
] as const;

export type BuiltinPromptName = (typeof BUILTIN_PROMPTS)[number];
