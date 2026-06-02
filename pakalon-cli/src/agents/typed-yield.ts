/**
 * agents/typed-yield.ts — schema-validated subagent output.
 *
 * Subagents (`/review`, `/audit`, phase runners) emit structured findings.
 * Without validation the downstream consumers have to trust the shape.
 * `typed-yield` registers a Zod schema per `name` and gates every emit
 * through it; bad payloads fail loudly.
 *
 * Storage: `~/.config/pakalon/yields/<name>/<id>.json` (one file per yield).
 * The index file (`<name>/_index.json`) records the latest N yields for
 * quick listing without scanning the directory.
 *
 * Designed to plug into the existing `agents/orchestrator.ts` and
 * `agents/review.ts` — see `BUILTIN_YIELDS` for examples.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z, type ZodTypeAny } from "zod";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface RegistryEntry<T extends ZodTypeAny> {
  name: string;
  schema: T;
  description: string;
  /** Max retained yields on disk per `name`. Older ones are pruned. */
  maxRetained: number;
}

const REGISTRY = new Map<string, RegistryEntry<ZodTypeAny>>();

/**
 * Register a yield type.
 *
 * @example
 *   defineYield("review.findings", z.array(z.object({
 *     path: z.string(),
 *     severity: z.enum(["P0", "P1", "P2", "P3"]),
 *     message: z.string(),
 *   })).default([]), { description: "Review findings array" });
 */
export function defineYield<T extends ZodTypeAny>(
  name: string,
  schema: T,
  opts: { description?: string; maxRetained?: number } = {},
): void {
  REGISTRY.set(name, {
    name,
    schema,
    description: opts.description ?? "",
    maxRetained: opts.maxRetained ?? 200,
  });
}

export function getSchema(name: string): ZodTypeAny | undefined {
  return REGISTRY.get(name)?.schema;
}

export function listYields(): Array<{ name: string; description: string; count: number }> {
  const out: Array<{ name: string; description: string; count: number }> = [];
  for (const [name, entry] of REGISTRY) {
    out.push({ name, description: entry.description, count: entry.maxRetained });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Zod-inferred type for a registered yield. */
export type YieldOf<Name extends string> = Name extends keyof typeof REGISTRY
  ? z.infer<(typeof REGISTRY)[Name]["schema"]>
  : unknown;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function yieldsRoot(): string {
  const base = process.env["PAKALON_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "pakalon");
  const dir = path.join(base, "yields");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function yieldDir(name: string): string {
  const dir = path.join(yieldsRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(name: string): string {
  return path.join(yieldDir(name), "_index.json");
}

interface IndexEntry {
  id: string;
  createdAt: string;
  summary?: string;
}

function readIndex(name: string): IndexEntry[] {
  try {
    return JSON.parse(fs.readFileSync(indexPath(name), "utf-8")) as IndexEntry[];
  } catch {
    return [];
  }
}

function writeIndex(name: string, entries: IndexEntry[]): void {
  fs.writeFileSync(indexPath(name), JSON.stringify(entries, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SubmitResult<T> {
  ok: boolean;
  id?: string;
  value?: T;
  error?: string;
}

/** Validate and persist a yield. */
export function submitYield<T>(name: string, value: unknown): SubmitResult<T> {
  const entry = REGISTRY.get(name);
  if (!entry) return { ok: false, error: `unknown yield: ${name}` };
  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    };
  }
  const id = randomUUID();
  const file = path.join(yieldDir(name), `${id}.json`);
  const record = {
    id,
    name,
    createdAt: new Date().toISOString(),
    value: parsed.data,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf-8");
  // Update index (newest first), enforce maxRetained.
  const idx = readIndex(name);
  idx.unshift({ id, createdAt: record.createdAt, summary: yieldSummary(name, parsed.data) });
  while (idx.length > entry.maxRetained) {
    const dropped = idx.pop();
    if (dropped) {
      try { fs.unlinkSync(path.join(yieldDir(name), `${dropped.id}.json`)); } catch { /* ignore */ }
    }
  }
  writeIndex(name, idx);
  return { ok: true, id, value: parsed.data as T };
}

/** Read a specific yield by id. */
export function readYield<T = unknown>(name: string, id: string): T | null {
  try {
    const file = path.join(yieldDir(name), `${id}.json`);
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** List the latest yields for `name`. */
export function listYieldsFor(name: string, opts: { limit?: number } = {}): IndexEntry[] {
  const idx = readIndex(name);
  return idx.slice(0, opts.limit ?? 50);
}

/** Read the latest yield. */
export function readLatestYield<T = unknown>(name: string): T | null {
  const idx = readIndex(name);
  const first = idx[0];
  if (!first) return null;
  return readYield<T>(name, first.id);
}

/** Delete a specific yield. */
export function deleteYield(name: string, id: string): boolean {
  try {
    fs.unlinkSync(path.join(yieldDir(name), `${id}.json`));
    const idx = readIndex(name).filter((e) => e.id !== id);
    writeIndex(name, idx);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function yieldSummary(name: string, value: unknown): string {
  if (name === "review.findings" && Array.isArray(value)) {
    return `${value.length} finding(s)`;
  }
  if (name === "audit.summary" && value && typeof value === "object") {
    const v = value as { score?: number; pass?: boolean; findings?: number };
    return `score=${v.score ?? "?"} pass=${v.pass ?? "?"} findings=${v.findings ?? "?"}`;
  }
  if (Array.isArray(value)) return `${value.length} item(s)`;
  return typeof value === "string" ? value.slice(0, 80) : "";
}

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

defineYield(
  "review.findings",
  z.array(
    z.object({
      path: z.string(),
      severity: z.enum(["P0", "P1", "P2", "P3"]),
      message: z.string(),
      line: z.number().int().nonnegative().optional(),
    }),
  ),
  { description: "Review findings emitted by /review and PR reviewers", maxRetained: 200 },
);

defineYield(
  "audit.summary",
  z.object({
    score: z.number().min(0).max(100),
    pass: z.boolean(),
    findings: z.number().int().nonnegative(),
    categories: z.record(z.string(), z.number()).optional(),
  }),
  { description: "Audit run summary (SAST/DAST/secrets/etc.)", maxRetained: 100 },
);

defineYield(
  "phase.complete",
  z.object({
    phase: z.number().int().min(1).max(6),
    durationMs: z.number().int().nonnegative(),
    filesTouched: z.number().int().nonnegative(),
    errors: z.array(z.string()).default([]),
  }),
  { description: "Per-phase 6-phase pipeline completion record", maxRetained: 50 },
);
