/**
 * Tool Use Summary Service for pakalon-cli
 *
 * Tracks and summarizes tool usage across sessions.
 */

import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type ToolUsageEntry = {
  toolName: string;
  timestamp: Date;
  duration?: number;
  success: boolean;
  error?: string;
};

export type ToolUsageSummary = {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  averageDuration?: number;
  lastUsed?: Date;
};

// ============================================================================
// Tool Use Summary Service Implementation
// ============================================================================

class ToolUseSummaryService {
  private entries: ToolUsageEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Record a tool usage event
   */
  record(entry: Omit<ToolUsageEntry, "timestamp">): void {
    const fullEntry: ToolUsageEntry = {
      ...entry,
      timestamp: new Date(),
    };

    this.entries.push(fullEntry);

    // Trim old entries if we exceed max
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    logger.debug(`[ToolUseSummary] Recorded: ${entry.toolName} (${entry.success ? "success" : "failure"})`);
  }

  /**
   * Get summary for a specific tool
   */
  getToolSummary(toolName: string): ToolUsageSummary | null {
    const toolEntries = this.entries.filter((e) => e.toolName === toolName);
    if (toolEntries.length === 0) {
      return null;
    }

    const successCount = toolEntries.filter((e) => e.success).length;
    const durations = toolEntries
      .filter((e) => e.duration !== undefined)
      .map((e) => e.duration!);

    return {
      toolName,
      totalCalls: toolEntries.length,
      successCount,
      failureCount: toolEntries.length - successCount,
      averageDuration:
        durations.length > 0
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : undefined,
      lastUsed: toolEntries[toolEntries.length - 1]?.timestamp,
    };
  }

  /**
   * Get summary for all tools
   */
  getAllSummaries(): ToolUsageSummary[] {
    const toolNames = new Set(this.entries.map((e) => e.toolName));
    return Array.from(toolNames)
      .map((name) => this.getToolSummary(name))
      .filter((s): s is ToolUsageSummary => s !== null);
  }

  /**
   * Get top N most used tools
   */
  getTopTools(n: number = 10): ToolUsageSummary[] {
    return this.getAllSummaries()
      .sort((a, b) => b.totalCalls - a.totalCalls)
      .slice(0, n);
  }

  /**
   * Get recent entries
   */
  getRecentEntries(n: number = 50): ToolUsageEntry[] {
    return this.entries.slice(-n);
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.entries = [];
    logger.info("[ToolUseSummary] Cleared all entries");
  }

  /**
   * Get total tool calls
   */
  getTotalCalls(): number {
    return this.entries.length;
  }

  /**
   * Get success rate
   */
  getSuccessRate(): number {
    if (this.entries.length === 0) return 0;
    const successCount = this.entries.filter((e) => e.success).length;
    return successCount / this.entries.length;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultService: ToolUseSummaryService | null = null;

/**
 * Get or create the default Tool Use Summary service
 */
export function getToolUseSummaryService(): ToolUseSummaryService {
  if (!defaultService) {
    defaultService = new ToolUseSummaryService();
  }
  return defaultService;
}

/**
 * Create a new Tool Use Summary service
 */
export function createToolUseSummaryService(
  maxEntries?: number
): ToolUseSummaryService {
  return new ToolUseSummaryService(maxEntries);
}
