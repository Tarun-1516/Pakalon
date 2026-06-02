/**
 * handlers/index.ts — Registry of specialized query handlers.
 *
 * Each handler exposes a uniform surface (search/fetch/format/health) and a
 * stable id. Consumers (the `search://<handler>/<query>` internal URL scheme,
 * or the agent loop) can look handlers up by id.
 *
 * The web-search chain (D:\pakalon\pakalon-backend\app\web_search\chain.py) is
 * a parallel, lower-precision route: it pages the open web. These handlers
 * drill into a specific data source with structured records.
 */
import { handler as github, type Handler as GithubHandler } from "./github.js";
import { handler as npm, type Handler as NpmHandler } from "./npm.js";
import { handler as arxiv, type Handler as ArxivHandler } from "./arxiv.js";
import { handler as stackOverflow, type Handler as StackOverflowHandler } from "./stack-overflow.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export type HandlerId = "github" | "npm" | "arxiv" | "stack-overflow";

export type AnyHandler = GithubHandler | NpmHandler | ArxivHandler | StackOverflowHandler;

export interface CommonResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  score: number;
  metadata: Record<string, string | number | boolean | string[]>;
}

export interface RegistryEntry<H extends AnyHandler = AnyHandler> {
  id: H["id"];
  label: string;
  handler: H;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: Map<HandlerId, RegistryEntry> = new Map();
const LIST: RegistryEntry[] = [];

function register<H extends AnyHandler>(entry: RegistryEntry<H>): void {
  REGISTRY.set(entry.id as HandlerId, entry as RegistryEntry);
  LIST.push(entry as RegistryEntry);
}

register({ id: github.id, label: github.label, handler: github });
register({ id: npm.id, label: npm.label, handler: npm });
register({ id: arxiv.id, label: arxiv.label, handler: arxiv });
register({ id: stackOverflow.id, label: stackOverflow.label, handler: stackOverflow });

/** Look up a handler by its `id` (e.g. "github"). */
export function getHandler(id: HandlerId): AnyHandler | undefined {
  return REGISTRY.get(id)?.handler;
}

/** List all registered handlers. */
export function listHandlers(): RegistryEntry[] {
  return [...LIST];
}

/**
 * Run a search across one or more handlers and merge the results.
 * - De-duplicates by `id` (within each handler, ids are unique).
 * - Sorts by `score` descending.
 * - Caps each handler at `perHandler` results.
 */
export async function searchAll(
  query: string,
  opts: {
    handlers?: HandlerId[];
    perHandler?: number;
    sortBy?: "score" | "rank";
  } = {},
): Promise<Array<{ handler: HandlerId; result: CommonResult }>> {
  const ids = opts.handlers ?? (Array.from(REGISTRY.keys()) as HandlerId[]);
  const perHandler = opts.perHandler ?? 8;
  const buckets = await Promise.all(
    ids.map(async (id) => {
      const h = REGISTRY.get(id)?.handler;
      if (!h) return [];
      try {
        const results = await (h as AnyHandler).search(query, { limit: perHandler } as never);
        return results.map((r) => ({ handler: id, result: r as CommonResult }));
      } catch {
        return [];
      }
    }),
  );
  const merged = ([] as Array<{ handler: HandlerId; result: CommonResult }>).concat(...buckets);
  const seen = new Set<string>();
  const dedup: Array<{ handler: HandlerId; result: CommonResult }> = [];
  for (const m of merged) {
    const key = `${m.handler}:${m.result.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(m);
  }
  dedup.sort((a, b) => b.result.score - a.result.score);
  return dedup;
}

/** Health check all registered handlers in parallel. */
export async function healthAll(): Promise<Record<HandlerId, { ok: boolean; latencyMs?: number; extras?: unknown }>> {
  const out: Partial<Record<HandlerId, { ok: boolean; latencyMs?: number; extras?: unknown }>> = {};
  await Promise.all(
    Array.from(REGISTRY.entries()).map(async ([id, entry]) => {
      const start = Date.now();
      try {
        const res = await entry.handler.health();
        out[id] = { ok: res.ok, latencyMs: Date.now() - start, extras: res };
      } catch {
        out[id] = { ok: false, latencyMs: Date.now() - start };
      }
    }),
  );
  return out as Record<HandlerId, { ok: boolean; latencyMs?: number; extras?: unknown }>;
}

export { github, npm, arxiv, stackOverflow };
