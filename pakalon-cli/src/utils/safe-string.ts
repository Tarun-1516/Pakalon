/**
 * Safe string utilities shared across AI clients.
 *
 * - redactSensitive: replaces Bearer tokens, cookies, and api_key-like
 *   substrings in error messages before they're logged or returned.
 * - sanitizeUnicode: strips homoglyphs and zero-width chars that some
 *   model providers (notably older Llama) inject into responses.
 * - isEnoent: true if the error is a node ENOENT.
 */
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._\-]{16,}/gi, "$1<redacted>"],
  [/(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-]{12,}/gi, "$1<redacted>"],
  [/(sk-[A-Za-z0-9_\-]{12,})/g, "<redacted>"],
  [/(ghp_[A-Za-z0-9]{12,})/g, "<redacted>"],
  [/(xox[abp]-[\w-]{8,})/g, "<redacted>"],
  [/(ANTHROPIC_API_KEY\s*=\s*)\S+/g, "$1<redacted>"],
  [/(OPENAI_API_KEY\s*=\s*)\S+/g, "$1<redacted>"],
];

export function redactSensitive(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  for (const [re, replacement] of REDACT_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

// Zero-width and bidi override characters used for prompt-injection
// attacks against model providers.
const ZERO_WIDTH = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const COMMON_HOMOGLYPHS: Record<string, string> = {
  "\u0410": "A", "\u0412": "B", "\u0421": "C", "\u0415": "E", "\u041D": "H",
  "\u041A": "K", "\u041C": "M", "\u041E": "O", "\u0420": "P", "\u0422": "T",
  "\u0425": "X", "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p",
  "\u0441": "c", "\u0443": "y", "\u0445": "x",
};

export function sanitizeUnicode(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  // First strip zero-width chars.
  let out = input.replace(ZERO_WIDTH, "");
  // Then replace common Cyrillic homoglyphs.
  out = out.replace(/[\u0400-\u04FF]/g, (c) => COMMON_HOMOGLYPHS[c] ?? c);
  return out;
}

export function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT";
}
