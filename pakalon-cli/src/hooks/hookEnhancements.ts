/**
 * Hook Enhancements
 *
 * Additional hook capabilities:
 * - async/asyncRewake: Fire-and-forget hooks with re-wake capability
 * - once flag: Run hook only once per session
 * - timeout configuration: Per-hook timeout
 */

import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HookEnhancementOptions {
  /** Hook timeout in ms (default: 30000) */
  timeout?: number;
  /** Whether hook runs only once (default: false) */
  once?: boolean;
  /** Whether hook is fire-and-forget (default: false) */
  fireAndForget?: boolean;
  /** Callback when hook completes */
  onComplete?: (result: HookResult) => void;
  /** Callback when hook times out */
  onTimeout?: (hookId: string) => void;
  /** Callback for re-wake (async mode) */
  onRewake?: (hookId: string) => void;
}

export interface HookResult {
  /** Hook ID */
  hookId: string;
  /** Whether hook succeeded */
  success: boolean;
  /** Hook output */
  output?: unknown;
  /** Error message if failed */
  error?: string;
  /** Execution time in ms */
  durationMs: number;
  /** Whether hook timed out */
  timedOut?: boolean;
  /** Whether hook was skipped (once flag) */
  skipped?: boolean;
}

export interface AsyncHookState {
  /** Hook ID */
  hookId: string;
  /** Whether hook is running */
  running: boolean;
  /** Whether hook has completed */
  completed: boolean;
  /** Whether hook should re-wake on completion */
  rewake: boolean;
  /** Start time */
  startTime: Date;
  /** Completion time */
  completionTime?: Date;
  /** Result */
  result?: HookResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook Timeout Manager
// ─────────────────────────────────────────────────────────────────────────────

export class HookTimeoutManager {
  private timeouts: Map<string, NodeJS.Timeout> = new Map();
  private onTimeout?: (hookId: string) => void;

  constructor(onTimeout?: (hookId: string) => void) {
    this.onTimeout = onTimeout;
  }

  /**
   * Set timeout for a hook.
   */
  set(hookId: string, timeoutMs: number, callback: () => void): void {
    // Clear existing timeout
    this.clear(hookId);

    const timer = setTimeout(() => {
      this.timeouts.delete(hookId);
      this.onTimeout?.(hookId);
      callback();
    }, timeoutMs);

    this.timeouts.set(hookId, timer);
  }

  /**
   * Clear timeout for a hook.
   */
  clear(hookId: string): void {
    const timer = this.timeouts.get(hookId);
    if (timer) {
      clearTimeout(timer);
      this.timeouts.delete(hookId);
    }
  }

