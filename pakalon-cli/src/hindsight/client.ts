/**
 * Hindsight client — talks to the FastAPI backend's `/hindsight/*` endpoints.
 *
 * Hindsight is a long-term memory system. The CLI stores key observations
 * and recalls them by semantic similarity. The backend (pakalon-backend/app/hindsight)
 * handles SQLite + vector indexing + consolidation; this client is a thin
 * HTTP wrapper around that surface.
 */
import { redactSensitive, sanitizeUnicode } from "@/utils/safe-string.js";
import { backendFetch } from "@/util/backend.js";

export interface HindsightEntry {
  id: string;
  key: string;
  value: string;
  /** Vector embedding (computed server-side, optional in responses). */
  embedding?: number[];
  tags?: string[];
  scope?: "user" | "project" | "session" | "swarm";
  session_id?: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  /** Similarity score on recall. */
  score?: number;
}

export interface HindsightStoreOptions {
  key: string;
  value: string;
  tags?: string[];
  scope?: HindsightEntry["scope"];
  session_id?: string;
  /** ISO duration like "30d" or absolute ms. */
  ttl?: string | number;
  /** Pin to a project (e.g. `git@github.com:org/repo`). */
  project?: string;
}

export interface HindsightRecallOptions {
  query: string;
  top_k?: number;
  scope?: HindsightEntry["scope"];
  session_id?: string;
  tags?: string[];
  min_score?: number;
}

export interface HindsightConsolidateOptions {
  strategy?: "default" | "dedup" | "merge" | "summarize";
  dry_run?: boolean;
  scope?: HindsightEntry["scope"];
}

export class HindsightError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = "hindsight_error") {
    super(redactSensitive(message));
    this.name = "HindsightError";
    this.status = status;
    this.code = code;
  }
}

function unwrap<T>(payload: unknown, fallback: T): T {
  if (payload == null) return fallback;
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as T;
    } catch {
      return fallback;
    }
  }
  return payload as T;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await backendFetch(path, init);
  if (res && typeof res === "object" && "error" in (res as Record<string, unknown>)) {
    const errObj = (res as { error?: string; status?: number }).error ?? "unknown";
    const status = (res as { status?: number }).status ?? 500;
    throw new HindsightError(String(errObj), status);
  }
  return res as T;
}

/** Store a key→value entry. Returns the persisted entry (with id, timestamps). */
export async function store(
  opts: HindsightStoreOptions,
): Promise<HindsightEntry> {
  const body = sanitizeUnicode({
    key: opts.key,
    value: opts.value,
    tags: opts.tags ?? [],
    scope: opts.scope ?? "user",
    session_id: opts.session_id,
    ttl: opts.ttl,
    project: opts.project,
  });
  const res = await call<{ entry: HindsightEntry }>("/hindsight/store", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.entry;
}

/** Recall entries by semantic similarity. Returns top_k entries, sorted by score desc. */
export async function recall(
  opts: HindsightRecallOptions,
): Promise<HindsightEntry[]> {
  const body = sanitizeUnicode({
    query: opts.query,
    top_k: opts.top_k ?? 8,
    scope: opts.scope,
    session_id: opts.session_id,
    tags: opts.tags ?? [],
    min_score: opts.min_score ?? 0.0,
  });
  const res = await call<{ entries: HindsightEntry[] }>("/hindsight/recall", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.entries ?? [];
}

/** Get a single entry by key. */
export async function get(
  key: string,
  scope?: HindsightEntry["scope"],
): Promise<HindsightEntry | undefined> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  const res = await call<{ entry?: HindsightEntry }>(
    `/hindsight/entry/${encodeURIComponent(key)}${qs}`,
  );
  return res.entry;
}

/** Delete a single entry by key. */
export async function remove(
  key: string,
  scope?: HindsightEntry["scope"],
): Promise<boolean> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  const res = await call<{ deleted: boolean }>(
    `/hindsight/entry/${encodeURIComponent(key)}${qs}`,
    { method: "DELETE" },
  );
  return !!res.deleted;
}

/** List entries (no semantic ranking). */
export async function list(
  scope?: HindsightEntry["scope"],
  opts: { limit?: number; cursor?: string; tags?: string[] } = {},
): Promise<{ entries: HindsightEntry[]; next_cursor?: string }> {
  const params = new URLSearchParams();
  if (scope) params.set("scope", scope);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.tags?.length) params.set("tags", opts.tags.join(","));
  return call<{ entries: HindsightEntry[]; next_cursor?: string }>(
    `/hindsight/list?${params.toString()}`,
  );
}

/** Consolidate (dedup, merge, summarize) the entries in a scope. */
export async function consolidate(
  opts: HindsightConsolidateOptions = {},
): Promise<{ removed: number; merged: number; summarized: number }> {
  return call<{ removed: number; merged: number; summarized: number }>(
    "/hindsight/consolidate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        sanitizeUnicode({
          strategy: opts.strategy ?? "default",
          dry_run: opts.dry_run ?? false,
          scope: opts.scope,
        }),
      ),
    },
  );
}

/** Sync Hindsight <-> Mnemopi (the other memory engine). */
export async function syncMnemopi(
  opts: { direction?: "hindsight_to_mnemopi" | "mnemopi_to_hindsight" | "both" } = {},
): Promise<{ transferred: number }> {
  return call<{ transferred: number }>("/hindsight/sync-mnemopi", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ direction: opts.direction ?? "both" }),
  });
}

/** Convenience: a single-line "remember" and a single-line "recall" for tool use. */
export async function remember(
  key: string,
  value: string,
  opts: Omit<HindsightStoreOptions, "key" | "value"> = {},
): Promise<HindsightEntry> {
  return store({ key, value, ...opts });
}

export async function remembered<T = string>(
  query: string,
  top_k = 4,
  scope: HindsightEntry["scope"] = "user",
): Promise<HindsightEntry[]> {
  return recall({ query, top_k, scope });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: pretty-print (used by the `/remember` and `/recall` slash commands)
// ─────────────────────────────────────────────────────────────────────────────

export function formatEntry(e: HindsightEntry): string {
  const tagStr = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
  const scoreStr = typeof e.score === "number" ? ` (score ${e.score.toFixed(3)})` : "";
  return `- ${e.key}${tagStr}${scoreStr}\n  ${e.value}\n  ↳ ${e.created_at}`;
}

export { unwrap as __unwrap };
