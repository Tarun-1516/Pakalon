/**
 * Internal URLs CLI: build/resolve local:// and secure:// URLs.
 *
 * For the multi-scheme resolver (pr://, issue://, agent://, skill://,
 * rule://, conflict://, git-overview://, fs://, session://, tool://) see
 * `./resolver.js`. Re-exported here for convenience.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

// Re-export the multi-scheme resolver API at the package root.
export {
  resolve,
  resolveAll,
  detectScheme,
  clearCache,
  SCHEMES,
} from "./resolver.js";
export type {
  Scheme,
  ResolverContext,
  ResolveResult,
  ResolveError,
  Resolver,
} from "./resolver.js";

export const buildUrl = tool({
  description: "Build an internal URL (local or secure scheme).",
  args: {
    workspace: tool.schema.string(),
    path: tool.schema.string(),
    scheme: tool.schema.enum(["local", "secure"]).default("local"),
    ttl_seconds: tool.schema.number().default(3600),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/internal-urls/build", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const resolveUrl = tool({
  description: "Resolve an internal URL (verifies signature, returns metadata).",
  args: { url: tool.schema.string() },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/internal-urls/resolve", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});
