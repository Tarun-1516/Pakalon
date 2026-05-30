/**
 * Error Normalization Utilities
 *
 * Functions to normalize any thrown value into a consistent Error instance
 * or string representation.
 */

import { AppError } from './types.js';

/**
 * Normalize any thrown value to a string message.
 *
 * Handles: Error instances, strings, null/undefined, objects, primitives.
 */
export function errorMessage(err: unknown): string {
  if (err === null || err === undefined) {
    return 'Unknown error (null/undefined)';
  }

  if (typeof err === 'string') {
    return err;
  }

  if (typeof err === 'number' || typeof err === 'boolean') {
    return String(err);
  }

  if (err instanceof Error) {
    return err.message || err.name || 'Error with no message';
  }

  if (typeof err === 'object') {
    try {
      const obj = err as Record<string, unknown>;
      if ('message' in obj && typeof obj.message === 'string') {
        return obj.message;
      }
      if ('error' in obj && typeof obj.error === 'string') {
        return obj.error;
      }
      if ('reason' in obj && typeof obj.reason === 'string') {
        return obj.reason;
      }
      return JSON.stringify(err);
    } catch {
      return '[Object that could not be stringified]';
    }
  }

  return String(err);
}

/**
 * Convert any thrown value to an Error instance.
 *
 * If the value is already an Error, returns it directly.
 * If it's a string, wraps it in an AppError.
 * If it's null/undefined, returns a generic AppError.
 */
export function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }

  if (err === null || err === undefined) {
    return new AppError('Unknown error (null/undefined)', 'UNKNOWN_ERROR');
  }

  if (typeof err === 'string') {
    return new AppError(err, 'UNKNOWN_ERROR');
  }

  if (typeof err === 'number' || typeof err === 'boolean') {
    return new AppError(String(err), 'UNKNOWN_ERROR');
  }

  if (typeof err === 'object') {
    try {
      const obj = err as Record<string, unknown>;
      const message = typeof obj.message === 'string' ? obj.message : JSON.stringify(err);
      return new AppError(message, 'UNKNOWN_ERROR');
    } catch {
      return new AppError('[Object that could not be stringified]', 'UNKNOWN_ERROR');
    }
  }

  return new AppError(String(err), 'UNKNOWN_ERROR');
}

/**
 * Check if an error matches a specific error code.
 */
export function hasErrorCode(err: unknown, code: string): boolean {
  if (err instanceof AppError) {
    return err.code === code;
  }
  return false;
}

/**
 * Extract a structured error info object from any error.
 */
export function errorInfo(err: unknown): {
  message: string;
  code: string;
  name: string;
  stack?: string;
} {
  const error = toError(err);
  const code = error instanceof AppError ? error.code : 'UNKNOWN_ERROR';

  return {
    message: error.message,
    code,
    name: error.name,
    stack: error.stack,
  };
}
