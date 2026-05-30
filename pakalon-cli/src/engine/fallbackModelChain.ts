/**
 * Fallback Model Chain
 *
 * Automatic model fallback on failure. When a model fails (rate limit,
 * auth error, capacity error), automatically try the next model in the
 * chain until one succeeds or all fail.
 *
 * Strategy:
 * 1. Define a chain of fallback models
 * 2. Try primary model first
 * 3. On failure, try next model in chain
 * 4. Track failures and switch permanently if needed
 * 5. Support custom fallback logic
 */

import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FallbackModelChainOptions {
  /** List of model IDs to try in order */
  modelChain: string[];
  /** Maximum retry attempts per model (default: 1) */
  maxRetriesPerModel?: number;
  /** Cooldown period after model failure in ms (default: 60000) */
  cooldownMs?: number;
  /** Callback when model fails */
  onModelFailure?: (modelId: string, error: Error) => void;
  /** Callback when model succeeds */
  onModelSuccess?: (modelId: string) => void;
  /** Custom failure classifier */
  isRetryableError?: (error: Error) => boolean;
}

export interface ModelFailure {
  modelId: string;
  error: Error;
  timestamp: Date;
  retryCount: number;
}

export interface ModelStatus {
  modelId: string;
  available: boolean;
  failureCount: number;
  lastFailure?: Date;
  cooldownUntil?: Date;
}

export interface FallbackChainResult<T> {
  /** The result from the successful model */
  result: T;
  /** Which model succeeded */
  successfulModel: string;
  /** Models that were tried and failed */
  failedModels: ModelFailure[];
  /** Total attempts made */
  totalAttempts: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if an error is retryable (should try next model).
 */
function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Rate limiting
  if (message.includes('rate_limit') || message.includes('429')) {
    return true;
  }

  // Auth errors (try next model)
  if (message.includes('unauthorized') || message.includes('401')) {
    return true;
  }

  // Capacity errors
  if (message.includes('capacity') || message.includes('503')) {
    return true;
  }

  // Timeout
  if (message.includes('timeout') || message.includes('etimedout')) {
    return true;
  }

  // Connection errors
  if (message.includes('econnreset') || message.includes('econnrefused')) {
    return true;
  }

  // Model-specific errors
  if (message.includes('model_not_found') || message.includes('model_not_available')) {
    return true;
  }

  // Context length (don't retry with different model)
  if (message.includes('context_length_exceeded') || message.includes('413')) {
    return false;
  }

  // Don't retry on auth permission errors
  if (message.includes('permission') || message.includes('forbidden')) {
    return false;
  }

  // Default: retry on network/server errors
  return message.includes('5') || message.includes('server');
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback Model Chain
// ─────────────────────────────────────────────────────────────────────────────

export class FallbackModelChain {
  private options: Required<FallbackModelChainOptions>;
  private modelStatuses: Map<string, ModelStatus> = new Map();
  private currentModelIndex = 0;

  constructor(options: FallbackModelChainOptions) {
    this.options = {
      maxRetriesPerModel: 1,
      cooldownMs: 60000,
      onModelFailure: () => {},
      onModelSuccess: () => {},
      isRetryableError,
      ...options,
    };

    // Initialize model statuses
    for (const modelId of this.options.modelChain) {
      this.modelStatuses.set(modelId, {
        modelId,
        available: true,
        failureCount: 0,
      });
    }
  }

  /**
   * Get the current model in the chain.
   */
  getCurrentModel(): string {
    return this.options.modelChain[this.currentModelIndex];
  }

  /**
   * Get status of all models.
   */
  getModelStatuses(): ModelStatus[] {
    return Array.from(this.modelStatuses.values());
  }

  /**
   * Check if a model is available (not in cooldown).
   */
  isModelAvailable(modelId: string): boolean {
    const status = this.modelStatuses.get(modelId);
    if (!status) return false;

    if (status.cooldownUntil && status.cooldownUntil > new Date()) {
      return false;
    }

    return status.available;
  }

