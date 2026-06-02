/**
 * OAuth 2.0 / 2.1 + PKCE helper used by Pakalon-CLI.
 *
 * Implements:
 *  - RFC 7636: Proof Key for Code Exchange (PKCE) using S256.
 *  - RFC 6749: Authorization Code flow.
 *  - RFC 8628: Device Authorization Grant (helper class, see deviceCodeGrant).
 *  - Loopback redirect (RFC 8252 §7.3): start a tiny HTTP server on
 *    127.0.0.1, capture the `?code=…&state=…` redirect, then shut down.
 *  - Token persistence in `~/.config/pakalon/oauth.json` (per-provider).
 *  - Token refresh (with clock-skew leeway).
 *  - Reusable `OAuthClient` base class for provider-specific clients.
 */
import {
  createHash,
  randomBytes,
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { redactSensitive, sanitizeUnicode } from "@/utils/safe-string.js";

// ─────────────────────────────────────────────────────────────────────────────
// PKCE
// ─────────────────────────────────────────────────────────────────────────────

const PKCE_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** RFC 7636 code_verifier (43-128 chars from the unreserved set). */
export function generateCodeVerifier(length = 64): string {
  if (length < 43 || length > 128) {
    throw new OAuthError(
      `PKCE code_verifier length must be 43-128, got ${length}`,
      "invalid_pkce",
    );
  }
  // Generate using randomBytes; map each byte to one PKCE char (no padding).
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PKCE_CHARSET[bytes[i] % PKCE_CHARSET.length];
  }
  return out;
}

/** RFC 7636 §4.2: code_challenge = BASE64URL(SHA-256(ASCII(code_verifier))). */
export function codeChallengeS256(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  expires_at?: number; // ms epoch
  /** Raw provider response. */
  raw?: Record<string, unknown>;
}

export interface OAuthErrorBody {
  error: string;
  error_description?: string;
  error_uri?: string;
}

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body?: OAuthErrorBody;
  constructor(
    message: string,
    code: string,
    status = 0,
    body?: OAuthErrorBody,
  ) {
    super(redactSensitive(message));
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// State generation / CSRF
// ─────────────────────────────────────────────────────────────────────────────

export function generateState(length = 32): string {
  return base64UrlEncode(randomBytes(length));
}

// ─────────────────────────────────────────────────────────────────────────────
// Loopback redirect
// ─────────────────────────────────────────────────────────────────────────────

export interface LoopbackResult {
  code: string;
  state: string;
  /** Bound port (so callers can free it). */
  port: number;
}

export interface LoopbackOptions {
  /** Hostname to bind (default 127.0.0.1). */
  hostname?: string;
  /** Port to bind (default 0 = ephemeral). */
  port?: number;
  /** Path to listen on (default "/callback"). */
  path?: string;
  /** Max wait time in ms (default 120_000 = 2min). */
  timeoutMs?: number;
  /** HTML response sent to the user after a successful code capture. */
  successHtml?: string;
  /** HTML response sent to the user after a failed capture. */
  errorHtml?: string;
  signal?: AbortSignal;
}

/**
 * Start a one-shot HTTP server on a loopback interface to capture the
 * OAuth provider's redirect.
 *
 * Spec: https://www.rfc-editor.org/rfc/rfc8252#section-7.3
 */
export async function waitForLoopbackRedirect(
  expectedState: string,
  options: LoopbackOptions = {},
): Promise<LoopbackResult> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  const path = options.path ?? "/callback";
  const timeoutMs = options.timeoutMs ?? 120_000;
  const successHtml =
    options.successHtml ??
    "<h1>Login successful</h1><p>You can close this tab and return to Pakalon.</p>";
  const errorHtml =
    options.errorHtml ??
    "<h1>Login failed</h1><p>See your terminal for details.</p>";

  return new Promise<LoopbackResult>((resolve, reject) => {
    let boundPort = port;
    const server: Server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        try {
          const url = new URL(req.url ?? "/", `http://${hostname}:${boundPort}`);
          if (url.pathname !== path) {
            res.statusCode = 404;
            res.end("Not Found");
            return;
          }
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const err = url.searchParams.get("error");
          if (err) {
            res.statusCode = 400;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(errorHtml);
            cleanup();
            reject(
              new OAuthError(
                `OAuth error: ${err} ${url.searchParams.get("error_description") ?? ""}`.trim(),
                "provider_error",
                400,
                {
                  error: err,
                  error_description:
                    url.searchParams.get("error_description") ?? undefined,
                },
              ),
            );
            return;
          }
          if (!code || !state) {
            res.statusCode = 400;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(errorHtml);
            cleanup();
            reject(
              new OAuthError("Missing code or state in redirect", "invalid_redirect"),
            );
            return;
          }
          if (state !== expectedState) {
            res.statusCode = 400;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(errorHtml);
            cleanup();
            reject(
              new OAuthError(
                "State mismatch — possible CSRF or stale redirect",
                "state_mismatch",
              ),
            );
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(successHtml);
          cleanup();
          resolve({ code, state, port: boundPort });
        } catch (e) {
          res.statusCode = 500;
          res.end("Internal error");
          cleanup();
          reject(e);
        }
      },
    );

    let timeoutHandle: NodeJS.Timeout | null = null;
    const onAbort = () => {
      cleanup();
      reject(new OAuthError("Aborted", "aborted"));
    };

    function cleanup() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (options.signal) options.signal?.removeEventListener("abort", onAbort);
      try {
        server.close();
      } catch {
        // ignore
      }
    }

    server.on("error", (e: Error & { code?: string }) => {
      if (e.code === "EADDRINUSE" && port !== 0) {
        cleanup();
        reject(
          new OAuthError(
            `Port ${port} already in use on ${hostname}`,
            "port_in_use",
          ),
        );
        return;
      }
      cleanup();
      reject(e);
    });

    server.listen(port, hostname, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        boundPort = addr.port;
      }
      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(
          new OAuthError(
            `Timed out waiting for redirect after ${timeoutMs}ms`,
            "timeout",
          ),
        );
      }, timeoutMs);
      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
  });
}

