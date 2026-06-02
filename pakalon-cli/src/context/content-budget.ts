/**
 * Content Budget Management
 *
 * Manages tool result budgets and content replacement state:
 * - Tool result size limits
 * - Content replacement tracking
 * - Budget allocation per tool type
 * - Automatic truncation and summarization
 */

import logger from '@/utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ContentBudgetConfig {
  /** Maximum total budget in tokens */
  totalBudget: number;
  /** Budget per tool type */
  toolBudgets: Record<string, number>;
  /** Maximum size for a single tool result in characters */
  maxSingleResultSize: number;
  /** Whether to enable automatic truncation */
  enableTruncation: boolean;
  /** Whether to enable content replacement */
  enableReplacement: boolean;
}

export interface ToolResultEntry {
  /** Tool use ID */
  toolUseId: string;
  /** Tool name */
  toolName: string;
  /** Original result size in characters */
  originalSize: number;
  /** Compressed/replaced result size */
  currentSize: number;
  /** Token count estimate */
  tokenEstimate: number;
  /** Whether result was truncated */
  truncated: boolean;
  /** Whether result was replaced */
  replaced: boolean;
  /** Timestamp */
  timestamp: number;
}

export interface ContentReplacementState {
  /** Tool result entries */
  entries: Map<string, ToolResultEntry>;
  /** Total budget used */
  totalBudgetUsed: number;
  /** Total budget remaining */
  totalBudgetRemaining: number;
  /** Budget per tool */
  toolBudgetUsage: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ContentBudgetConfig = {
  totalBudget: 100000, // 100k tokens
  toolBudgets: {
    read: 20000,
    grep: 15000,
    glob: 10000,
    bash: 25000,
    edit: 15000,
    write: 20000,
    web_fetch: 15000,
    web_search: 10000,
    lsp: 10000,
    task: 15000,
    default: 10000,
  },
  maxSingleResultSize: 50000, // 50k characters
  enableTruncation: true,
  enableReplacement: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Content Budget Manager
// ─────────────────────────────────────────────────────────────────────────────

export class ContentBudgetManager {
  private config: ContentBudgetConfig;
  private state: ContentReplacementState;

  constructor(config?: Partial<ContentBudgetConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      entries: new Map(),
      totalBudgetUsed: 0,
      totalBudgetRemaining: this.config.totalBudget,
      toolBudgetUsage: {},
    };
  }

  /**
   * Register a tool result
   */
  registerToolResult(
    toolUseId: string,
    toolName: string,
    resultSize: number
  ): ToolResultEntry {
    const tokenEstimate = this.estimateTokens(resultSize);
    const toolBudget = this.getToolBudget(toolName);
    const currentToolUsage = this.state.toolBudgetUsage[toolName] || 0;

    // Check if tool budget would be exceeded
    const wouldExceedToolBudget = currentToolUsage + tokenEstimate > toolBudget;
    const wouldExceedTotalBudget = this.state.totalBudgetUsed + tokenEstimate > this.config.totalBudget;

    const entry: ToolResultEntry = {
      toolUseId,
      toolName,
      originalSize: resultSize,
      currentSize: resultSize,
      tokenEstimate,
      truncated: false,
      replaced: false,
      timestamp: Date.now(),
    };

    // Apply truncation if needed
    if (this.config.enableTruncation) {
      if (resultSize > this.config.maxSingleResultSize) {
        entry.currentSize = this.config.maxSingleResultSize;
        entry.truncated = true;
        entry.tokenEstimate = this.estimateTokens(entry.currentSize);
        logger.warn(`[ContentBudget] Truncated ${toolName} result from ${resultSize} to ${entry.currentSize} chars`);
      }
    }

    // Update state
    this.state.entries.set(toolUseId, entry);
    this.state.totalBudgetUsed += entry.tokenEstimate;
    this.state.totalBudgetRemaining = this.config.totalBudget - this.state.totalBudgetUsed;
    this.state.toolBudgetUsage[toolName] = (this.state.toolBudgetUsage[toolName] || 0) + entry.tokenEstimate;

    if (wouldExceedToolBudget) {
      logger.warn(`[ContentBudget] ${toolName} budget exceeded: ${currentToolUsage + entry.tokenEstimate} > ${toolBudget}`);
    }

    if (wouldExceedTotalBudget) {
      logger.warn(`[ContentBudget] Total budget exceeded: ${this.state.totalBudgetUsed} > ${this.config.totalBudget}`);
    }

    return entry;
  }

  /**
   * Replace tool result content
   */
  replaceToolResult(
    toolUseId: string,
    replacement: string,
    reason: string
  ): boolean {
    const entry = this.state.entries.get(toolUseId);
    if (!entry) return false;

    const oldTokenEstimate = entry.tokenEstimate;
    const newTokenEstimate = this.estimateTokens(replacement.length);

    // Update entry
    entry.currentSize = replacement.length;
    entry.tokenEstimate = newTokenEstimate;
    entry.replaced = true;

    // Update budget
    this.state.totalBudgetUsed += newTokenEstimate - oldTokenEstimate;
    this.state.totalBudgetRemaining = this.config.totalBudget - this.state.totalBudgetUsed;
    this.state.toolBudgetUsage[entry.toolName] =
      (this.state.toolBudgetUsage[entry.toolName] || 0) + newTokenEstimate - oldTokenEstimate;

    logger.info(`[ContentBudget] Replaced ${entry.toolName} result (${reason}): ${oldTokenEstimate} → ${newTokenEstimate} tokens`);

    return true;
  }

  /**
   * Check if a tool result should be compressed
   */
  shouldCompress(toolUseId: string): boolean {
    const entry = this.state.entries.get(toolUseId);
    if (!entry) return false;

    // Compress if:
    // 1. Result is large (> 20k chars)
    // 2. Budget is running low (< 20% remaining)
    // 3. Tool has high budget usage
    const isLargeResult = entry.currentSize > 20000;
    const isBudgetLow = this.state.totalBudgetRemaining < this.config.totalBudget * 0.2;
    const isHighUsage = entry.tokenEstimate > this.getToolBudget(entry.toolName) * 0.5;

    return isLargeResult || isBudgetLow || isHighUsage;
  }

  /**
   * Get compression suggestion for a tool result
   */
  getCompressionSuggestion(toolUseId: string): {
    shouldCompress: boolean;
    targetSize: number;
    reason: string;
  } | null {
    const entry = this.state.entries.get(toolUseId);
    if (!entry) return null;

    if (!this.shouldCompress(toolUseId)) {
      return null;
    }

    // Calculate target size based on budget state
    const budgetUsageRatio = this.state.totalBudgetUsed / this.config.totalBudget;
    let targetRatio: number;

    if (budgetUsageRatio > 0.8) {
      targetRatio = 0.3; // Aggressive compression
    } else if (budgetUsageRatio > 0.6) {
      targetRatio = 0.5; // Moderate compression
    } else {
      targetRatio = 0.7; // Light compression
    }

    const targetSize = Math.floor(entry.currentSize * targetRatio);
    const reason = budgetUsageRatio > 0.8
      ? 'Budget critically low'
      : budgetUsageRatio > 0.6
        ? 'Budget running low'
        : 'Large result';

    return {
      shouldCompress: true,
      targetSize,
      reason,
    };
  }

  /**
   * Get tool budget
   */
  private getToolBudget(toolName: string): number {
    return this.config.toolBudgets[toolName] || this.config.toolBudgets.default;
  }

  /**
   * Estimate tokens from character count
   */
  private estimateTokens(charCount: number): number {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(charCount / 4);
  }

  /**
   * Get current state
   */
  getState(): ContentReplacementState {
    return {
      entries: new Map(this.state.entries),
      totalBudgetUsed: this.state.totalBudgetUsed,
      totalBudgetRemaining: this.state.totalBudgetRemaining,
      toolBudgetUsage: { ...this.state.toolBudgetUsage },
    };
  }

  /**
   * Get budget usage summary
   */
  getBudgetSummary(): {
    totalBudget: number;
    totalUsed: number;
    totalRemaining: number;
    usagePercent: number;
    toolBreakdown: Record<string, { used: number; limit: number; percent: number }>;
  } {
    const toolBreakdown: Record<string, { used: number; limit: number; percent: number }> = {};

    for (const [toolName, limit] of Object.entries(this.config.toolBudgets)) {
      const used = this.state.toolBudgetUsage[toolName] || 0;
      toolBreakdown[toolName] = {
        used,
        limit,
        percent: Math.round((used / limit) * 100),
      };
    }

    return {
      totalBudget: this.config.totalBudget,
      totalUsed: this.state.totalBudgetUsed,
      totalRemaining: this.state.totalBudgetRemaining,
      usagePercent: Math.round((this.state.totalBudgetUsed / this.config.totalBudget) * 100),
      toolBreakdown,
    };
  }

  /**
   * Reset budget state
   */
  reset(): void {
    this.state = {
      entries: new Map(),
      totalBudgetUsed: 0,
      totalBudgetRemaining: this.config.totalBudget,
      toolBudgetUsage: {},
    };
    logger.info('[ContentBudget] Budget state reset');
  }

  /**
   * Export state for persistence
   */
  exportState(): {
    config: ContentBudgetConfig;
    state: {
      totalBudgetUsed: number;
      toolBudgetUsage: Record<string, number>;
      entryCount: number;
    };
  } {
    return {
      config: { ...this.config },
      state: {
        totalBudgetUsed: this.state.totalBudgetUsed,
        toolBudgetUsage: { ...this.state.toolBudgetUsage },
        entryCount: this.state.entries.size,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Instance
// ─────────────────────────────────────────────────────────────────────────────

export const contentBudgetManager = new ContentBudgetManager();

// ─────────────────────────────────────────────────────────────────────────────
// Convenience Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register a tool result with budget tracking
 */
export function registerToolResult(
  toolUseId: string,
  toolName: string,
  resultSize: number
): ToolResultEntry {
  return contentBudgetManager.registerToolResult(toolUseId, toolName, resultSize);
}

/**
 * Replace tool result content
 */
export function replaceToolResult(
  toolUseId: string,
  replacement: string,
  reason: string
): boolean {
  return contentBudgetManager.replaceToolResult(toolUseId, replacement, reason);
}

/**
 * Check if tool result should be compressed
 */
export function shouldCompress(toolUseId: string): boolean {
  return contentBudgetManager.shouldCompress(toolUseId);
}

/**
 * Get compression suggestion
 */
export function getCompressionSuggestion(toolUseId: string) {
  return contentBudgetManager.getCompressionSuggestion(toolUseId);
}

/**
 * Get budget summary
 */
export function getBudgetSummary() {
  return contentBudgetManager.getBudgetSummary();
}
