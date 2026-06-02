/**
 * Tool-call-id normalization.
 *
 * Anthropic tool_use IDs must match the pattern `^[a-zA-Z0-9_-]{1,64}$`.
 * When an upstream provider hands us an OpenAI-style id like
 * `call_abc123def456...` or a UUID with dashes, we may need to:
 *   1. Hash it down to 64 chars (truncating the head + adding a prefix).
 *   2. Replace illegal characters.
 *
 * Round-trip invariant: the same input always produces the same output.
 * This is critical because the agent loop re-sends `tool_result`
 * blocks keyed by `tool_use_id`. If the id changes between turns,
 * Anthropic rejects the request.
 */
import { createHash } from "node:crypto";

const MAX_LEN = 64;
const ANTHROPIC_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const OPENAI_CALL_PREFIX = /^call_/;
const OPENAI_FC_PREFIX = /^fc_/;

export function isOpenAIToolCallId(id: string): boolean {
  return OPENAI_CALL_PREFIX.test(id) || OPENAI_FC_PREFIX.test(id);
}

export function isAnthropicToolCallId(id: string): boolean {
  return ANTHROPIC_PATTERN.test(id);
}

/**
 * Normalize any tool-call id to a valid Anthropic id.
 * - If already valid, returns as-is.
 * - Otherwise, replaces illegal chars and shortens via SHA-256 prefix.
 *
 * Strategy: prefix with `pak_` (3 chars), then 61 hex chars of the
 * SHA-256 of the input. This makes collisions vanishingly unlikely
 * (61 hex chars = 305 bits of entropy) while keeping the id stable.
 */
export function normalizeToolCallId(id: string): string {
  if (typeof id !== "string" || id.length === 0) {
    return "pak_" + createHash("sha256").update(String(id ?? "")).digest("hex").slice(0, 61);
  }
  if (isAnthropicToolCallId(id)) return id;

  // Drop prefixes that would push the id over 64 chars.
  let cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (cleaned.length > MAX_LEN) {
    const digest = createHash("sha256").update(id).digest("hex");
    return "pak_" + digest.slice(0, 61);
  }
  // If the result still contains illegal chars (e.g. an upstream UUID
  // that we couldn't keep in 64 chars), fall back to hash form.
  if (!isAnthropicToolCallId(cleaned)) {
    const digest = createHash("sha256").update(id).digest("hex");
    return "pak_" + digest.slice(0, 61);
  }
  return cleaned;
}

/**
 * For logging / debugging: produce a human-readable short form.
 */
export function shortToolCallId(id: string): string {
  const normalized = normalizeToolCallId(id);
  if (normalized.length <= 16) return normalized;
  return normalized.slice(0, 8) + "…" + normalized.slice(-6);
}
