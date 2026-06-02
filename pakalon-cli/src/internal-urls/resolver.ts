/**
 * internal-urls/resolver.ts — multi-scheme lazy URL resolver.
 *
 * Schemes supported (each maps to a backend endpoint):
 *
 *   local://        — short-lived signed URL to a workspace path (no auth)
 *   secure://       — same but with a stronger HMAC
 *   pr://<repo>/<n> — pull-request conversation (GitHub)
 *   issue://<repo>/<n>     — issue conversation
 *   agent://<name>  — agent definition
 *   skill://<name>  — skill definition
 *   rule://<name>   — permission rule
 *   conflict://<sha> — git conflict artifact
 *   git-overview://<path> — git log + blame + status snapshot
 *   fs://<path>     — file system blob (server-side, auth-gated)
 *   session://<id>  — chat session replay
 *   tool://<name>   — tool manifest
 *
 * Each scheme is registered in `SCHEMES` and resolved on first use
 * (lazy). Network failures are memoized for a short TTL.
 */
import { backendFetch } from "@/util/backend.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Scheme =
  | "local"
  | "secure"
  | "pr"
  | "issue"
  | "agent"
  | "skill"
  | "rule"
  | "conflict"
  | "git-overview"
  | "fs"
  | "session"
  | "tool";

export interface ResolverContext {
  workspace?: string;
  repo?: string;
  branch?: string;
  ref?: string;
  token?: string;
}

export interface ResolveResult {
  url: string;
  scheme: Scheme;
  /** Decoded view of the URL (for debugging). */
  decoded: Record<string, string>;
  /** When the URL expires. */
  expiresAt?: number;
  /** Original raw URL. */
  raw: string;
}

export interface ResolveError {
  scheme: Scheme;
  message: string;
  cause?: unknown;
}

export type Resolver = (raw: string, ctx: ResolverContext) => Promise<ResolveResult>;

// ---------------------------------------------------------------------------
// Memoization
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: ResolveResult | ResolveError;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 30_000;

function memo<T extends ResolveResult | ResolveError>(key: string, value: T, ttlMs: number = DEFAULT_TTL_MS): T {
  cache.set(key, { result: value, expiresAt: Date.now() + ttlMs });
  return value;
}

