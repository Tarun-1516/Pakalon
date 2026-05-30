/**
 * Find Relevant Memories
 *
 * Scores and retrieves memories based on relevance to a query.
 * Uses keyword overlap, recency, and size for ranking.
 */

import type { MemoryFile } from './memdir.js';
import { getMemoryAgeInfo } from './memoryAge.js';

/**
 * A memory with relevance score.
 */
export interface RelevantMemory {
  memory: MemoryFile;
  score: number;
  matchType: 'keyword' | 'recency' | 'both';
}

/**
 * Options for memory relevance search.
 */
export interface RelevanceOptions {
  maxResults?: number;
  minScore?: number;
  recencyWeight?: number;
  keywordWeight?: number;
  sizeWeight?: number;
}

const DEFAULT_OPTIONS: Required<RelevanceOptions> = {
  maxResults: 10,
  minScore: 0.1,
  recencyWeight: 0.3,
  keywordWeight: 0.6,
  sizeWeight: 0.1,
};

/**
 * Find memories relevant to a query string.
 */
export function findRelevantMemories(
  query: string,
  memories: MemoryFile[],
  options?: RelevanceOptions,
): RelevantMemory[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const queryWords = extractKeywords(query);

  const scored = memories.map((memory) => ({
    memory,
    ...scoreMemoryRelevance(queryWords, memory),
  }));

  return scored
    .filter((s) => s.score >= opts.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxResults);
}

/**
 * Score a memory's relevance to query keywords.
 */
export function scoreMemoryRelevance(
  queryWords: string[],
  memory: MemoryFile,
): { score: number; matchType: 'keyword' | 'recency' | 'both' } {
  const memoryKeywords = extractKeywords(memory.content);
  const memoryPath = memory.path.toLowerCase();

  // Keyword overlap score
  let keywordMatches = 0;
  for (const word of queryWords) {
    if (memoryKeywords.has(word) || memoryPath.includes(word)) {
      keywordMatches++;
    }
  }
  const keywordScore = queryWords.length > 0 ? keywordMatches / queryWords.length : 0;

  // Recency score
  const ageInfo = getMemoryAgeInfo(memory.lastModified);
  let recencyScore: number;
  switch (ageInfo.category) {
    case 'fresh': recencyScore = 1.0; break;
    case 'recent': recencyScore = 0.8; break;
    case 'moderate': recencyScore = 0.6; break;
    case 'old': recencyScore = 0.4; break;
    case 'stale': recencyScore = 0.2; break;
    case 'archived': recencyScore = 0.1; break;
    default: recencyScore = 0.5;
  }

  // Size score (prefer medium-sized files)
  const sizeKB = memory.size / 1024;
  let sizeScore: number;
  if (sizeKB < 1) sizeScore = 0.3;
  else if (sizeKB < 10) sizeScore = 0.8;
  else if (sizeKB < 100) sizeScore = 1.0;
  else sizeScore = 0.7;

  // Combined score
  const score = keywordScore * 0.6 + recencyScore * 0.3 + sizeScore * 0.1;

  // Determine match type
  let matchType: 'keyword' | 'recency' | 'both';
  if (keywordScore > 0 && recencyScore > 0.5) {
    matchType = 'both';
  } else if (keywordScore > 0) {
    matchType = 'keyword';
  } else {
    matchType = 'recency';
  }

  return { score, matchType };
}

/**
 * Extract keywords from text.
 */
function extractKeywords(text: string): Set<string> {
  const words = new Set<string>();
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ');

  for (const word of normalized.split(/\s+/)) {
    const trimmed = word.trim();
    if (trimmed.length > 2) {
      words.add(trimmed);
    }
  }

  return words;
}