  /**
   * Clear all timeouts.
   */
  clearAll(): void {
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook Once Manager
// ─────────────────────────────────────────────────────────────────────────────

export class HookOnceManager {
  private executedHooks: Set<string> = new Set();
  private sessionExecutedHooks: Set<string> = new Set();

  /**
   * Check if a hook has been executed.
   */
  hasExecuted(hookId: string, perSession: boolean = true): boolean {
    if (perSession) {
      return this.sessionExecutedHooks.has(hookId);
    }
    return this.executedHooks.has(hookId);
  }

  /**
   * Mark a hook as executed.
   */
  markExecuted(hookId: string, perSession: boolean = true): void {
    if (perSession) {
      this.sessionExecutedHooks.add(hookId);
    }
    this.executedHooks.add(hookId);
  }

  /**
   * Reset session-executed hooks.
   */
  resetSession(): void {
    this.sessionExecutedHooks.clear();
  }

  /**
   * Clear all executed hooks.
   */
  clear(): void {
    this.executedHooks.clear();
    this.sessionExecutedHooks.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Hook Manager (Fire-and-Forget with Re-wake)
// ─────────────────────────────────────────────────────────────────────────────

export class AsyncHookManager {
  private hooks: Map<string, AsyncHookState> = new Map();
  private rewakeCallbacks: Map<string, () => void> = new Map();

  /**
   * Start an async hook (fire-and-forget).
   */
  start(hookId: string, rewake: boolean = false): void {
    this.hooks.set(hookId, {
      hookId,
      running: true,
      completed: false,
      rewake,
      startTime: new Date(),
    });
  }

  /**
   * Complete an async hook.
   */
  complete(hookId: string, result: HookResult): void {
    const state = this.hooks.get(hookId);
    if (!state) return;

    state.running = false;
    state.completed = true;
    state.completionTime = new Date();
    state.result = result;

    // Trigger re-wake if enabled
    if (state.rewake) {
      const callback = this.rewakeCallbacks.get(hookId);
      if (callback) {
        callback();
      }
    }
  }

  /**
   * Register re-wake callback.
   */
  onRewake(hookId: string, callback: () => void): void {
    this.rewakeCallbacks.set(hookId, callback);
  }

  /**
   * Check if a hook is running.
   */
  isRunning(hookId: string): boolean {
    return this.hooks.get(hookId)?.running || false;
  }

  /**
   * Check if a hook has completed.
   */
  hasCompleted(hookId: string): boolean {
    return this.hooks.get(hookId)?.completed || false;
  }

  /**
   * Get hook state.
   */
  getState(hookId: string): AsyncHookState | undefined {
    return this.hooks.get(hookId);
  }

  /**
   * Clear all hook states.
   */
  clear(): void {
    this.hooks.clear();
    this.rewakeCallbacks.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Enhanced Hook Executor
// ─────────────────────────────────────────────────────────────────────────────

export class EnhancedHookExecutor {
  private timeoutManager: HookTimeoutManager;
  private onceManager: HookOnceManager;
  private asyncManager: AsyncHookManager;
  private options: Required<HookEnhancementOptions>;

  constructor(options: HookEnhancementOptions = {}) {
    this.options = {
      timeout: 30000,
      once: false,
      fireAndForget: false,
      onComplete: () => {},
      onTimeout: () => {},
      onRewake: () => {},
      ...options,
    };

    this.timeoutManager = new HookTimeoutManager(this.options.onTimeout);
    this.onceManager = new HookOnceManager();
    this.asyncManager = new AsyncHookManager();
  }

  /**
   * Execute a hook with enhancements.
   */
  async execute<T>(
    hookId: string,
    hookFn: () => Promise<T>,
    options: HookEnhancementOptions = {}
  ): Promise<HookResult> {
    const mergedOptions = { ...this.options, ...options };
    const startTime = Date.now();

    // Check once flag
    if (mergedOptions.once && this.onceManager.hasExecuted(hookId)) {
      return {
        hookId,
        success: true,
        output: undefined,
        durationMs: 0,
        skipped: true,
      };
    }

    // Check if async (fire-and-forget)
    if (mergedOptions.fireAndForget) {
      this.asyncManager.start(hookId, false);

      // Execute without waiting
      hookFn()
        .then((output) => {
          const result: HookResult = {
            hookId,
            success: true,
            output,
            durationMs: Date.now() - startTime,
          };
          this.asyncManager.complete(hookId, result);
          this.onceManager.markExecuted(hookId);
          mergedOptions.onComplete(result);
        })
        .catch((error) => {
          const result: HookResult = {
            hookId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startTime,
          };
          this.asyncManager.complete(hookId, result);
          mergedOptions.onComplete(result);
        });

      return {
        hookId,
        success: true,
        output: undefined,
        durationMs: 0,
      };
    }

    // Synchronous execution with timeout
    return new Promise<HookResult>((resolve) => {
      // Set timeout
      this.timeoutManager.set(hookId, mergedOptions.timeout, () => {
        resolve({
          hookId,
          success: false,
          error: `Hook ${hookId} timed out after ${mergedOptions.timeout}ms`,
          durationMs: Date.now() - startTime,
          timedOut: true,
        });
      });

      hookFn()
        .then((output) => {
          this.timeoutManager.clear(hookId);
          const result: HookResult = {
            hookId,
            success: true,
            output,
            durationMs: Date.now() - startTime,
          };
          this.onceManager.markExecuted(hookId);
          mergedOptions.onComplete(result);
          resolve(result);
        })
        .catch((error) => {
          this.timeoutManager.clear(hookId);
          const result: HookResult = {
            hookId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startTime,
          };
          this.onceManager.markExecuted(hookId);
          mergedOptions.onComplete(result);
          resolve(result);
        });
    });
  }

  /**
   * Clear all states.
   */
  clear(): void {
    this.timeoutManager.clearAll();
    this.onceManager.clear();
    this.asyncManager.clear();
  }

  /**
   * Reset session state.
   */
  resetSession(): void {
    this.onceManager.resetSession();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an enhanced hook executor.
 */
export function createEnhancedHookExecutor(
  options: HookEnhancementOptions = {}
): EnhancedHookExecutor {
  return new EnhancedHookExecutor(options);
}

export default EnhancedHookExecutor;