/**
 * handlers/stack-overflow.ts — Stack Overflow question search via the public API.
 * GET https://api.stackexchange.com/2.3/search/advanced
 *   ?order=desc&sort=relevance&q={q}&site=stackoverflow&pagesize={n}
 */
import { setTimeout as wait } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StackOverflowResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  score: number;
  metadata: Record<string, string | number | boolean | string[]>;
}

export interface StackOverflowSearchOpts {
  limit?: number;          // 1..20, default 8
  /** "relevance" | "activity" | "votes" | "creation" | "hot" */
  sort?: "relevance" | "activity" | "votes" | "creation" | "hot";
  /** Only show answered questions. */
  answeredOnly?: boolean;
  /** Minimum score. */
  minScore?: number;
  /** Comma-separated tag filter, e.g. "python,fastapi". */
  tagged?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StackOverflowFetchOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Handler {
  id: "stack-overflow";
  label: string;
  search(query: string, opts?: StackOverflowSearchOpts): Promise<StackOverflowResult[]>;
  fetch(id: string, opts?: StackOverflowFetchOpts): Promise<StackOverflowResult | null>;
  format(r: StackOverflowResult): string;
  health(): Promise<{ ok: boolean; quota?: number }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const ENDPOINT = "https://api.stackexchange.com/2.3/search/advanced";
const QUESTIONS_ENDPOINT = "https://api.stackexchange.com/2.3/questions";

async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  const delays = [200, 600, 1800];
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await wait(delays[i] ?? 1800);
    }
  }
  throw lastErr;
}

export const search = async (query: string, opts: StackOverflowSearchOpts = {}): Promise<StackOverflowResult[]> => {
  const limit = Math.max(1, Math.min(20, opts.limit ?? 8));
  const params = new URLSearchParams({
    order: "desc",
    sort: opts.sort ?? "relevance",
    q: query,
    site: "stackoverflow",
    pagesize: String(limit),
  });
  if (opts.answeredOnly) params.set("filter", "!)4 LookoutIlYUb5");
  if (opts.minScore != null) params.set("min", String(opts.minScore));
  if (opts.tagged) params.set("tagged", opts.tagged);
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  const signal = opts.signal ?? ac.signal;
  try {
    const res = await retry(() => fetch(`${ENDPOINT}?${params.toString()}`, {
      signal,
      headers: { accept: "application/json", "accept-encoding": "gzip" },
    }));
    if (!res.ok) throw new Error(`stackoverflow ${res.status}`);
    const data = await res.json() as {
      items?: Array<{
        question_id: number;
        title: string;
        link: string;
        score: number;
        is_answered: boolean;
        answer_count: number;
        view_count: number;
        tags: string[];
        creation_date: number;
        last_activity_date: number;
        owner?: { display_name?: string; reputation?: number; user_id?: number };
        excerpt?: string;
      }>;
      has_more?: boolean;
      quota_remaining?: number;
    };
    return (data.items ?? []).map((it) => ({
      id: String(it.question_id),
      title: decodeHtml(it.title),
      url: it.link,
      snippet: it.excerpt ? decodeHtml(it.excerpt) : "",
      score: it.score,
      metadata: {
        isAnswered: it.is_answered,
        answerCount: it.answer_count,
        viewCount: it.view_count,
        tags: it.tags,
        author: it.owner?.display_name ?? "",
        authorRep: it.owner?.reputation ?? 0,
        createdAt: new Date(it.creation_date * 1000).toISOString(),
        lastActivity: new Date(it.last_activity_date * 1000).toISOString(),
      },
    }));
  } finally {
    clearTimeout(timeout);
  }
};

export const fetch = async (id: string, opts: StackOverflowFetchOpts = {}): Promise<StackOverflowResult | null> => {
  if (!/^\d+$/.test(id)) return null;
  const url = `${QUESTIONS_ENDPOINT}/${id}?order=desc&sort=activity&site=stackoverflow&filter=withbody`;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await retry(() => fetch(url, { signal: ac.signal, headers: { accept: "application/json" } }));
    if (!res.ok) return null;
    const data = await res.json() as { items?: Array<{
      question_id: number; title: string; link: string; body: string; score: number;
      is_answered: boolean; answer_count: number; view_count: number; tags: string[];
      creation_date: number; last_activity_date: number;
      owner?: { display_name?: string; reputation?: number };
    }> };
    const it = (data.items ?? [])[0];
    if (!it) return null;
    return {
      id: String(it.question_id),
      title: decodeHtml(it.title),
      url: it.link,
      snippet: decodeHtml(it.body).slice(0, 800),
      score: it.score,
      metadata: {
        isAnswered: it.is_answered,
        answerCount: it.answer_count,
        viewCount: it.view_count,
        tags: it.tags,
        author: it.owner?.display_name ?? "",
        authorRep: it.owner?.reputation ?? 0,
        createdAt: new Date(it.creation_date * 1000).toISOString(),
        lastActivity: new Date(it.last_activity_date * 1000).toISOString(),
      },
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

export const format = (r: StackOverflowResult): string => {
  const lines = [
    `### [so] ${r.title}`,
    r.url,
  ];
  if (r.snippet) lines.push("", r.snippet);
  const meta = Object.entries(r.metadata)
    .filter(([k, v]) => v !== "" && v !== false && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `  - ${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
  if (meta) lines.push("", meta);
  return lines.join("\n");
};

export const health = async (): Promise<{ ok: boolean; quota?: number }> => {
  try {
    const res = await fetch(`${ENDPOINT}?order=desc&sort=relevance&q=test&site=stackoverflow&pagesize=1`, {
      signal: AbortSignal.timeout(5_000),
    });
    const data = await res.json() as { quota_remaining?: number };
    return { ok: res.ok, quota: data.quota_remaining };
  } catch {
    return { ok: false };
  }
};

function decodeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export const handler: Handler = { id: "stack-overflow", label: "Stack Overflow", search, fetch, format, health };
