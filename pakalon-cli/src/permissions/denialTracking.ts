/**
 * Denial Tracking
 *
 * Tracks consecutive permission denials and provides fallback behavior
 * when users repeatedly deny tool requests. This improves UX by
 * preventing the agent from getting stuck in a deny loop.
 *
 * Strategy:
 * 1. Track consecutive denials per tool type
 * 2. After N denials, switch to prompting mode
 * 3. Provide suggestions to user
 * 4. Reset on allow or timeout
 */

import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DenialTrackingOptions {
  /** Maximum consecutive denials before fallback (default: 3) */
  maxConsecutiveDenials?: number;
  /** Timeout to reset denial count in ms (default: 300000 - 5 minutes) */
  resetTimeoutMs?: number;
  /** Whether to track per tool (default: true) */
  trackPerTool?: boolean;
  /** Callback when max denials reached */
  onMaxDenials?: (toolName: string, denialCount: number) => void;
  /** Callback when denial is tracked */
  onDenial?: (toolName: string, denialCount: number) => void;
}

export interface DenialRecord {
  toolName: string;
  count: number;
  lastDenial: Date;
  firstDenial: Date;
  timestamps: Date[];
}

export interface DenialStatus {
  toolName: string;
  denialCount: number;
  shouldFallback: boolean;
  suggestion: 'allow' | 'deny' | 'ask' | 'disable';
  message?: string;
}

export interface DenialTrackingResult {
  /** Whether the action should be allowed */
  allowed: boolean;
  /** Denial status for the tool */
  status: DenialStatus;
  /** All denial records */
  records: Map<string, DenialRecord>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Denial Tracking Manager
// ─────────────────────────────────────────────────────────────────────────────

export class DenialTrackingManager {
  private options: Required<DenialTrackingOptions>;
  private records: Map<string, DenialRecord> = new Map();
  private resetTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(options: DenialTrackingOptions = {}) {
    this.options = {
      maxConsecutiveDenials: 3,
      resetTimeoutMs: 300000, // 5 minutes
      trackPerTool: true,
      onMaxDenials: () => {},
      onDenial: () => {},
      ...options,
    };
  }

  /**
   * Record a denial for a tool.
   */
  recordDenial(toolName: string): DenialStatus {
    const now = new Date();
    const record = this.records.get(toolName);

    if (record) {
      // Check if we should reset (timeout exceeded)
      const timeSinceLastDenial = now.getTime() - record.lastDenial.getTime();
      if (timeSinceLastDenial > this.options.resetTimeoutMs) {
        // Reset count
        record.count = 1;
        record.firstDenial = now;
        record.timestamps = [now];
      } else {
        // Increment count
        record.count++;
        record.timestamps.push(now);
      }
      record.lastDenial = now;
    } else {
      // Create new record
      this.records.set(toolName, {
        toolName,
        count: 1,
        lastDenial: now,
        firstDenial: now,
        timestamps: [now],
      });
    }

    const currentRecord = this.records.get(toolName)!;

    // Clear existing reset timer
    if (this.resetTimers.has(toolName)) {
      clearTimeout(this.resetTimers.get(toolName)!);
    }

    // Set new reset timer
    const timer = setTimeout(() => {
      this.resetDenialCount(toolName);
    }, this.options.resetTimeoutMs);
    this.resetTimers.set(toolName, timer);

    // Check if we've reached max denials
    const shouldFallback = currentRecord.count >= this.options.maxConsecutiveDenials;

    if (shouldFallback) {
      this.options.onMaxDenials(toolName, currentRecord.count);
    } else {
      this.options.onDenial(toolName, currentRecord.count);
    }

    const status = this.getDenialStatus(toolName);

    logger.debug('[DenialTracking] Recorded denial', {
      toolName,
      denialCount: currentRecord.count,
      shouldFallback,
      suggestion: status.suggestion,
    });

    return status;
  }

  /**
   * Record an allowance for a tool (resets denial count).
   */
  recordAllowance(toolName: string): void {
    const record = this.records.get(toolName);
    if (record) {
      record.count = 0;
      record.timestamps = [];
    }

    // Clear reset timer
    if (this.resetTimers.has(toolName)) {
      clearTimeout(this.resetTimers.get(toolName)!);
      this.resetTimers.delete(toolName);
    }

    logger.debug('[DenialTracking] Recorded allowance', { toolName });
  }

  /**
   * Reset denial count for a tool.
   */
  resetDenialCount(toolName: string): void {
    this.records.delete(toolName);

    if (this.resetTimers.has(toolName)) {
      clearTimeout(this.resetTimers.get(toolName)!);
      this.resetTimers.delete(toolName);
    }

    logger.debug('[DenialTracking] Reset denial count', { toolName });
  }

  /**
   * Get denial status for a tool.
   */
  getDenialStatus(toolName: string): DenialStatus {
    const record = this.records.get(toolName);

    if (!record) {
      return {
        toolName,
        denialCount: 0,
        shouldFallback: false,
        suggestion: 'ask',
      };
    }

    const shouldFallback = record.count >= this.options.maxConsecutiveDenials;

    let suggestion: DenialStatus['suggestion'] = 'ask';
    let message: string | undefined;

    if (shouldFallback) {
      suggestion = 'allow';
      message = `User has denied ${toolName} ${record.count} times. Consider allowing or disabling this tool.`;
    } else if (record.count >= 2) {
      suggestion = 'ask';
      message = `User has denied ${toolName} ${record.count} times. Continue asking?`;
    }

    return {
      toolName,
      denialCount: record.count,
      shouldFallback,
      suggestion,
      message,
    };
  }

  /**
   * Get all denial records.
   */
  getAllRecords(): Map<string, DenialRecord> {
    return new Map(this.records);
  }

  /**
   * Get denial count for a tool.
   */
  getDenialCount(toolName: string): number {
    return this.records.get(toolName)?.count || 0;
  }

  /**
   * Check if a tool should be automatically allowed due to frequent denials.
   */
  shouldAutoAllow(toolName: string): boolean {
    const status = this.getDenialStatus(toolName);
    return status.shouldFallback && status.suggestion === 'allow';
  }

  /**
   * Clear all records and timers.
   */
  clear(): void {
    this.records.clear();
    for (const timer of this.resetTimers.values()) {
      clearTimeout(timer);
    }
    this.resetTimers.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a denial tracking manager.
 */
export function createDenialTrackingManager(
  options: DenialTrackingOptions = {}
): DenialTrackingManager {
  return new DenialTrackingManager(options);
}

/**
 * Create a strict denial tracker (1 denial triggers fallback).
 */
export function createStrictDenialTracker(): DenialTrackingManager {
  return new DenialTrackingManager({
    maxConsecutiveDenials: 1,
    resetTimeoutMs: 60000, // 1 minute
  });
}

/**
 * Create a lenient denial tracker (5 denials trigger fallback).
 */
export function createLenientDenialTracker(): DenialTrackingManager {
  return new DenialTrackingManager({
    maxConsecutiveDenials: 5,
    resetTimeoutMs: 600000, // 10 minutes
  });
}

export default DenialTrackingManager;