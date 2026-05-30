/**
 * Retry Mechanisms
 *
 * Provides retry logic with exponential backoff and jitter for
 * transient failures (network errors, rate limits, timeouts).
 */

import { errorMessage } from './errorMessage.js';
import { isAbortError } from './AbortError.js';
import logger from '@/utils/logger.js';

/**
 * Retry configuration options.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Custom function to determine if an error is retryable */
  retryOn?: (error: Error, attempt: number) => boolean;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Callback invoked before each retry */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

/**
 * Default retryable error check: retries on network/timeout/rate-limit errors.
 */
function defaultRetryOn(error: Error): boolean {
  if (isAbortError(error)) return false;

  const message = errorMessage(error).toLowerCase();

  // Never retry on auth/permission errors
  if (message.includes('unauthorized') || message.includes('401')) return false;
  if (message.includes('forbidden') || message.includes('403')) return false;
  if (message.includes('permission')) return false;

  // Never retry on context length
  if (message.includes('context_length_exceeded') || message.includes('413')) return false;

  // Retry on rate limits
  if (message.includes('rate_limit') || message.includes('429')) return true;

  // Retry on capacity/overloaded
  if (message.includes('capacity') || message.includes('503') || message.includes('overloaded')) return true;

  // Retry on timeout
  if (message.includes('timeout') || message.includes('etimedout')) return true;

  // Retry on connection errors
  if (message.includes('econnreset') || message.includes('econnrefused') || message.includes('enotfound')) return true;

  // Retry on server errors (5xx)
  if (message.includes('500') || message.includes('502') || message.includes('504')) return true;

  // Retry on transient model errors
  if (message.includes('model_not_found') || message.includes('model_not_available')) return true;

  return false;
}

/**
 * Calculate delay with exponential backoff and jitter.
 */
function calculateDelay(attempt: number, options: Required<Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'backoffMultiplier'>>): number {
  const exponentialDelay = options.baseDelayMs * Math.pow(options.backoffMultiplier, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, options.maxDelayMs);
}

/**
 * Sleep for a specified duration, respecting abort signals.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ? new Error(String(signal.reason)) : new Error('Aborted'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ? new Error(String(signal.reason)) : new Error('Aborted'));
    }, { once: true });
  });
}

/**
 * Execute a function with retry logic and exponential backoff.
 *
 * @example
 * ```ts
 * const result = await retry(
 *   () => fetch('https://api.example.com/data'),
 *   { maxRetries: 3, baseDelayMs: 1000 }
 * );
 * ```
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const opts: Required<RetryOptions> = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    retryOn: defaultRetryOn,
    signal: undefined as unknown as AbortSignal,
    onRetry: undefined as unknown as () => void,
    ...options,
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    // Check abort before each attempt
    if (opts.signal?.aborted) {
      throw opts.signal.reason
        ? new Error(String(opts.signal.reason))
        : new Error('Operation aborted');
    }

    try {
      return await fn();
    } catch (err) {
      lastError = toError(err);

      // Don't retry if we're past max retries
      if (attempt >= opts.maxRetries) {
        break;
      }

      // Don't retry if error is not retryable
      if (!opts.retryOn(lastError, attempt + 1)) {
        break;
      }

      // Don't retry if aborted
      if (isAbortError(lastError)) {
        break;
      }

      // Calculate delay and wait
      const delayMs = calculateDelay(attempt, opts);

      logger.debug('[retry] Retrying after error', {
        attempt: attempt + 1,
        maxRetries: opts.maxRetries,
        delayMs: Math.round(delayMs),
        error: lastError.message,
      });

      if (opts.onRetry) {
        opts.onRetry(lastError, attempt + 1, delayMs);
      }

      await sleep(delayMs, opts.signal);
    }
  }

  throw lastError ?? new Error('Retry failed with unknown error');
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  return new Error(String(err));
}
