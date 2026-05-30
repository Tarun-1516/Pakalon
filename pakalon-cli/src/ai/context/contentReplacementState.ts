/**
 * Content Replacement State
 *
 * Tracks tool result content that has been replaced/compacted
 * per conversation thread, enabling budget management for large results.
 */

/**
 * A single replacement record.
 */
export interface ReplacementRecord {
  toolUseId: string;
  originalSize: number;
  replacementSize: number;
  summary: string;
  timestamp: number;
}

/**
 * Tracks content replacements for budget management.
 */
export class ContentReplacementState {
  private replacements = new Map<string, ReplacementRecord>();
  private totalBytesSaved = 0;

  /**
   * Record a content replacement.
   */
  recordReplacement(
    toolUseId: string,
    originalSize: number,
    replacementSize: number,
    summary: string,
  ): void {
    this.replacements.set(toolUseId, {
      toolUseId,
      originalSize,
      replacementSize,
      summary,
      timestamp: Date.now(),
    });
    this.totalBytesSaved += Math.max(0, originalSize - replacementSize);
  }

  /**
   * Get a replacement record by tool use ID.
   */
  getReplacement(toolUseId: string): ReplacementRecord | null {
    return this.replacements.get(toolUseId) ?? null;
  }

  /**
   * Get total bytes saved through replacements.
   */
  getBudgetSaved(): number {
    return this.totalBytesSaved;
  }

  /**
   * Get all replacement records.
   */
  getReplacements(): ReplacementRecord[] {
    return Array.from(this.replacements.values());
  }

  /**
   * Get replacement count.
   */
  getReplacementCount(): number {
    return this.replacements.size;
  }

  /**
   * Check if a tool use has been replaced.
   */
  hasReplacement(toolUseId: string): boolean {
    return this.replacements.has(toolUseId);
  }

  /**
   * Clear all replacements.
   */
  clear(): void {
    this.replacements.clear();
    this.totalBytesSaved = 0;
  }

  /**
   * Get stats for display.
   */
  getStats(): {
    replacementCount: number;
    totalBytesSaved: number;
    averageReduction: number;
  } {
    const count = this.replacements.size;
    const avgReduction = count > 0 ? this.totalBytesSaved / count : 0;
    return {
      replacementCount: count,
      totalBytesSaved: this.totalBytesSaved,
      averageReduction: avgReduction,
    };
  }
}

/**
 * Clone a ContentReplacementState (for subagent fork).
 */
export function cloneContentReplacementState(
  source: ContentReplacementState,
): ContentReplacementState {
  const clone = new ContentReplacementState();
  for (const record of source.getReplacements()) {
    clone.recordReplacement(
      record.toolUseId,
      record.originalSize,
      record.replacementSize,
      record.summary,
    );
  }
  return clone;
}
