/**
 * Tool Service for pakalon-cli
 *
 * Provides centralized tool management, execution tracking, and orchestration.
 */

import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type ToolExecution = {
  id: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  success: boolean;
};

export type ToolStats = {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageDuration: number;
  toolBreakdown: Record<string, number>;
};

// ============================================================================
// Tool Service
// ============================================================================

class ToolService {
  private executions: Map<string, ToolExecution> = new Map();
  private maxExecutions: number;

  constructor(maxExecutions: number = 1000) {
    this.maxExecutions = maxExecutions;
  }

  /**
   * Record a tool execution
   */
  recordExecution(execution: ToolExecution): void {
    this.executions.set(execution.id, execution);

    // Trim old executions if we exceed max
    if (this.executions.size > this.maxExecutions) {
      const oldestKey = this.executions.keys().next().value;
      if (oldestKey) {
        this.executions.delete(oldestKey);
      }
    }

    logger.debug("[ToolService] Recorded execution:", {
      id: execution.id,
      tool: execution.toolName,
      success: execution.success,
    });
  }

  /**
   * Get execution by ID
   */
  getExecution(id: string): ToolExecution | undefined {
    return this.executions.get(id);
  }

  /**
   * Get all executions
   */
  getAllExecutions(): ToolExecution[] {
    return Array.from(this.executions.values());
  }

  /**
   * Get executions for a specific tool
   */
  getToolExecutions(toolName: string): ToolExecution[] {
    return this.getAllExecutions().filter((e) => e.toolName === toolName);
  }

  /**
   * Get tool statistics
   */
  getStats(): ToolStats {
    const executions = this.getAllExecutions();
    const successful = executions.filter((e) => e.success);
    const failed = executions.filter((e) => !e.success);

    const durations = executions
      .filter((e) => e.duration !== undefined)
      .map((e) => e.duration!);

    const averageDuration =
      durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0;

    const toolBreakdown: Record<string, number> = {};
    for (const execution of executions) {
      toolBreakdown[execution.toolName] =
        (toolBreakdown[execution.toolName] || 0) + 1;
    }

    return {
      totalExecutions: executions.length,
      successfulExecutions: successful.length,
      failedExecutions: failed.length,
      averageDuration,
      toolBreakdown,
    };
  }

  /**
   * Clear all executions
   */
  clear(): void {
    this.executions.clear();
    logger.info("[ToolService] Cleared all executions");
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultService: ToolService | null = null;

/**
 * Get or create the default Tool service
 */
export function getToolService(): ToolService {
  if (!defaultService) {
    defaultService = new ToolService();
  }
  return defaultService;
}

/**
 * Create a new Tool service
 */
export function createToolService(maxExecutions?: number): ToolService {
  return new ToolService(maxExecutions);
}