/** Pick a free ephemeral port (returns it without keeping it bound). */
export async function pickFreePort(hostname = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, hostname, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close();
        reject(new OAuthError("Could not pick port", "port_pick_failed"));
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// URL builders / form encoding
// ─────────────────────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string | string[];
  state: string;
  codeChallenge: string;
  /** Extra params (prompt, audience, login_hint, ...). */
  extra?: Record<string, string>;
  /** Provider-specific: "code" for auth-code + PKCE. */
  responseType?: string;
}): string {
  const url = new URL(opts.authorizationEndpoint);
  url.searchParams.set("response_type", opts.responseType ?? "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set(
    "scope",
    Array.isArray(opts.scope) ? opts.scope.join(" ") : opts.scope,
  );
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

/** application/x-www-form-urlencoded body encoder (RFC 6749 §4.1.3 style). */
export function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Token endpoints
// ─────────────────────────────────────────────────────────────────────────────

export async function exchangeCodeForToken(opts: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  /** Confidential clients may also send `clientSecret`. */
  clientSecret?: string;
  codeVerifier: string;
  /** Basic auth header alternative for confidential clients. */
  basicAuth?: boolean;
  signal?: AbortSignal;
  /** Per-provider extra params. */
  extra?: Record<string, string>;
  /** Override HTTP headers. */
  extraHeaders?: Record<string, string>;
}): Promise<OAuthTokens> {
  const body = formEncode({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
    ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
    ...(opts.extra ?? {}),
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    ...(opts.extraHeaders ?? {}),
  };
  if (opts.basicAuth && opts.clientSecret) {
    headers.authorization = `Basic ${base64UrlEncode(
      Buffer.from(`${opts.clientId}:${opts.clientSecret}`),
    )}`;
  }
  const res = await fetch(opts.tokenEndpoint, {
    method: "POST",
    headers,
    body,
    signal: opts.signal,
  });
  if (!res.ok) {
    const errBody = (await safeJson(res)) as Partial<OAuthErrorBody> & {
      access_token?: string;
    };
    throw new OAuthError(
      `Token exchange failed: ${res.status} ${errBody.error ?? ""} ${errBody.error_description ?? ""}`.trim(),
      errBody.error ?? "exchange_failed",
      res.status,
      errBody as OAuthErrorBody,
    );
  }
  return parseTokenResponse(res, await safeJson(res));
}

export async function refreshToken(opts: {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  basicAuth?: boolean;
  signal?: AbortSignal;
  extra?: Record<string, string>;
  extraHeaders?: Record<string, string>;
}): Promise<OAuthTokens> {
  const body = formEncode({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
    ...(opts.extra ?? {}),
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    ...(opts.extraHeaders ?? {}),
  };
  if (opts.basicAuth && opts.clientSecret) {
    headers.authorization = `Basic ${base64UrlEncode(
      Buffer.from(`${opts.clientId}:${opts.clientSecret}`),
    )}`;
  }
  const res = await fetch(opts.tokenEndpoint, {
    method: "POST",
    headers,
    body,
    signal: opts.signal,
  });
  if (!res.ok) {
    const errBody = (await safeJson(res)) as Partial<OAuthErrorBody>;
    throw new OAuthError(
      `Token refresh failed: ${res.status} ${errBody.error ?? ""} ${errBody.error_description ?? ""}`.trim(),
      errBody.error ?? "refresh_failed",
      res.status,
      errBody as OAuthErrorBody,
    );
  }
  return parseTokenResponse(res, await safeJson(res));
}

function parseTokenResponse(
  res: Response,
  json: any,
): OAuthTokens {
  if (json?.error) {
    throw new OAuthError(
      `Provider returned error: ${json.error} ${json.error_description ?? ""}`.trim(),
      json.error,
      res.status,
      {
        error: json.error,
        error_description: json.error_description,
        error_uri: json.error_uri,
      },
    );
  }
  const expires_in = typeof json.expires_in === "number" ? json.expires_in : undefined;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    id_token: json.id_token,
    token_type: json.token_type,
    scope: json.scope,
    expires_at: expires_in ? Date.now() + expires_in * 1000 : undefined,
    raw: json,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Device authorization grant (RFC 8628)
// ─────────────────────────────────────────────────────────────────────────────

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
  /** Some providers (e.g. GitHub) omit "scope". */
  scope?: string;
}

export interface DeviceCodeOptions {
  deviceAuthorizationEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scope: string | string[];
  signal?: AbortSignal;
  extra?: Record<string, string>;
}

export async function deviceCodeGrant(
  opts: DeviceCodeOptions,
): Promise<DeviceCodeResponse> {
  const body = formEncode({
    client_id: opts.clientId,
    scope: Array.isArray(opts.scope) ? opts.scope.join(" ") : opts.scope,
    ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
    ...(opts.extra ?? {}),
  });
  const res = await fetch(opts.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    signal: opts.signal,
  });
  if (!res.ok) {
    const errBody = (await safeJson(res)) as Partial<OAuthErrorBody>;
    throw new OAuthError(
      `Device code request failed: ${res.status} ${errBody.error ?? ""}`.trim(),
      errBody.error ?? "device_code_failed",
      res.status,
      errBody as OAuthErrorBody,
    );
  }
  const json = (await res.json()) as DeviceCodeResponse;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new OAuthError(
      "Provider returned an invalid device_code response",
      "invalid_device_code",
    );
  }
  return json;
}

