/**
 * HTTP Hooks
 *
 * Webhook POST with environment variable interpolation. Allows
 * executing HTTP requests as part of the hook system.
 *
 * Strategy:
 * 1. Define HTTP hook with URL, method, headers, body
 * 2. Interpolate environment variables in all fields
 * 3. Execute HTTP request with timeout
 * 4. Handle response and errors
 */

import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HttpHookOptions {
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Whether to follow redirects (default: true) */
  followRedirects?: boolean;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Whether to throw on non-2xx response (default: false) */
  throwOnError?: boolean;
  /** Callback for response */
  onResponse?: (response: HttpHookResponse) => void;
  /** Callback for error */
  onError?: (error: Error) => void;
}

export interface HttpHookDefinition {
  /** Unique hook ID */
  id: string;
  /** Hook name */
  name: string;
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** URL with environment variable placeholders */
  url: string;
  /** Headers with environment variable placeholders */
  headers?: Record<string, string>;
  /** Body with environment variable placeholders */
  body?: string | Record<string, unknown>;
  /** Content type (default: application/json) */
  contentType?: string;
  /** Whether hook is enabled (default: true) */
  enabled?: boolean;
  /** Hook timeout override in ms */
  timeout?: number;
  /** Whether to fire and forget (default: false) */
  fireAndForget?: boolean;
}

export interface HttpHookResponse {
  /** HTTP status code */
  status: number;
  /** Response headers */
  headers: Record<string, string>;
  /** Response body */
  body: unknown;
  /** Response time in ms */
  durationMs: number;
}

export interface HttpHookResult {
  /** Whether hook executed successfully */
  success: boolean;
  /** Response if successful */
  response?: HttpHookResponse;
  /** Error if failed */
  error?: string;
  /** Execution time in ms */
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment Variable Interpolation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interpolate environment variables in a string.
 * Supports: ${VAR_NAME}, $VAR_NAME, %{VAR_NAME}
 */
function interpolateEnvVars(value: string): string {
  return value
    .replace(/\$\{([^}]+)\}/g, (_, varName) => {
      return process.env[varName.trim()] || '';
    })
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, varName) => {
      return process.env[varName] || '';
    })
    .replace(/%\{([^}]+)\}/g, (_, varName) => {
      return process.env[varName.trim()] || '';
    });
}

/**
 * Recursively interpolate environment variables in an object.
 */
function interpolateObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return interpolateEnvVars(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(interpolateObject);
  }

  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateObject(value);
    }
    return result;
  }

  return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Hook Executor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute an HTTP hook.
 */
export async function executeHttpHook(
  hook: HttpHookDefinition,
  options: HttpHookOptions = {}
): Promise<HttpHookResult> {
  const {
    timeout = 30000,
    followRedirects = true,
    throwOnError = false,
    onResponse,
    onError,
  } = options;

  const startTime = Date.now();

  logger.debug('[HttpHook] Executing hook', {
    hookId: hook.id,
    hookName: hook.name,
    method: hook.method,
    url: hook.url,
  });

  try {
    // Interpolate environment variables
    const url = interpolateEnvVars(hook.url);
    const headers: Record<string, string> = {
      'Content-Type': hook.contentType || 'application/json',
      ...interpolateObject(hook.headers || {}),
    };
    const body = hook.body ? interpolateObject(hook.body) : undefined;

    // Build request options
    const fetchOptions: RequestInit = {
      method: hook.method,
      headers,
      redirect: followRedirects ? 'follow' : 'manual',
    };

    // Add body for non-GET requests
    if (hook.method !== 'GET' && body) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    // Execute request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), hook.timeout || timeout);
    fetchOptions.signal = controller.signal;

    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    // Parse response
    let responseBody: unknown;
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    const durationMs = Date.now() - startTime;

    const hookResponse: HttpHookResponse = {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
      durationMs,
    };

    onResponse?.(hookResponse);

    logger.debug('[HttpHook] Hook completed', {
      hookId: hook.id,
      status: response.status,
      durationMs,
    });

    // Check for error status
    if (!response.ok && throwOnError) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return {
      success: response.ok,
      response: hookResponse,
      durationMs,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const durationMs = Date.now() - startTime;

    onError?.(err);

    logger.error('[HttpHook] Hook failed', {
      hookId: hook.id,
      error: err.message,
      durationMs,
    });

    if (throwOnError) {
      throw err;
    }

    return {
      success: false,
      error: err.message,
      durationMs,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Hook Manager
// ─────────────────────────────────────────────────────────────────────────────

export class HttpHookManager {
  private hooks: Map<string, HttpHookDefinition> = new Map();
  private options: HttpHookOptions;

  constructor(options: HttpHookOptions = {}) {
    this.options = options;
  }

  /**
   * Register an HTTP hook.
   */
  register(hook: HttpHookDefinition): void {
    this.hooks.set(hook.id, hook);
    logger.debug('[HttpHook] Registered hook', {
      hookId: hook.id,
      hookName: hook.name,
    });
  }

  /**
   * Unregister an HTTP hook.
   */
  unregister(hookId: string): boolean {
    const result = this.hooks.delete(hookId);
    if (result) {
      logger.debug('[HttpHook] Unregistered hook', { hookId });
    }
    return result;
  }

  /**
   * Execute a registered hook.
   */
  async execute(hookId: string): Promise<HttpHookResult> {
    const hook = this.hooks.get(hookId);
    if (!hook) {
      return {
        success: false,
        error: `Hook ${hookId} not found`,
        durationMs: 0,
      };
    }

    if (hook.enabled === false) {
      return {
        success: false,
        error: `Hook ${hookId} is disabled`,
        durationMs: 0,
      };
    }

    return executeHttpHook(hook, this.options);
  }

  /**
   * Execute all registered hooks.
   */
  async executeAll(): Promise<HttpHookResult[]> {
    const results: HttpHookResult[] = [];

    for (const hookId of this.hooks.keys()) {
      const result = await this.execute(hookId);
      results.push(result);
    }

    return results;
  }

  /**
   * Get all registered hooks.
   */
  getHooks(): HttpHookDefinition[] {
    return Array.from(this.hooks.values());
  }

  /**
   * Clear all hooks.
   */
  clear(): void {
    this.hooks.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an HTTP hook manager.
 */
export function createHttpHookManager(
  options: HttpHookOptions = {}
): HttpHookManager {
  return new HttpHookManager(options);
}

/**
 * Create a simple webhook hook.
 */
export function createWebhookHook(
  id: string,
  url: string,
  options: {
    method?: HttpHookDefinition['method'];
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {}
): HttpHookDefinition {
  return {
    id,
    name: `webhook-${id}`,
    method: options.method || 'POST',
    url,
    headers: options.headers,
    body: options.body,
    contentType: 'application/json',
    enabled: true,
  };
}

export default HttpHookManager;