/**
 * Session Memory Utilities
 *
 * Helper functions for formatting, compressing, and managing
 * session memory data.
 */

/**
 * Format memories for inclusion in a system prompt.
 */
export function formatMemoryForPrompt(
  memories: Array<{ key: string; value: string }>,
): string {
  if (memories.length === 0) return '';

  const lines = memories.map((m) => `  - ${m.key}: ${m.value}`);
  return `<session_memory>\n${lines.join('\n')}\n</session_memory>`;
}

/**
 * Compress a memory value to a maximum length.
 * Preserves the beginning and end, truncating the middle.
 */
export function compressMemory(value: string, maxLength: number = 200): string {
  if (value.length <= maxLength) return value;

  const keepChars = Math.floor((maxLength - 5) / 2); // 5 chars for "..."
  const beginning = value.slice(0, keepChars);
  const end = value.slice(-keepChars);

  return `${beginning}...${end}`;
}

/**
 * Extract keywords from a memory value for indexing.
 */
export function extractMemoryKeywords(value: string): string[] {
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  return [...new Set(words)];
}

/**
 * Merge multiple memory sets into one.
 * Later sets override earlier ones for duplicate keys.
 */
export function mergeMemorySets(
  ...sets: Array<Map<string, string>>
): Map<string, string> {
  const merged = new Map<string, string>();
  for (const set of sets) {
    for (const [key, value] of set) {
      merged.set(key, value);
    }
  }
  return merged;
}

/**
 * Filter memories by keyword match.
 */
export function filterByKeywords(
  memories: Array<{ key: string; value: string }>,
  keywords: string[],
): Array<{ key: string; value: string; matchCount: number }> {
  const lowerKeywords = keywords.map((k) => k.toLowerCase());

  return memories
    .map((m) => {
      const text = `${m.key} ${m.value}`.toLowerCase();
      const matchCount = lowerKeywords.filter((k) => text.includes(k)).length;
      return { ...m, matchCount };
    })
    .filter((m) => m.matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount);
}

/**
 * Get memory size estimate in bytes.
 */
export function estimateMemorySize(memories: Array<{ key: string; value: string }>): number {
  let total = 0;
  for (const m of memories) {
    total += m.key.length + m.value.length;
  }
  return total;
}