export interface DeviceCodePollOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
  signal?: AbortSignal;
  /** Override the polling pace when the provider returns 429. */
  onSlowDown?: (retryAfterMs: number) => void;
  extra?: Record<string, string>;
}

export async function deviceCodePoll(
  opts: DeviceCodePollOptions,
): Promise<OAuthTokens> {
  const start = Date.now();
  let interval = Math.max(1, opts.interval);
  while (Date.now() - start < opts.expiresIn * 1000) {
    if (opts.signal?.aborted) {
      throw new OAuthError("Aborted", "aborted");
    }
    await sleep(interval * 1000);
    const body = formEncode({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: opts.deviceCode,
      client_id: opts.clientId,
      ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
      ...(opts.extra ?? {}),
    });
    const res = await fetch(opts.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
      signal: opts.signal,
    });
    const json = (await safeJson(res)) as Record<string, unknown>;
    if (res.ok) {
      return parseTokenResponse(res, json);
    }
    const errCode = typeof json.error === "string" ? json.error : "";
    if (errCode === "authorization_pending") continue;
    if (errCode === "slow_down") {
      interval += 5;
      opts.onSlowDown?.(interval * 1000);
      continue;
    }
    if (errCode === "expired_token") {
      throw new OAuthError("Device code expired", "expired_token", 400, {
        error: errCode,
      });
    }
    if (errCode === "access_denied") {
      throw new OAuthError("User denied access", "access_denied", 400, {
        error: errCode,
      });
    }
    throw new OAuthError(
      `Device code poll failed: ${res.status} ${errCode}`.trim(),
      errCode || "device_poll_failed",
      res.status,
      { error: errCode },
    );
  }
  throw new OAuthError("Device code timed out", "device_timeout");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Token persistence
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenStore {
  load(provider: string): Promise<OAuthTokens | undefined>;
  save(provider: string, tokens: OAuthTokens): Promise<void>;
  clear(provider: string): Promise<void>;
  list(): Promise<string[]>;
}

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "pakalon");

