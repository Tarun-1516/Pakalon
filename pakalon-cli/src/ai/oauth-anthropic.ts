/**
 * Anthropic OAuth (Claude Pro / Max plan) using PKCE.
 *
 * Endpoint configuration follows Anthropic's published OAuth flow:
 *   - Authorize: https://claude.ai/oauth/authorize
 *   - Token:     https://console.anthropic.com/v1/oauth/token
 *   - Refresh:   https://console.anthropic.com/v1/oauth/token
 *   - Client id: 9d1c250a-e61b-44d9-88ed-5944f196b5c1 (Claude Code public client)
 *
 * The CLI captures the redirect on a loopback interface (RFC 8252 §7.3) and
 * exchanges the code with PKCE (RFC 7636) for an access token + refresh token.
 *
 * Token is then sent to the Anthropic Messages API as:
 *   Authorization: Bearer <access_token>
 *   anthropic-version: 2023-06-01
 *   anthropic-beta: oauth-2025-04-20
 *   X-OAuth-Provider: anthropic
 *   X-OAuth-Scopes: ...
 */
import { redactSensitive } from "@/utils/safe-string.js";
import {
  OAuthClient,
  OAuthClientOptions,
  OAuthTokens,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generateCodeVerifier,
  generateState,
  codeChallengeS256,
  openBrowser,
  pickFreePort,
  waitForLoopbackRedirect,
  refreshToken as refreshOAuthToken,
  OAuthError,
} from "./oauth.js";

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944f196b5c1";
const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
/** Default scope set: include "user:profile user:inference". */
const ANTHROPIC_DEFAULT_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:file_upload",
  "user:mcp_servers",
];

export interface AnthropicOAuthOptions extends OAuthClientOptions {
  clientId?: string;
  scopes?: string[];
  /** Hostname to bind for the loopback redirect (default 127.0.0.1). */
  loopbackHost?: string;
  /** Port to bind for the loopback redirect (default 0 = ephemeral). */
  loopbackPort?: number;
  /** Optional override for the authorize URL (for staging). */
  authorizeUrl?: string;
  /** Optional override for the token URL (for staging). */
  tokenUrl?: string;
}

export class AnthropicOAuthClient extends OAuthClient {
  protected readonly providerName = "anthropic";
  protected readonly clientId: string;
  protected readonly scopes: string[];
  private readonly opts: AnthropicOAuthOptions;

  constructor(opts: AnthropicOAuthOptions = {}) {
    super(opts);
    this.clientId = opts.clientId ?? ANTHROPIC_CLIENT_ID;
    this.scopes = opts.scopes ?? ANTHROPIC_DEFAULT_SCOPES;
    this.opts = opts;
  }

  /** Build the authorize URL (useful for tools / debugging). */
  buildAuthorizeUrl(opts?: {
    state?: string;
    codeChallenge?: string;
    redirectUri?: string;
  }): string {
    const state = opts?.state ?? generateState();
    const codeChallenge =
      opts?.codeChallenge ?? codeChallengeS256(generateCodeVerifier());
    const redirectUri =
      opts?.redirectUri ??
      `http://${this.opts.loopbackHost ?? "127.0.0.1"}:${
        this.opts.loopbackPort ?? "PORT"
      }/callback`;
    return buildAuthorizeUrl({
      authorizationEndpoint: this.opts.authorizeUrl ?? ANTHROPIC_AUTHORIZE_URL,
      clientId: this.clientId,
      redirectUri,
      scope: this.scopes,
      state,
      codeChallenge,
      extra: {
        response_type: "code",
        // Required by Claude: tells the server to issue a refresh token.
        code: "true",
        // Show the consent screen.
        prompt: "consent",
      },
    });
  }

  async authorize(opts?: {
    openBrowser?: (url: string) => Promise<void>;
    signal?: AbortSignal;
  }): Promise<OAuthTokens> {
    const verifier = generateCodeVerifier();
    const challenge = codeChallengeS256(verifier);
    const state = generateState();
    const hostname = this.opts.loopbackHost ?? "127.0.0.1";
    const port =
      this.opts.loopbackPort ?? (await pickFreePort(hostname));
    const redirectUri = `http://${hostname}:${port}/callback`;
    const url = this.buildAuthorizeUrl({
      state,
      codeChallenge: challenge,
      redirectUri,
    });
    const open = opts?.openBrowser ?? openBrowser;
    if (opts?.signal?.aborted) throw new OAuthError("Aborted", "aborted");
    const opened = await open(url).catch(() => false);
    if (!opened) {
      // Fallback: print to stderr so the user can copy-paste.
      // eslint-disable-next-line no-console
      console.error(
        `\n[anthropic-oauth] Open the following URL in a browser to continue:\n\n  ${url}\n`,
      );
    }
    const result = await waitForLoopbackRedirect(state, {
      hostname,
      port,
      path: "/callback",
      timeoutMs: this.timeoutMs,
      signal: opts?.signal,
    });
    const tokens = await exchangeCodeForToken({
      tokenEndpoint: this.opts.tokenUrl ?? ANTHROPIC_TOKEN_URL,
      code: result.code,
      redirectUri,
      clientId: this.clientId,
      codeVerifier: verifier,
      // Anthropic does not require a client_secret for public clients.
      extraHeaders: {
        accept: "application/json",
      },
    });
    await this.store.save(this.providerName, tokens);
    this.cachedTokens = tokens;
    return tokens;
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    const tokens = await refreshOAuthToken({
      tokenEndpoint: this.opts.tokenUrl ?? ANTHROPIC_TOKEN_URL,
      refreshToken,
      clientId: this.clientId,
      extra: {
        // Anthropic does not require client_secret for public clients.
      },
    });
    // Some providers return a new refresh_token, others don't. Preserve the
    // old one if the new response omits it.
    if (!tokens.refresh_token) {
      tokens.refresh_token = refreshToken;
    }
    await this.store.save(this.providerName, tokens);
    this.cachedTokens = tokens;
    return tokens;
  }

  /**
   * Build the headers to send to the Anthropic Messages API.
   * The SDK / fetch consumer is responsible for NOT also setting
   * `x-api-key` when these are used.
   */
  async authHeaders(): Promise<Record<string, string>> {
    const tokens = await this.getValidTokens();
    if (!tokens) {
      throw new OAuthError(
        "No valid Anthropic OAuth tokens. Run `pakalon login --provider=anthropic`.",
        "missing_token",
        401,
      );
    }
    return {
      authorization: `Bearer ${tokens.access_token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "x-oauth-provider": "anthropic",
      "x-oauth-scopes": this.scopes.join(" "),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers exposed for testing
// ─────────────────────────────────────────────────────────────────────────────

export const __INTERNAL__ = {
  ANTHROPIC_CLIENT_ID,
  ANTHROPIC_AUTHORIZE_URL,
  ANTHROPIC_TOKEN_URL,
  ANTHROPIC_DEFAULT_SCOPES,
};

export { redactSensitive };