  /**
   * Mark a model as failed and move to next in chain.
   */
  private markModelFailed(modelId: string, error: Error): void {
    const status = this.modelStatuses.get(modelId);
    if (!status) return;

    status.failureCount++;
    status.lastFailure = new Date();

    // Put model in cooldown
    status.cooldownUntil = new Date(Date.now() + this.options.cooldownMs);

    this.options.onModelFailure(modelId, error);

    logger.warn('[FallbackModelChain] Model failed', {
      modelId,
      failureCount: status.failureCount,
      error: error.message,
      cooldownUntil: status.cooldownUntil,
    });

    // Move to next model in chain
    this.moveToNextModel();
  }

  /**
   * Mark a model as successful.
   */
  private markModelSuccess(modelId: string): void {
    const status = this.modelStatuses.get(modelId);
    if (!status) return;

    // Reset failure count on success
    status.failureCount = 0;
    status.available = true;
    status.cooldownUntil = undefined;

    this.options.onModelSuccess(modelId);

    logger.debug('[FallbackModelChain] Model succeeded', { modelId });
  }

  /**
   * Move to next model in chain.
   */
  private moveToNextModel(): void {
    const nextIndex = this.currentModelIndex + 1;
    if (nextIndex < this.options.modelChain.length) {
      this.currentModelIndex = nextIndex;
      logger.debug('[FallbackModelChain] Moved to next model', {
        newModel: this.getCurrentModel(),
        index: this.currentModelIndex,
      });
    } else {
      logger.warn('[FallbackModelChain] No more models in chain');
    }
  }

  /**
   * Reset to the first model in chain.
   */
  reset(): void {
    this.currentModelIndex = 0;
    for (const status of this.modelStatuses.values()) {
      status.failureCount = 0;
      status.available = true;
      status.cooldownUntil = undefined;
    }
  }

  /**
   * Execute a request with fallback chain.
   */
  async execute<T>(
    requestFn: (modelId: string) => Promise<T>
  ): Promise<FallbackChainResult<T>> {
    const failedModels: ModelFailure[] = [];
    let totalAttempts = 0;

    logger.debug('[FallbackModelChain] Starting execution', {
      modelChain: this.options.modelChain,
      currentModel: this.getCurrentModel(),
    });

    // Try each model in the chain
    for (let i = 0; i < this.options.modelChain.length; i++) {
      const modelId = this.options.modelChain[i];

      // Skip if model is not available
      if (!this.isModelAvailable(modelId)) {
        logger.debug('[FallbackModelChain] Skipping unavailable model', {
          modelId,
        });
        continue;
      }

      // Try the model with retries
      for (let retry = 0; retry < this.options.maxRetriesPerModel; retry++) {
        totalAttempts++;

        try {
          const result = await requestFn(modelId);
          this.markModelSuccess(modelId);

          return {
            result,
            successfulModel: modelId,
            failedModels,
            totalAttempts,
          };
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));

          failedModels.push({
            modelId,
            error: err,
            timestamp: new Date(),
            retryCount: retry + 1,
          });

          // Check if error is retryable
          if (!this.options.isRetryableError(err)) {
            logger.debug('[FallbackModelChain] Non-retryable error', {
              modelId,
              error: err.message,
            });
            break; // Skip to next model
          }

          logger.debug('[FallbackModelChain] Retryable error', {
            modelId,
            retry: retry + 1,
            maxRetries: this.options.maxRetriesPerModel,
            error: err.message,
          });
        }
      }

      // Mark model as failed
      this.markModelFailed(modelId, failedModels[failedModels.length - 1]?.error || new Error('Unknown error'));
    }

    // All models failed
    throw new Error(
      `All models in chain failed after ${totalAttempts} attempts: ${failedModels.map(f => f.modelId).join(', ')}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a fallback model chain.
 */
export function createFallbackModelChain(
  options: FallbackModelChainOptions
): FallbackModelChain {
  return new FallbackModelChain(options);
}

/**
 * Create a fallback chain with common model presets.
 */
export function createDefaultFallbackChain(
  primaryModel: string
): FallbackModelChain {
  const modelChain = [primaryModel];

  // Add fallback models based on provider
  if (primaryModel.includes('claude')) {
    modelChain.push(
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3-haiku',
      'openai/gpt-4o'
    );
  } else if (primaryModel.includes('gpt')) {
    modelChain.push(
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3-haiku'
    );
  } else {
    // Generic fallbacks
    modelChain.push(
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o-mini'
    );
  }

  return new FallbackModelChain({ modelChain });
}

export default FallbackModelChain;