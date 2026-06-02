/**
 * handlers/github.ts — GitHub issues / PRs / discussions / releases search.
 *
 * Uses @octokit/rest (already a dep). Falls back to unauthenticated (60 req/hr)
 * if GITHUB_TOKEN is not set.
 */
import { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GithubResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  score: number;
  metadata: Record<string, string | number | boolean | string[]>;
}

export interface GithubSearchOpts {
  /** "issues" | "prs" | "repos" | "discussions" | "releases" — default "issues" */
  type?: "issues" | "prs" | "repos" | "discussions" | "releases";
  /** Restrict to a single repo, e.g. "owner/name". */
  repo?: string;
  /** Max results (1..20, default 8). */
  limit?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Bearer override; defaults to GITHUB_TOKEN. */
  token?: string;
}

export interface GithubFetchOpts {
  type?: "issue" | "pr" | "repo" | "discussion" | "release";
  token?: string;
  timeoutMs?: number;
}

export interface Handler {
  id: "github";
  label: string;
  search(query: string, opts?: GithubSearchOpts): Promise<GithubResult[]>;
  fetch(id: string, opts?: GithubFetchOpts): Promise<GithubResult | null>;
  format(r: GithubResult): string;
  health(): Promise<{ ok: boolean; rateLimit?: { remaining: number; reset: number } }>;
}

// ---------------------------------------------------------------------------
// Client (lazy)
// ---------------------------------------------------------------------------

let _client: Octokit | null = null;
let _clientToken: string | null | undefined = undefined;

function getClient(token?: string | null): Octokit {
  const effective = token !== undefined ? token : process.env["GITHUB_TOKEN"] ?? null;
  if (_client && _clientToken === effective) return _client;
  const auth = effective || undefined;
  _client = new Octokit({
    auth,
    userAgent: "pakalon-cli/1.0",
    request: { timeout: 15_000 },
  });
  _clientToken = effective;
  return _client;
}

async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  const delays = [200, 600, 1800];
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delays[i] ?? 1800));
    }
  }
  throw lastErr;
}

function getAuthWarning(): string | null {
  return process.env["GITHUB_TOKEN"] ? null : "no GITHUB_TOKEN set; using unauthenticated requests (60 req/hour)";
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const search = async (query: string, opts: GithubSearchOpts = {}): Promise<GithubResult[]> => {
  const { type = "issues", repo, limit = 8, timeoutMs = 15_000 } = opts;
  if (limit < 1 || limit > 20) throw new Error("limit must be 1..20");
  const warning = getAuthWarning();
  if (warning) console.warn(`[github] ${warning}`);
  const client = getClient(opts.token);
  const q = repo ? `${query} repo:${repo}` : query;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const out: GithubResult[] = [];
    if (type === "issues" || type === "prs") {
      const qualifier = type === "prs" ? "is:pr" : "is:issue";
      const res = await retry(() => client.search.issuesAndPullRequests({
        q: `${q} ${qualifier}`,
        per_page: limit,
        sort: "updated",
        order: "desc",
        request: { signal: ac.signal },
      }));
      for (const item of res.data.items ?? []) {
        out.push({
          id: String(item.number),
          title: item.title ?? "",
          url: item.html_url ?? "",
          snippet: (item.body ?? "").slice(0, 280),
          score: (item as unknown as { score?: number }).score ?? 0,
          metadata: {
            state: item.state ?? "unknown",
            comments: item.comments ?? 0,
            user: item.user?.login ?? "",
            labels: (item.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
            isPr: !!item.pull_request,
            updatedAt: item.updated_at ?? "",
          },
        });
      }
    } else if (type === "repos") {
      const res = await retry(() => client.search.repos({
        q,
        per_page: limit,
        sort: "stars",
        order: "desc",
        request: { signal: ac.signal },
      }));
      for (const r of res.data.items ?? []) {
        out.push({
          id: String(r.id),
          title: r.full_name ?? r.name ?? "",
          url: r.html_url ?? "",
          snippet: r.description ?? "",
          score: r.stargazers_count ?? 0,
          metadata: {
            stars: r.stargazers_count ?? 0,
            forks: r.forks_count ?? 0,
            language: r.language ?? "",
            updatedAt: r.updated_at ?? "",
          },
        });
      }
    } else if (type === "releases") {
      // releases endpoint is per-repo, so require repo
      if (!repo) throw new Error("releases search requires `repo`");
      const [owner, name] = repo.split("/");
      if (!owner || !name) throw new Error("repo must be 'owner/name'");
      const res = await retry(() => client.repos.listReleases({
        owner,
        repo: name,
        per_page: limit,
        request: { signal: ac.signal },
      }));
      for (const rel of res.data) {
        out.push({
          id: String(rel.id),
          title: rel.name || rel.tag_name,
          url: rel.html_url,
          snippet: (rel.body ?? "").slice(0, 280),
          score: 0,
          metadata: { tag: rel.tag_name, publishedAt: rel.published_at ?? "", author: rel.author?.login ?? "" },
        });
      }
    } else if (type === "discussions") {
      // GitHub discussions use the GraphQL API; provide a stub.
      out.push({
        id: "graphql-unsupported",
        title: "GitHub Discussions require GraphQL",
        url: "https://github.com/features/discussions",
        snippet: "Discussions are exposed only via the GraphQL API. Use `gh` CLI or POST a GraphQL query instead.",
        score: 0,
        metadata: { fallback: true },
      });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
};

export const fetch = async (id: string, opts: GithubFetchOpts = {}): Promise<GithubResult | null> => {
  const client = getClient(opts.token);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    if (opts.type === "repo") {
      const res = await client.repos.get({ owner: id.split("/")[0]!, repo: id.split("/")[1]! });
      const r = res.data;
      return {
        id: String(r.id),
        title: r.full_name,
        url: r.html_url,
        snippet: r.description ?? "",
        score: r.stargazers_count ?? 0,
        metadata: { stars: r.stargazers_count ?? 0, forks: r.forks_count ?? 0, language: r.language ?? "" },
      };
    }
    // default: treat id as "owner/repo#123"
    const m = id.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (!m) return null;
    const [, owner, repo, num] = m;
    const res = await client.issues.get({ owner: owner!, repo: repo!, issue_number: Number(num) });
    const it = res.data;
    return {
      id: String(it.number),
      title: it.title,
      url: it.html_url ?? "",
      snippet: (it.body ?? "").slice(0, 800),
      score: 0,
      metadata: {
        state: it.state,
        user: it.user?.login ?? "",
        labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")),
        isPr: !!it.pull_request,
        createdAt: it.created_at,
        updatedAt: it.updated_at,
      },
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export const format = (r: GithubResult): string => {
  const tag = r.metadata["isPr"] ? "PR" : r.metadata["state"] ? "Issue" : "Repo";
  const lines = [`### [${tag}] ${r.title}`, r.url];
  if (r.snippet) lines.push("", r.snippet);
  const meta = Object.entries(r.metadata)
    .filter(([k]) => !["isPr", "state", "fallback"].includes(k))
    .map(([k, v]) => `  - ${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
  if (meta) lines.push("", meta);
  return lines.join("\n");
};

export const health = async (): Promise<{ ok: boolean; rateLimit?: { remaining: number; reset: number } }> => {
  try {
    const client = getClient();
    const res = await client.rateLimit.get();
    const core = res.data.resources?.core;
    return {
      ok: true,
      rateLimit: core ? { remaining: core.remaining, reset: core.reset } : undefined,
    };
  } catch {
    return { ok: false };
  }
};

export const handler: Handler = { id: "github", label: "GitHub", search, fetch, format, health };
