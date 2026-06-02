/**
 * Shared backend HTTP helper for CLI tool wrappers.
 * Used by every new tool module.
 */

export interface BackendFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_BASE =
  process.env.PAKALON_BACKEND_URL ||
  process.env.PAKALON_API_URL ||
  "http://127.0.0.1:8000";

export async function backendFetch(
  path: string,
  opts: BackendFetchOptions = {},
): Promise<any> {
  const url = path.startsWith("http")
    ? path
    : `${DEFAULT_BASE.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
    body: opts.body,
    signal:
      typeof AbortSignal !== "undefined" && opts.timeoutMs
        ? AbortSignal.timeout(opts.timeoutMs)
        : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}
