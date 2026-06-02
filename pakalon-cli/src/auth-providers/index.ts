/**
 * Auth providers CLI: OAuth flows with PKCE, device-code.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const listAuthProviders = tool({
  description: "List OAuth providers (anthropic/github/google/etc.).",
  args: {},
  async execute() {
    return JSON.stringify(await backendFetch("/auth/providers"));
  },
});

export const authAuthorize = tool({
  description: "Build an authorize URL (with PKCE if supported).",
  args: {
    provider: tool.schema.string(),
    redirect_uri: tool.schema.string(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/auth/authorize", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const authExchange = tool({
  description: "Exchange an OAuth code for tokens.",
  args: {
    provider: tool.schema.string(),
    code: tool.schema.string(),
    redirect_uri: tool.schema.string(),
    code_verifier: tool.schema.string().optional(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/auth/exchange", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const authRefresh = tool({
  description: "Refresh an OAuth token.",
  args: {
    provider: tool.schema.string(),
    refresh_token: tool.schema.string(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/auth/refresh", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const deviceCodeStart = tool({
  description: "Start a device-code flow (with PKCE if supported).",
  args: {
    provider: tool.schema.string(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/auth/device/start", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});