export class JsonTokenStore implements TokenStore {
  constructor(private readonly filePath: string = join(DEFAULT_CONFIG_DIR, "oauth.json")) {}

  private async readAll(): Promise<Record<string, OAuthTokens>> {
    if (!existsSync(this.filePath)) return {};
    try {
      const s = await stat(this.filePath);
      if (!s.isFile()) return {};
      const text = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed as Record<string, OAuthTokens>;
      return {};
    } catch {
      return {};
    }
  }

  private async writeAll(data: Record<string, OAuthTokens>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(sanitizeUnicode(data), null, 2), "utf-8");
  }

  async load(provider: string): Promise<OAuthTokens | undefined> {
    const all = await this.readAll();
    return all[provider];
  }

  async save(provider: string, tokens: OAuthTokens): Promise<void> {
    const all = await this.readAll();
    all[provider] = tokens;
    await this.writeAll(all);
  }

  async clear(provider: string): Promise<void> {
    const all = await this.readAll();
    delete all[provider];
    await this.writeAll(all);
  }

  async list(): Promise<string[]> {
    const all = await this.readAll();
    return Object.keys(all);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Base client
// ─────────────────────────────────────────────────────────────────────────────

export interface OAuthClientOptions {
  /** Default token store. */
  store?: TokenStore;
  /** Default timeout for blocking flows. */
  timeoutMs?: number;
}

export abstract class OAuthClient {
  protected readonly store: TokenStore;
  protected readonly timeoutMs: number;
  protected cachedTokens?: OAuthTokens;

  protected abstract readonly providerName: string;
  protected abstract readonly clientId: string;
  protected abstract readonly scopes: string[];

  constructor(opts: OAuthClientOptions = {}) {
    this.store = opts.store ?? new JsonTokenStore();
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** Load tokens from the store into the cache. */
  async loadTokens(): Promise<OAuthTokens | undefined> {
    if (this.cachedTokens) return this.cachedTokens;
    this.cachedTokens = await this.store.load(this.providerName);
    return this.cachedTokens;
  }

  /** Returns tokens, refreshing if they expire within `leewayMs` (default 60s). */
  async getValidTokens(leewayMs = 60_000): Promise<OAuthTokens | undefined> {
    const t = await this.loadTokens();
    if (!t) return undefined;
    if (!t.expires_at) return t;
    if (Date.now() + leewayMs < t.expires_at) return t;
    if (t.refresh_token) {
      const refreshed = await this.refresh(t.refresh_token);
      return refreshed;
    }
    return undefined;
  }

  /** Force a token refresh and persist. */
  async refresh(refreshToken: string): Promise<OAuthTokens> {
    throw new OAuthError(
      `refresh() not implemented for ${this.providerName}`,
      "not_implemented",
    );
  }

  /** Authorize via browser redirect + loopback. Persists tokens. */
  abstract authorize(opts?: {
    openBrowser?: (url: string) => Promise<void>;
    signal?: AbortSignal;
  }): Promise<OAuthTokens>;

  /** Clear tokens. */
  async logout(): Promise<void> {
    this.cachedTokens = undefined;
    await this.store.clear(this.providerName);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser opener (cross-platform)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a URL in the user's default browser. On headless systems (no DISPLAY /
 * no SessionBus), it just prints the URL and returns.
 */
export async function openBrowser(url: string): Promise<boolean> {
  try {
    if (platform === "win32") {
      const { spawn } = await import("node:child_process");
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
    if (platform === "darwin") {
      const { spawn } = await import("node:child_process");
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
    // Linux / BSD
    const { spawn } = await import("node:child_process");
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}
