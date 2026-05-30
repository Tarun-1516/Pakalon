/**
 * AbortError - Cancellation handling for tool calls and agent operations.
 *
 * Thrown when an operation is cancelled via AbortSignal.
 */

export class AbortError extends Error {
  readonly name = 'AbortError';
  readonly signal?: AbortSignal;

  constructor(message?: string, signal?: AbortSignal) {
    super(message ?? 'Operation was aborted');
    this.signal = signal;
    Object.setPrototypeOf(this, AbortError.prototype);
  }
}

/**
 * Type guard to check if an error is an AbortError.
 */
export function isAbortError(error: unknown): error is AbortError {
  return error instanceof AbortError;
}

/**
 * Create an AbortError from a signal.
 */
export function createAbortError(signal: AbortSignal): AbortError {
  return new AbortError(
    signal.reason ? String(signal.reason) : 'Operation was aborted',
    signal,
  );
}
