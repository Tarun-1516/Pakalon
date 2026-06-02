/**
 * MCP OAuth CLI: MCP-protected-resource + dynamic-client-registration.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const mcpDiscover = tool({
  description: "Discover an OAuth authorization server.",
  args: {
    authorization_server: tool.schema.string(),
    resource: tool.schema.string(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/mcp-oauth/discover", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const mcpRegister = tool({
  description: "Register a dynamic client.",
  args: {
    authorization_server: tool.schema.string(),
    resource: tool.schema.string(),
    redirect_uris: tool.schema.array(tool.schema.string()),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/mcp-oauth/register", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const mcpAuthorize = tool({
  description: "Build an authorize URL for an MCP server.",
  args: {
    authorization_server: tool.schema.string(),
    resource: tool.schema.string(),
    client_id: tool.schema.string(),
    redirect_uri: tool.schema.string(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/mcp-oauth/authorize", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const mcpExchange = tool({
  description: "Exchange an MCP OAuth code.",
  args: {
    authorization_server: tool.schema.string(),
    resource: tool.schema.string(),
    client_id: tool.schema.string(),
    code: tool.schema.string(),
    code_verifier: tool.schema.string(),
    redirect_uri: tool.schema.string(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/mcp-oauth/exchange", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});
