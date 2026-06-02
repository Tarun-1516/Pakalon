/**
 * handlers/npm.ts — npm package search via the public registry API.
 * GET https://registry.npmjs.com/-/v1/search?text={q}&size={n}
 */
import { setTimeout as wait } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NpmResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  score: number;
  metadata: Record<string, string | number | string[]>;
}

export interface NpmSearchOpts {
  limit?: number;       // 1..20, default 8
  timeoutMs?: number;   // default 15000
  signal?: AbortSignal;
}

export interface NpmFetchOpts {
  version?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Handler {
  id: "npm";
  label: string;
  search(query: string, opts?: NpmSearchOpts): Promise<NpmResult[]>;
  fetch(id: string, opts?: NpmFetchOpts): Promise<NpmResult | null>;
  format(r: NpmResult): string;
  health(): Promise<{ ok: boolean; latencyMs?: number }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const ENDPOINT_SEARCH = "https://registry.npmjs.com/-/v1/search";

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

export const search = async (query: string, opts: NpmSearchOpts = {}): Promise<NpmResult[]> => {
  const limit = Math.max(1, Math.min(20, opts.limit ?? 8));
  const url = `${ENDPOINT_SEARCH}?text=${encodeURIComponent(query)}&size=${limit}`;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  const signal = opts.signal ?? ac.signal;
  try {
    const res = await retry(() => fetch(url, { signal, headers: { accept: "application/json" } }));
    if (!res.ok) throw new Error(`npm registry ${res.status}`);
    const data = await res.json() as {
      objects?: Array<{
        package: {
          name: string;
          version: string;
          description?: string;
          keywords?: string[];
          license?: string;
          links?: { npm?: string; homepage?: string; repository?: string };
          date?: string;
          publisher?: { username?: string };
        };
        score: { final: number; detail: { quality: number; popularity: number; maintenance: number } };
      }>;
    };
    return (data.objects ?? []).map((o) => ({
      id: o.package.name,
      title: o.package.name,
      url: o.package.links?.npm ?? `https://www.npmjs.com/package/${o.package.name}`,
      snippet: o.package.description ?? "",
      score: o.score?.final ?? 0,
      metadata: {
        version: o.package.version,
        keywords: o.package.keywords ?? [],
        license: o.package.license ?? "",
        homepage: o.package.links?.homepage ?? "",
        repository: o.package.links?.repository ?? "",
        quality: o.score?.detail?.quality ?? 0,
        popularity: o.score?.detail?.popularity ?? 0,
        maintenance: o.score?.detail?.maintenance ?? 0,
        updatedAt: o.package.date ?? "",
        publisher: o.package.publisher?.username ?? "",
      },
    }));
  } finally {
    clearTimeout(timeout);
  }
};

export const fetch = async (id: string, opts: NpmFetchOpts = {}): Promise<NpmResult | null> => {
  const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id;
  const encoded = encodeURIComponent(name);
  const url = `https://registry.npmjs.org/${encoded}${opts.version ? `/${encodeURIComponent(opts.version)}` : ""}`;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await retry(() => fetch(url, { signal: ac.signal, headers: { accept: "application/json" } }));
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown> & {
      name?: string;
      description?: string;
      version?: string;
      "dist-tags"?: { latest?: string };
      homepage?: string;
      repository?: { url?: string };
      license?: string;
      keywords?: string[];
      time?: Record<string, string>;
    };
    const ver = opts.version ?? data["dist-tags"]?.latest ?? data.version ?? "latest";
    const t = (data.time ?? {})[ver as string] ?? "";
    return {
      id: name,
      title: name,
      url: `https://www.npmjs.com/package/${name}`,
      snippet: data.description ?? "",
      score: 0,
      metadata: {
        version: String(ver),
        homepage: data.homepage ?? "",
        repository: data.repository?.url ?? "",
        license: typeof data.license === "string" ? data.license : "",
        keywords: data.keywords ?? [],
        updatedAt: t,
      },
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

export const format = (r: NpmResult): string => {
  const lines = [
    `### [npm] ${r.title}`,
    r.url,
  ];
  if (r.snippet) lines.push("", r.snippet);
  const meta = Object.entries(r.metadata)
    .filter(([, v]) => v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `  - ${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
  if (meta) lines.push("", meta);
  return lines.join("\n");
};

export const health = async (): Promise<{ ok: boolean; latencyMs?: number }> => {
  const start = Date.now();
  try {
    const res = await fetch(`${ENDPOINT_SEARCH}?text=react&size=1`, {
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  } catch {
    return { ok: false };
  }
};

export const handler: Handler = { id: "npm", label: "npm", search, fetch, format, health };
