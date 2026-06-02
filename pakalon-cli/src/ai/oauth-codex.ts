/**
 * OpenAI / ChatGPT Codex OAuth (PKCE + browser + loopback).
 *
 * Endpoint configuration follows OpenAI's Codex / ChatGPT Plus / Pro plan
 * OAuth flow, mirroring what the `codex` CLI does:
 *
 *   - Authorize:  https://auth.openai.com/oauth/authorize
 *   - Token:      https://auth.openai.com/oauth/token
 *   - Refresh:    https://auth.openai.com/oauth/token
 *   - Client id:  app_EMoamEEZ73f0CkXaXp7hrann (public ChatGPT Codex client)
 *
 * Headers when calling the OpenAI Responses / Completions API with an OAuth
 * token:
 *   Authorization: Bearer <access_token>
 *   chatgpt-account-id: <account_id>     (extracted from id_token or profile)
 *   openai-organization: <org>           (optional)
 *   openai-project: <project>            (optional)
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

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
];

export interface CodexOAuthOptions extends OAuthClientOptions {
  clientId?: string;
  scopes?: string[];
  /** Loopback host (default 127.0.0.1). */
  loopbackHost?: string;
  /** Loopback port (default 0 = ephemeral). */
  loopbackPort?: number;
  /** Optional: launch the auth in headless / device-code mode if available. */
  useDeviceCode?: boolean;
  authorizeUrl?: string;
  tokenUrl?: string;
}

export class CodexOAuthClient extends OAuthClient {
  protected readonly providerName = "openai-codex";
  protected readonly clientId: string;
  protected readonly scopes: string[];
  private readonly opts: CodexOAuthOptions;

  constructor(opts: CodexOAuthOptions = {}) {
    super(opts);
    this.clientId = opts.clientId ?? CODEX_CLIENT_ID;
    this.scopes = opts.scopes ?? CODEX_DEFAULT_SCOPES;
    this.opts = opts;
  }

  buildAuthorizeUrl(opts?: {
    state?: string;
    codeChallenge?: string;
    redirectUri?: string;
    /** Optional: pass a `creator` so the consent screen says "Pakalon". */
    creator?: string;
  }): string {
    const state = opts?.state ?? generateState();
    const codeChallenge =
      opts?.codeChallenge ?? codeChallengeS256(generateCodeVerifier());
    const redirectUri =
      opts?.redirectUri ??
      `http://${this.opts.loopbackHost ?? "127.0.0.1"}:${
        this.opts.loopbackPort ?? "PORT"
      }/auth/callback`;
    return buildAuthorizeUrl({
      authorizationEndpoint: this.opts.authorizeUrl ?? CODEX_AUTHORIZE_URL,
      clientId: this.clientId,
      redirectUri,
      scope: this.scopes,
      state,
      codeChallenge,
      extra: {
        response_type: "code",
        prompt: "login",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: opts?.creator ?? "pakalon",
      },
    });
  }

  async authorize(opts?: {
    openBrowser?: (url: string) => Promise<void>;
    signal?: AbortSignal;
  }): Promise<OAuthTokens> {
    if (opts?.signal?.aborted) throw new OAuthError("Aborted", "aborted");
    const verifier = generateCodeVerifier();
    const challenge = codeChallengeS256(verifier);
    const state = generateState();
    const hostname = this.opts.loopbackHost ?? "127.0.0.1";
    const port =
      this.opts.loopbackPort ?? (await pickFreePort(hostname));
    const redirectUri = `http://${hostname}:${port}/auth/callback`;
    const url = this.buildAuthorizeUrl({
      state,
      codeChallenge: challenge,
      redirectUri,
    });
    const open = opts?.openBrowser ?? openBrowser;
    const opened = await open(url).catch(() => false);
    if (!opened) {
      // eslint-disable-next-line no-console
      console.error(
        `\n[openai-codex-oauth] Open the following URL in a browser to continue:\n\n  ${url}\n`,
      );
    }
    const result = await waitForLoopbackRedirect(state, {
      hostname,
      port,
      path: "/auth/callback",
      timeoutMs: this.timeoutMs,
      signal: opts?.signal,
    });
    const tokens = await exchangeCodeForToken({
      tokenEndpoint: this.opts.tokenUrl ?? CODEX_TOKEN_URL,
      code: result.code,
      redirectUri,
      clientId: this.clientId,
      codeVerifier: verifier,
      extraHeaders: {
        accept: "application/json",
      },
    });
    // Decode id_token to extract chatgpt_account_id
    const accountId = decodeJwtField(tokens.id_token, "chatgpt_account_id");
    const orgId = decodeJwtField(tokens.id_token, "organization_id");
    const decorated: OAuthTokens = {
      ...tokens,
      raw: {
        ...(tokens.raw ?? {}),
        chatgpt_account_id: accountId,
        organization_id: orgId,
        editor: "pakalon",
      },
    };
    await this.store.save(this.providerName, decorated);
    this.cachedTokens = decorated;
    return decorated;
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    const tokens = await refreshOAuthToken({
      tokenEndpoint: this.opts.tokenUrl ?? CODEX_TOKEN_URL,
      refreshToken,
      clientId: this.clientId,
      extraHeaders: { accept: "application/json" },
    });
    if (!tokens.refresh_token) tokens.refresh_token = refreshToken;
    await this.store.save(this.providerName, tokens);
    this.cachedTokens = tokens;
    return tokens;
  }

  async authHeaders(): Promise<Record<string, string>> {
    const tokens = await this.getValidTokens();
    if (!tokens) {
      throw new OAuthError(
        "No valid OpenAI Codex OAuth tokens. Run `pakalon login --provider=codex`.",
        "missing_token",
        401,
      );
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${tokens.access_token}`,
      accept: "application/json",
      "content-type": "application/json",
      originator: "pakalon",
    };
    const accountId =
      (tokens.raw as Record<string, unknown> | undefined)?.chatgpt_account_id ??
      decodeJwtField(tokens.id_token, "chatgpt_account_id");
    if (accountId) headers["chatgpt-account-id"] = String(accountId);
    const orgId =
      (tokens.raw as Record<string, unknown> | undefined)?.organization_id ??
      decodeJwtField(tokens.id_token, "organization_id");
    if (orgId) headers["openai-organization"] = String(orgId);
    return headers;
  }
}

/**
 * Lightweight JWT field decoder (no signature verification). Used to extract
 * the `chatgpt_account_id` and `organization_id` claims from the `id_token`
 * returned by the OpenAI / ChatGPT OAuth flow. We do NOT use this for
 * authorization decisions — the auth header is the source of truth.
 */
export function decodeJwtField(
  jwt: string | undefined,
  field: string,
): string | undefined {
  if (!jwt) return undefined;
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  try {
    const padded = payload + "===".slice(0, (4 - (payload.length % 4)) % 4);
    const json = JSON.parse(
      Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf-8",
      ),
    );
    const v = json?.[field];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export const __INTERNAL__ = {
  CODEX_CLIENT_ID,
  CODEX_AUTHORIZE_URL,
  CODEX_TOKEN_URL,
  CODEX_DEFAULT_SCOPES,
};

export { redactSensitive };
