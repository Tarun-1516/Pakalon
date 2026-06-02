/**
 * Cache-affinity routing hint.
 *
 * Anthropic's prompt caching works best when consecutive requests in a
 * session hit the same cache shard. The shard is determined by
 * (api_key, prompt-hash-prefix). When the proxy LB is in front, you can
 * pin a session to a specific upstream by setting a header — the proxy
 * then uses the header to compute the upstream shard.
 *
 * `pickCacheAffinityKey` returns a stable per-session token. The agent
 * loop calls this once at session start and reuses it for every request.
 */
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";

const CACHE_AFFINITY_HEADER = "x-pakalon-cache-affinity";
const CACHE_AFFINITY_KEY_BYTES = 8;

let sessionToken: string | null = null;

export function pickCacheAffinityKey(): string {
  if (sessionToken) return sessionToken;
  // Try to derive from process env so all CLIs in the same terminal
  // window share affinity (matches `pid + tty`).
  const fromEnv = process.env.PAKALON_CACHE_AFFINITY;
  if (fromEnv) {
    sessionToken = fromEnv;
    return sessionToken;
  }
  // Fall back to a random token. The OS will set the env var on
  // sub-shells, propagating the affinity to child processes.
  sessionToken = randomBytes(CACHE_AFFINITY_KEY_BYTES).toString("hex");
  if (typeof process !== "undefined" && process.env) {
    process.env.PAKALON_CACHE_AFFINITY = sessionToken;
  }
  return sessionToken;
}

export function setCacheAffinityKey(token: string): void {
  sessionToken = token;
  if (typeof process !== "undefined" && process.env) {
    process.env.PAKALON_CACHE_AFFINITY = token;
  }
}

/**
 * Compute a fingerprint of the request prefix. Used by the
 * load-balancer / proxy to pin requests with the same prefix to the
 * same upstream cache shard. The fingerprint is the SHA-256 of
 * (system-prompt + tools-schema + first user-message head).
 */
export function fingerprintRequestPrefix(input: {
  system?: string;
  tools?: Array<{ name: string; input_schema: unknown }>;
  messages?: Array<{ role: string; content: unknown }>;
}): string {
  const h = createHash("sha256");
  if (input.system) h.update("sys:" + shorten(input.system));
  if (input.tools) {
    for (const t of input.tools) {
      h.update("tool:" + t.name + ":" + JSON.stringify(t.input_schema));
    }
  }
  if (input.messages) {
    // Only fingerprint the first 3 messages — usually enough for cache hits.
    const head = input.messages.slice(0, 3);
    for (const m of head) {
      h.update("msg:" + m.role + ":" + shorten(typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    }
  }
  return h.digest("hex").slice(0, 32);
}

export function getCacheAffinityHint(request: { system?: unknown; tools?: unknown[]; messages?: unknown[] }): string | null {
  try {
    return fingerprintRequestPrefix({
      system: typeof request.system === "string" ? request.system : undefined,
      tools: Array.isArray(request.tools) ? (request.tools as Array<{ name: string; input_schema: unknown }>) : undefined,
      messages: Array.isArray(request.messages)
        ? (request.messages as Array<{ role: string; content: unknown }>)
        : undefined,
    });
  } catch {
    return null;
  }
}

function shorten(s: string, max = 4096): string {
  return s.length > max ? s.slice(0, max) : s;
}