function getMemo(key: string): (ResolveResult | ResolveError) | null {
  const e = cache.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return e.result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLocalUrl(raw: string): { scheme: "local" | "secure"; rest: string } | null {
  const m = raw.match(/^(local|secure):\/\/(.+)$/);
  if (!m) return null;
  return { scheme: m[1] as "local" | "secure", rest: m[2]! };
}

function splitPath(rest: string): { workspace: string; path: string; meta: Record<string, string> } {
  // local://<workspace>/<path>?key=value#fragment
  // workspace is required; everything after the first / is the path.
  const [head, ...tail] = rest.split("?");
  const slash = (head ?? "").indexOf("/");
  if (slash < 0) {
    return { workspace: head ?? "", path: "", meta: {} };
  }
  const workspace = (head ?? "").slice(0, slash);
  const path = (head ?? "").slice(slash + 1);
  const meta: Record<string, string> = {};
  if (tail.length > 0) {
    for (const part of tail.join("?").split("&")) {
      const [k, v] = part.split("=");
      if (k) meta[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
  }
  return { workspace, path, meta };
}

function isResolveError(v: ResolveResult | ResolveError): v is ResolveError {
  return (v as ResolveError).message !== undefined && !(v as ResolveResult).url;
}

// ---------------------------------------------------------------------------
// Built-in resolvers
// ---------------------------------------------------------------------------

const resolveLocalOrSecure: Resolver = async (raw, _ctx) => {
  const parsed = parseLocalUrl(raw);
  if (!parsed) throw new Error(`not a local/secure URL: ${raw}`);
  const { workspace, path, meta } = splitPath(parsed.rest);
  const res = await backendFetch("/internal-urls/resolve", {
    method: "POST",
    body: JSON.stringify({ url: raw }),
  });
  const data = (res ?? {}) as { url?: string; expires_at?: number; workspace?: string; path?: string };
  return {
    url: data.url ?? raw,
    scheme: parsed.scheme,
    raw,
    decoded: { workspace, path, ...meta, resolved_workspace: data.workspace ?? "", resolved_path: data.path ?? "" },
    expiresAt: data.expires_at ? new Date(data.expires_at).getTime() : Date.now() + 60_000,
  };
};

const resolvePr: Resolver = async (raw, ctx) => {
  const m = raw.match(/^pr:\/\/([^/]+)\/(\d+)$/);
  if (!m) throw new Error(`bad pr url: ${raw}`);
  const repo = decodeURIComponent(m[1]!);
  const num = Number(m[2]);
  const res = await backendFetch(`/prs/${repo}/${num}`, { method: "GET" });
  return {
    url: raw,
    scheme: "pr",
    raw,
    decoded: { repo, number: String(num), workspace: ctx.workspace ?? "", ...((res as object) ?? {}) as Record<string, string> },
  };
};

const resolveIssue: Resolver = async (raw, ctx) => {
  const m = raw.match(/^issue:\/\/([^/]+)\/(\d+)$/);
  if (!m) throw new Error(`bad issue url: ${raw}`);
  const repo = decodeURIComponent(m[1]!);
  const num = Number(m[2]);
  const res = await backendFetch(`/issues/${repo}/${num}`, { method: "GET" });
  return {
    url: raw,
    scheme: "issue",
    raw,
    decoded: { repo, number: String(num), workspace: ctx.workspace ?? "", ...((res as object) ?? {}) as Record<string, string> },
  };
};

const resolveAgent: Resolver = async (raw) => {
  const m = raw.match(/^agent:\/\/(.+)$/);
  if (!m) throw new Error(`bad agent url: ${raw}`);
  const name = decodeURIComponent(m[1]!);
  const res = await backendFetch(`/agents/${name}`, { method: "GET" });
  return { url: raw, scheme: "agent", raw, decoded: { name, ...((res as object) ?? {}) as Record<string, string> } };
};

const resolveSkill: Resolver = async (raw) => {
  const m = raw.match(/^skill:\/\/(.+)$/);
  if (!m) throw new Error(`bad skill url: ${raw}`);
  const name = decodeURIComponent(m[1]!);
  const res = await backendFetch(`/skills/${name}`, { method: "GET" });
  return { url: raw, scheme: "skill", raw, decoded: { name, ...((res as object) ?? {}) as Record<string, string> } };
};

const resolveRule: Resolver = async (raw) => {
  const m = raw.match(/^rule:\/\/(.+)$/);
  if (!m) throw new Error(`bad rule url: ${raw}`);
  const name = decodeURIComponent(m[1]!);
  const res = await backendFetch(`/permissions/rules/${name}`, { method: "GET" });
  return { url: raw, scheme: "rule", raw, decoded: { name, ...((res as object) ?? {}) as Record<string, string> } };
};

const resolveConflict: Resolver = async (raw) => {
  const m = raw.match(/^conflict:\/\/(.+)$/);
  if (!m) throw new Error(`bad conflict url: ${raw}`);
  const sha = decodeURIComponent(m[1]!);
  const res = await backendFetch(`/conflicts/${sha}`, { method: "GET" });
  return { url: raw, scheme: "conflict", raw, decoded: { sha, ...((res as object) ?? {}) as Record<string, string> } };
};

const resolveGitOverview: Resolver = async (raw, ctx) => {
  const m = raw.match(/^git-overview:\/\/(.+)$/);
  if (!m) throw new Error(`bad git-overview url: ${raw}`);
  const path = decodeURIComponent(m[1]!);
  const res = await backendFetch(`/git/overview`, {
    method: "POST",
    body: JSON.stringify({ path, ref: ctx.ref, branch: ctx.branch, workspace: ctx.workspace }),
  });
  return { url: raw, scheme: "git-overview", raw, decoded: { path, ...((res as object) ?? {}) as Record<string, string> } };
};

const resolveFs: Resolver = async (raw, ctx) => {
  const m = raw.match(/^fs:\/\/(.+)$/);
  if (!m) throw new Error(`bad fs url: ${raw}`);
  const path = decodeURIComponent(m[1]!);
  const res = await backendFetch("/fs/get", {
    method: "POST",
    body: JSON.stringify({ path, workspace: ctx.workspace, token: ctx.token }),
  });
  return { url: raw, scheme: "fs", raw, decoded: { path, ...((res as object) ?? {}) as Record<string, string> } };
};

const resolveSession: Resolver = async (raw) => {
  const m = raw.match(/^session:\/\/(.+)$/);
  if (!m) throw new Error(`bad session url: ${raw}`);
  const id = decodeURIComponent(m[1]!);
  const res = await backendFetch(`/sessions/${id}/replay`, { method: "GET" });
  return { url: raw, scheme: "session", raw, decoded: { id, ...((res as object) ?? {}) as Record<string, string> } };
};

const resolveTool: Resolver = async (raw) => {
  const m = raw.match(/^tool:\/\/(.+)$/);
  if (!m) throw new Error(`bad tool url: ${raw}`);
  const name = decodeURIComponent(m[1]!);
  const res = await backendFetch(`/tools/manifest/${name}`, { method: "GET" });
  return { url: raw, scheme: "tool", raw, decoded: { name, ...((res as object) ?? {}) as Record<string, string> } };
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SCHEMES: Record<Scheme, RegExp> = {
  "local": /^local:\/\//,
  "secure": /^secure:\/\//,
  "pr": /^pr:\/\//,
  "issue": /^issue:\/\//,
  "agent": /^agent:\/\//,
  "skill": /^skill:\/\//,
  "rule": /^rule:\/\//,
  "conflict": /^conflict:\/\//,
  "git-overview": /^git-overview:\/\//,
  "fs": /^fs:\/\//,
  "session": /^session:\/\//,
  "tool": /^tool:\/\//,
};

const RESOLVERS: Record<Scheme, Resolver> = {
  "local": resolveLocalOrSecure,
  "secure": resolveLocalOrSecure,
  "pr": resolvePr,
  "issue": resolveIssue,
  "agent": resolveAgent,
  "skill": resolveSkill,
  "rule": resolveRule,
  "conflict": resolveConflict,
  "git-overview": resolveGitOverview,
  "fs": resolveFs,
  "session": resolveSession,
  "tool": resolveTool,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function detectScheme(raw: string): Scheme | null {
  for (const [scheme, re] of Object.entries(SCHEMES) as [Scheme, RegExp][]) {
    if (re.test(raw)) return scheme;
  }
  return null;
}

export async function resolve(raw: string, ctx: ResolverContext = {}): Promise<ResolveResult> {
  const key = `${ctx.workspace ?? ""}|${ctx.branch ?? ""}|${ctx.token ?? ""}|${raw}`;
  const cached = getMemo(key);
  if (cached && !isResolveError(cached)) return cached;
  if (cached && isResolveError(cached)) throw new Error(cached.message);

  const scheme = detectScheme(raw);
  if (!scheme) throw new Error(`unsupported URL scheme: ${raw}`);
  const resolver = RESOLVERS[scheme];
  try {
    const result = await resolver(raw, ctx);
    return memo(key, result);
  } catch (e) {
    memo(key, { scheme, message: (e as Error).message, cause: e }, 5_000);
    throw e;
  }
}

/** Resolve a batch of URLs in parallel. Resolves are memoized. */
export async function resolveAll(
  urls: string[],
  ctx: ResolverContext = {},
): Promise<Array<{ url: string; result?: ResolveResult; error?: string }>> {
  return Promise.all(
    urls.map(async (u) => {
      try {
        return { url: u, result: await resolve(u, ctx) };
      } catch (e) {
        return { url: u, error: (e as Error).message };
      }
    }),
  );
}

/** Clear the resolver cache (useful for tests). */
export function clearCache(): void {
  cache.clear();
}
