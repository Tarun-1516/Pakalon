/**
 * Centralized API Client Service for pakalon-cli
 *
 * Provides a unified HTTP client with authentication, retry logic,
 * and error handling for all API calls.
 */

import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";

// ============================================================================
// Types
// ============================================================================

export type ApiClientConfig = {
  baseURL: string;
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
};

export type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
};

export type ApiResponse<T = unknown> = {
  data: T;
  status: number;
  headers: Record<string, string>;
};

export type ApiError = {
  message: string;
  status: number;
  code?: string;
};

// ============================================================================
// Token Storage
// ============================================================================

type StoredTokens = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

function getTokenPath(): string {
  return join(homedir(), ".config", "pakalon", "tokens.json");
}

async function loadTokens(): Promise<StoredTokens> {
  try {
    const content = await readFile(getTokenPath(), "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  const dir = join(homedir(), ".config", "pakalon");
  await mkdir(dir, { recursive: true });
  await writeFile(getTokenPath(), JSON.stringify(tokens, null, 2));
}

// ============================================================================
// API Client Implementation
// ============================================================================

class ApiClient {
  private config: ApiClientConfig;
  private tokenRefreshPromise: Promise<void> | null = null;

  constructor(config: ApiClientConfig) {
    this.config = {
      timeout: 30000,
      retries: 3,
      ...config,
    };
  }

  /**
   * Get stored access token
   */
  private async getAccessToken(): Promise<string | null> {
    const tokens = await loadTokens();
    return tokens.accessToken ?? null;
  }

  /**
   * Refresh access token using refresh token
   */
  private async refreshAccessToken(): Promise<void> {
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = (async () => {
      try {
        const tokens = await loadTokens();
        if (!tokens.refreshToken) {
          throw new Error("No refresh token available");
        }

        const response = await fetch(`${this.config.baseURL}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        });

        if (!response.ok) {
          throw new Error("Token refresh failed");
        }

        const data = (await response.json()) as {
          accessToken: string;
          refreshToken?: string;
          expiresIn?: number;
        };

        await saveTokens({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken ?? tokens.refreshToken,
          expiresAt: data.expiresIn
            ? Date.now() + data.expiresIn * 1000
            : undefined,
        });
      } finally {
        this.tokenRefreshPromise = null;
      }
    })();

    return this.tokenRefreshPromise;
  }

  /**
   * Make an HTTP request with retry logic
   */
  private async request<T>(
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const { method = "GET", headers = {}, body, timeout, signal } = options;

    // Get access token
    const accessToken = await this.getAccessToken();

    // Build headers
    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
      ...headers,
    };

    if (accessToken) {
      requestHeaders["Authorization"] = `Bearer ${accessToken}`;
    }

    // Build URL
    const url = `${this.config.baseURL}${endpoint}`;

    // Make request with retries
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= (this.config.retries ?? 3); attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          timeout ?? this.config.timeout ?? 30000
        );

        const response = await fetch(url, {
          method,
          headers: requestHeaders,
          body: body ? JSON.stringify(body) : undefined,
          signal: signal ?? controller.signal,
        });

        clearTimeout(timeoutId);

        // Handle 401 - try token refresh
        if (response.status === 401 && accessToken) {
          try {
            await this.refreshAccessToken();
            // Retry with new token
            continue;
          } catch {
            // Token refresh failed, throw the original error
          }
        }

        // Parse response
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const data = (await response.json()) as T;

        if (!response.ok) {
          throw {
            message: (data as { message?: string }).message ?? "Request failed",
            status: response.status,
            code: (data as { code?: string }).code,
          } as ApiError;
        }

        return {
          data,
          status: response.status,
          headers: responseHeaders,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on client errors (4xx)
        if (
          error &&
          typeof error === "object" &&
          "status" in error &&
          typeof (error as ApiError).status === "number" &&
          (error as ApiError).status >= 400 &&
          (error as ApiError).status < 500
        ) {
          throw error;
        }

        // Wait before retry (exponential backoff)
        if (attempt < (this.config.retries ?? 3)) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 10000))
          );
        }
      }
    }

    throw lastError ?? new Error("Request failed");
  }

  /**
   * GET request
   */
  async get<T>(
    endpoint: string,
    options?: Omit<RequestOptions, "method" | "body">
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: "GET" });
  }

  /**
   * POST request
   */
  async post<T>(
    endpoint: string,
    body?: unknown,
    options?: Omit<RequestOptions, "method">
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: "POST", body });
  }

  /**
   * PUT request
   */
  async put<T>(
    endpoint: string,
    body?: unknown,
    options?: Omit<RequestOptions, "method">
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: "PUT", body });
  }

  /**
   * DELETE request
   */
  async delete<T>(
    endpoint: string,
    options?: Omit<RequestOptions, "method" | "body">
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: "DELETE" });
  }

  /**
   * PATCH request
   */
  async patch<T>(
    endpoint: string,
    body?: unknown,
    options?: Omit<RequestOptions, "method">
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: "PATCH", body });
  }

  /**
   * Set access token
   */
  async setAccessToken(token: string): Promise<void> {
    const tokens = await loadTokens();
    await saveTokens({ ...tokens, accessToken: token });
  }

  /**
   * Set refresh token
   */
  async setRefreshToken(token: string): Promise<void> {
    const tokens = await loadTokens();
    await saveTokens({ ...tokens, refreshToken: token });
  }

  /**
   * Clear all tokens
   */
  async clearTokens(): Promise<void> {
    await saveTokens({});
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    const token = await this.getAccessToken();
    return !!token;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultClient: ApiClient | null = null;

/**
 * Get or create the default API client
 */
export function getApiClient(config?: ApiClientConfig): ApiClient {
  if (!defaultClient) {
    defaultClient = new ApiClient(
      config ?? {
        baseURL: process.env.PAKALON_API_URL ?? "https://api.pakalon.com",
      }
    );
  }
  return defaultClient;
}

/**
 * Create a new API client with custom config
 */
export function createApiClient(config: ApiClientConfig): ApiClient {
  return new ApiClient(config);
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Make a GET request using the default client
 */
export async function apiGet<T>(
  endpoint: string,
  options?: Omit<RequestOptions, "method" | "body">
): Promise<T> {
  const client = getApiClient();
  const response = await client.get<T>(endpoint, options);
  return response.data;
}

/**
 * Make a POST request using the default client
 */
export async function apiPost<T>(
  endpoint: string,
  body?: unknown,
  options?: Omit<RequestOptions, "method">
): Promise<T> {
  const client = getApiClient();
  const response = await client.post<T>(endpoint, body, options);
  return response.data;
}

/**
 * Make a PUT request using the default client
 */
export async function apiPut<T>(
  endpoint: string,
  body?: unknown,
  options?: Omit<RequestOptions, "method">
): Promise<T> {
  const client = getApiClient();
  const response = await client.put<T>(endpoint, body, options);
  return response.data;
}

/**
 * Make a DELETE request using the default client
 */
export async function apiDelete<T>(
  endpoint: string,
  options?: Omit<RequestOptions, "method" | "body">
): Promise<T> {
  const client = getApiClient();
  const response = await client.delete<T>(endpoint, options);
  return response.data;
}
