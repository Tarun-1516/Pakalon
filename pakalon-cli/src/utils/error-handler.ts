/**
 * Error Handler
 *
 * Provides exponential backoff, error classification, and retry logic.
 */

import logger from './logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorCategory =
  | 'network'
  | 'rate-limit'
  | 'auth'
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'server'
  | 'client'
  | 'unknown';

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ClassifiedError {
  /** Original error */
  originalError: Error;
  /** Error category */
  category: ErrorCategory;
  /** Error severity */
  severity: ErrorSeverity;
  /** Whether error is retryable */
  retryable: boolean;
  /** Suggested retry delay in milliseconds */
  retryDelay?: number;
  /** HTTP status code (if applicable) */
  statusCode?: number;
  /** Human-readable message */
  message: string;
}

export interface RetryConfig {
  /** Maximum number of retries */
  maxRetries: number;
  /** Initial delay in milliseconds */
  initialDelay: number;
  /** Maximum delay in milliseconds */
  maxDelay: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
  /** Add jitter to delay */
  jitter: boolean;
  /** Custom retry predicate */
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Error Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify an error based on its message and properties
 */
export function classifyError(error: Error): ClassifiedError {
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();
  
  // Network errors
  if (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('network') ||
    message.includes('fetch failed') ||
    name === 'networkerror'
  ) {
    return {
      originalError: error,
      category: 'network',
      severity: 'medium',
      retryable: true,
      retryDelay: 1000,
      message: `Network error: ${error.message}`,
    };
  }

  // Rate limiting
  if (
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('429') ||
    message.includes('throttl')
  ) {
    // Try to extract retry-after header
    const retryAfterMatch = message.match(/retry[_-]?after[:\s]*(\d+)/i);
    const retryDelay = retryAfterMatch ? parseInt(retryAfterMatch[1]!) * 1000 : 5000;

    return {
      originalError: error,
      category: 'rate-limit',
      severity: 'medium',
      retryable: true,
      retryDelay,
      message: `Rate limited: ${error.message}`,
    };
  }

  // Authentication errors
  if (
    message.includes('unauthorized') ||
    message.includes('401') ||
    message.includes('invalid token') ||
    message.includes('expired') ||
    message.includes('authentication')
  ) {
    return {
      originalError: error,
      category: 'auth',
      severity: 'high',
      retryable: false,
      message: `Authentication error: ${error.message}`,
    };
  }

  // Validation errors
  if (
    message.includes('validation') ||
    message.includes('invalid') ||
    message.includes('bad request') ||
    message.includes('400')
  ) {
    return {
      originalError: error,
      category: 'validation',
      severity: 'low',
      retryable: false,
      message: `Validation error: ${error.message}`,
    };
  }

  // Not found
  if (
    message.includes('not found') ||
    message.includes('404') ||
    message.includes('does not exist')
  ) {
    return {
      originalError: error,
      category: 'not-found',
      severity: 'low',
      retryable: false,
      message: `Not found: ${error.message}`,
    };
  }

  // Conflict
  if (
    message.includes('conflict') ||
    message.includes('409') ||
    message.includes('already exists')
  ) {
    return {
      originalError: error,
      category: 'conflict',
      severity: 'medium',
      retryable: false,
      message: `Conflict: ${error.message}`,
    };
  }

  // Server errors (5xx)
  if (
    message.includes('500') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
    message.includes('internal server error') ||
    message.includes('bad gateway') ||
    message.includes('service unavailable')
  ) {
    return {
      originalError: error,
      category: 'server',
      severity: 'high',
      retryable: true,
      retryDelay: 2000,
      message: `Server error: ${error.message}`,
    };
  }

  // Client errors (4xx)
  if (
    message.includes('400') ||
    message.includes('403') ||
    message.includes('405') ||
    message.includes('408')
  ) {
    return {
      originalError: error,
      category: 'client',
      severity: 'medium',
      retryable: message.includes('408'), // Only timeout is retryable
      message: `Client error: ${error.message}`,
    };
  }

  // Unknown
  return {
    originalError: error,
    category: 'unknown',
    severity: 'medium',
    retryable: false,
    message: `Unknown error: ${error.message}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exponential Backoff
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate retry delay with exponential backoff
 */
export function calculateRetryDelay(
  attempt: number,
  config: Partial<RetryConfig> = {}
): number {
  const { initialDelay, maxDelay, backoffMultiplier, jitter } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  let delay = initialDelay * Math.pow(backoffMultiplier, attempt);
  delay = Math.min(delay, maxDelay);

  if (jitter) {
    // Add ±20% jitter
    const jitterRange = delay * 0.2;
    delay += (Math.random() - 0.5) * 2 * jitterRange;
  }

  return Math.max(0, Math.round(delay));
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a function with retry logic and exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const { maxRetries, shouldRetry } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const classified = classifyError(lastError);

      // Log the error
      logger.warn(
        `[Retry] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${classified.message}`
      );

      // Check if we should retry
      if (attempt >= maxRetries) {
        break;
      }

      if (!classified.retryable) {
        logger.warn(`[Retry] Error not retryable: ${classified.category}`);
        break;
      }

      if (shouldRetry && !shouldRetry(lastError, attempt)) {
        logger.warn(`[Retry] Custom retry predicate returned false`);
        break;
      }

      // Calculate delay
      const delay = classified.retryDelay || calculateRetryDelay(attempt, config);
      logger.info(`[Retry] Waiting ${delay}ms before retry...`);

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an error with additional context
 */
export function wrapError(
  error: Error,
  context: string,
  additionalInfo?: Record<string, unknown>
): Error {
  const wrapped = new Error(`${context}: ${error.message}`);
  wrapped.name = error.name;
  wrapped.stack = error.stack;

  // Add additional info to the error
  (wrapped as any).context = context;
  (wrapped as any).additionalInfo = additionalInfo;
  (wrapped as any).originalError = error;

  return wrapped;
}

/**
 * Create a user-friendly error message
 */
export function createUserFriendlyMessage(error: Error): string {
  const classified = classifyError(error);

  switch (classified.category) {
    case 'network':
      return 'Unable to connect to the server. Please check your internet connection and try again.';
    case 'rate-limit':
      return 'Too many requests. Please wait a moment and try again.';
    case 'auth':
      return 'Authentication failed. Please log in again.';
    case 'validation':
      return 'Invalid input. Please check your request and try again.';
    case 'not-found':
      return 'The requested resource was not found.';
    case 'conflict':
      return 'A conflict occurred. Please refresh and try again.';
    case 'server':
      return 'The server encountered an error. Please try again later.';
    case 'client':
      return 'Invalid request. Please check your input.';
    default:
      return 'An unexpected error occurred. Please try again.';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Error Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Global error handler for unhandled errors
 */
export function setupGlobalErrorHandler(): void {
  process.on('uncaughtException', (error) => {
    logger.error('[Global Error] Uncaught exception:', error);
    // Don't exit immediately, let the process finish current operations
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('[Global Error] Unhandled rejection:', reason);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const errorHandler = {
  classifyError,
  calculateRetryDelay,
  withRetry,
  wrapError,
  createUserFriendlyMessage,
  setupGlobalErrorHandler,
};

export default errorHandler;
