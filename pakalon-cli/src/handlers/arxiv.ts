/**
 * handlers/arxiv.ts — arXiv paper search via the public Atom feed.
 * GET http://export.arxiv.org/api/query?search_query=...&start=...&max_results=...
 * No XML deps; tiny inline Atom reader.
 */
import { setTimeout as wait } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArxivResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  score: number;
  metadata: Record<string, string | string[]>;
}

export interface ArxivSearchOpts {
  limit?: number;          // 1..20, default 8
  /** "all" | "title" | "abstract" | "author" — default "all" */
  field?: "all" | "title" | "abstract" | "author";
  /** Optional category filter, e.g. "cs.AI", "cs.CL". */
  category?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ArxivFetchOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Handler {
  id: "arxiv";
  label: string;
  search(query: string, opts?: ArxivSearchOpts): Promise<ArxivResult[]>;
  fetch(id: string, opts?: ArxivFetchOpts): Promise<ArxivResult | null>;
  format(r: ArxivResult): string;
  health(): Promise<{ ok: boolean }>;
}

// ---------------------------------------------------------------------------
// Atom (XML) reader
// ---------------------------------------------------------------------------

interface ParsedEntry {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  updated: string;
  link: string;
  categories: string[];
  primaryCategory: string;
}

function readTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decode(m[1] ?? "") : "";
}

function readAttr(xml: string, tag: string, attr: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]+)"`, "i"));
  return m ? decode(m[1] ?? "") : "";
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAtom(feed: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(feed)) !== null) {
    const body = m[1] ?? "";
    const id = readTag(body, "id");
    const linkMatch = body.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"/i)
      ?? body.match(/<link[^>]*href="([^"]+)"/i);
    const link = linkMatch ? decode(linkMatch[1] ?? "") : "";
    const cats: string[] = [];
    let primary = "";
    const catRe = /<category[^>]*term="([^"]+)"[^>]*/gi;
    let cm: RegExpExecArray | null;
    while ((cm = catRe.exec(body)) !== null) {
      const term = decode(cm[1] ?? "");
      cats.push(term);
      if (cm[0].includes('primary="true"')) primary = term;
    }
    const authors: string[] = [];
    const authRe = /<author>\s*<name>([\s\S]*?)<\/name>/gi;
    let am: RegExpExecArray | null;
    while ((am = authRe.exec(body)) !== null) {
      authors.push(decode(am[1] ?? ""));
    }
    out.push({
      id,
      title: readTag(body, "title"),
      summary: readTag(body, "summary"),
      authors,
      published: readTag(body, "published"),
      updated: readTag(body, "updated"),
      link,
      categories: cats,
      primaryCategory: primary,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const ENDPOINT = "http://export.arxiv.org/api/query";

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

export const search = async (query: string, opts: ArxivSearchOpts = {}): Promise<ArxivResult[]> => {
  const limit = Math.max(1, Math.min(20, opts.limit ?? 8));
  const field = opts.field ?? "all";
  const fieldMap: Record<string, string> = {
    all: "all",
    title: "ti",
    abstract: "abs",
    author: "au",
  };
  const cat = opts.category ? ` AND cat:${opts.category}` : "";
  const searchQuery = `${fieldMap[field]}:${query.replace(/["']/g, "")}${cat}`;
  const url = `${ENDPOINT}?search_query=${encodeURIComponent(searchQuery)}&start=0&max_results=${limit}&sortBy=relevance&sortOrder=descending`;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  const signal = opts.signal ?? ac.signal;
  try {
    const res = await retry(() => fetch(url, { signal, headers: { accept: "application/atom+xml" } }));
    if (!res.ok) throw new Error(`arxiv ${res.status}`);
    const xml = await res.text();
    const entries = parseAtom(xml);
    return entries.map((e) => ({
      id: e.id,
      title: e.title,
      url: e.link || e.id,
      snippet: e.summary.slice(0, 320),
      score: 0,
      metadata: {
        authors: e.authors,
        primaryCategory: e.primaryCategory,
        categories: e.categories,
        published: e.published,
        updated: e.updated,
      },
    }));
  } finally {
    clearTimeout(timeout);
  }
};

export const fetch = async (id: string, opts: ArxivFetchOpts = {}): Promise<ArxivResult | null> => {
  // arXiv supports direct fetch by passing id_list.
  const idList = id.replace(/^https?:\/\/arxiv\.org\/abs\//, "").trim();
  const url = `${ENDPOINT}?id_list=${encodeURIComponent(idList)}`;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await retry(() => fetch(url, { signal: ac.signal, headers: { accept: "application/atom+xml" } }));
    if (!res.ok) return null;
    const xml = await res.text();
    const entries = parseAtom(xml);
    const e = entries[0];
    if (!e) return null;
    return {
      id: e.id,
      title: e.title,
      url: e.link || e.id,
      snippet: e.summary.slice(0, 800),
      score: 0,
      metadata: {
        authors: e.authors,
        primaryCategory: e.primaryCategory,
        categories: e.categories,
        published: e.published,
        updated: e.updated,
      },
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

export const format = (r: ArxivResult): string => {
  const authors = Array.isArray(r.metadata["authors"]) ? (r.metadata["authors"] as string[]).join(", ") : "";
  const lines = [
    `### [arxiv] ${r.title}`,
    r.url,
  ];
  if (authors) lines.push(`*${authors}*`);
  if (r.snippet) lines.push("", r.snippet);
  const meta = Object.entries(r.metadata)
    .filter(([k, v]) => k !== "authors" && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `  - ${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
  if (meta) lines.push("", meta);
  return lines.join("\n");
};

export const health = async (): Promise<{ ok: boolean }> => {
  try {
    const res = await fetch(`${ENDPOINT}?search_query=all:test&max_results=1`, { signal: AbortSignal.timeout(5_000) });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
};

export const handler: Handler = { id: "arxiv", label: "arXiv", search, fetch, format, health };
