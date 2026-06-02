/**
 * GitHub Copilot OAuth (device code flow).
 *
 * GitHub's OAuth supports both the auth-code + PKCE flow and the device-code
 * flow. For a CLI, device-code is the more reliable option since the user
 * does not have to be on a machine that can receive a loopback redirect.
 *
 * Endpoints:
 *   - Device:  https://github.com/login/device/code
 *   - Token:   https://github.com/login/oauth/access_token
 *   - Client:  Iv23liKj0Y9eP9a3a8b1c (the Copilot CLI / GitHub Mobile public client)
 *
 * Scopes:
 *   - "read:user" — basic profile
 *   - "user:email" — primary email
 *   - "copilot" — for plain Copilot individual
 *   - "read:org" — for Copilot Business / Enterprise
 *
 * Token exchange requires the `editor-copilot` accept header to be set, plus
 * the `editor-version` and `editor-plugin-version` headers that GitHub's Copilot
 * proxy uses to issue the right kind of short-lived Copilot token.
 */
import { redactSensitive } from "@/utils/safe-string.js";
import {
  OAuthClient,
  OAuthClientOptions,
  OAuthTokens,
  deviceCodeGrant,
  deviceCodePoll,
  refreshToken as refreshOAuthToken,
  OAuthError,
} from "./oauth.js";

/** Public client id used by the official `Copilot for CLI` and `gh-copilot` integrations. */
const COPILOT_DEFAULT_CLIENT_ID = "Iv23liKj0Y9eP9a3a8b1c";
const COPILOT_DEFAULT_CLIENT_SECRET = ""; // public client; secret is empty

const GITHUB_DEVICE_ENDPOINT = "https://github.com/login/device/code";
const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";

const COPILOT_DEFAULT_SCOPES = ["read:user", "user:email", "copilot"];

const COPILOT_EDITOR_VERSION = "pakalon/1.0.0";
const COPILOT_PLUGIN_VERSION = "copilot/1.0.0";

export interface CopilotOAuthOptions extends OAuthClientOptions {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  /** Where to print the user code. Defaults to console.error. */
  onUserCode?: (info: {
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval: number;
  }) => void;
  deviceEndpoint?: string;
  tokenEndpoint?: string;
}

export class CopilotOAuthClient extends OAuthClient {
  protected readonly providerName = "github-copilot";
  protected readonly clientId: string;
  protected readonly clientSecret: string;
  protected readonly scopes: string[];
  private readonly opts: CopilotOAuthOptions;

  constructor(opts: CopilotOAuthOptions = {}) {
    super(opts);
    this.clientId = opts.clientId ?? COPILOT_DEFAULT_CLIENT_ID;
    this.clientSecret = opts.clientSecret ?? COPILOT_DEFAULT_CLIENT_SECRET;
    this.scopes = opts.scopes ?? COPILOT_DEFAULT_SCOPES;
    this.opts = opts;
  }

  /** Start the device-code flow and poll until the user authorizes. */
  async authorize(opts?: {
    signal?: AbortSignal;
    onUserCode?: CopilotOAuthOptions["onUserCode"];
  }): Promise<OAuthTokens> {
    if (opts?.signal?.aborted) throw new OAuthError("Aborted", "aborted");
    const grant = await deviceCodeGrant({
      deviceAuthorizationEndpoint:
        this.opts.deviceEndpoint ?? GITHUB_DEVICE_ENDPOINT,
      clientId: this.clientId,
      clientSecret: this.clientSecret || undefined,
      scope: this.scopes,
      signal: opts?.signal,
    });
    const onCode = opts?.onUserCode ?? this.opts.onUserCode;
    if (onCode) onCode(grant);
    else
      // eslint-disable-next-line no-console
      console.error(
        `\n[github-copilot] To authorize Pakalon, visit:\n  ${
          grant.verification_uri_complete ?? grant.verification_uri
        }\nand enter the code: ${grant.user_code}\n`,
      );
    const tokens = await deviceCodePoll({
      tokenEndpoint: this.opts.tokenEndpoint ?? GITHUB_TOKEN_ENDPOINT,
      clientId: this.clientId,
      clientSecret: this.clientSecret || undefined,
      deviceCode: grant.device_code,
      interval: grant.interval,
      expiresIn: grant.expires_in,
      signal: opts?.signal,
      extra: {
        // GitHub requires JSON accept header
        accept: "json",
      },
    });
    // Decorate with Copilot-specific headers (kept on the raw response)
    const decorated: OAuthTokens = {
      ...tokens,
      raw: {
        ...(tokens.raw ?? {}),
        editor_version: COPILOT_EDITOR_VERSION,
        editor_plugin_version: COPILOT_PLUGIN_VERSION,
        scopes: this.scopes,
      },
    };
    await this.store.save(this.providerName, decorated);
    this.cachedTokens = decorated;
    return decorated;
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    const tokens = await refreshOAuthToken({
      tokenEndpoint: this.opts.tokenEndpoint ?? GITHUB_TOKEN_ENDPOINT,
      refreshToken,
      clientId: this.clientId,
      clientSecret: this.clientSecret || undefined,
      extra: { accept: "json" },
    });
    if (!tokens.refresh_token) tokens.refresh_token = refreshToken;
    await this.store.save(this.providerName, tokens);
    this.cachedTokens = tokens;
    return tokens;
  }

  /**
   * Exchange a GitHub OAuth access token for a short-lived Copilot API token.
   *
   * GitHub's Copilot proxy at https://api.github.com/copilot_internal/v2/token
   * accepts a regular GitHub OAuth token and returns a short-lived token that
   * the Copilot completions/fim endpoints accept.
   */
  async exchangeForCopilotToken(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<{ token: string; expires_at: number; refresh_in?: number }> {
    const res = await fetch(
      "https://api.github.com/copilot_internal/v2/token",
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          "user-agent": "Pakalon/1.0.0",
          "editor-version": COPILOT_EDITOR_VERSION,
          "editor-plugin-version": COPILOT_PLUGIN_VERSION,
        },
        signal,
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new OAuthError(
        `Copilot token exchange failed: ${res.status} ${errText.slice(0, 300)}`,
        "copilot_exchange_failed",
        res.status,
      );
    }
    const json = (await res.json()) as {
      token: string;
      expires_at: number;
      refresh_in?: number;
    };
    if (!json.token) {
      throw new OAuthError(
        "Copilot token exchange returned empty token",
        "copilot_exchange_empty",
      );
    }
    return json;
  }

  /** Headers to attach to a Copilot completions call. */
  async authHeaders(): Promise<Record<string, string>> {
    const tokens = await this.getValidTokens();
    if (!tokens) {
      throw new OAuthError(
        "No valid GitHub OAuth tokens. Run `pakalon login --provider=github-copilot`.",
        "missing_token",
        401,
      );
    }
    const { token: copilotToken, expires_at } = await this.exchangeForCopilotToken(
      tokens.access_token,
    );
    return {
      authorization: `Bearer ${copilotToken}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "Pakalon/1.0.0",
      "editor-version": COPILOT_EDITOR_VERSION,
      "editor-plugin-version": COPILOT_PLUGIN_VERSION,
      "copilot-token-expiry": String(expires_at),
    };
  }
}

export const __INTERNAL__ = {
  COPILOT_DEFAULT_CLIENT_ID,
  COPILOT_DEFAULT_SCOPES,
  GITHUB_DEVICE_ENDPOINT,
  GITHUB_TOKEN_ENDPOINT,
};

export { redactSensitive };
