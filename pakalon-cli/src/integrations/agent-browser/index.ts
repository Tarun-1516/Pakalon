/**
 * vercel-labs/agent-browser integration for pakalon-cli.
 *
 * Usage:
 *   import { createAgentBrowser } from "@/integrations/agent-browser/index.js";
 *
 *   const client = createAgentBrowser({ session: "my-session" });
 *   await client.navigate({ url: "https://example.com" });
 *   const snap = await client.snapshot({ interactive: true });
 *   await client.act({ type: "click", selector: "@e1" });
 *   await client.screenshot({ path: "page.png" });
 *   await client.close();
 */

export { createAgentBrowser } from "./adapter.js";
export type {
  AgentBrowserClient,
  AgentBrowserOptions,
  ActAction,
  ActResult,
  ExtractOptions,
  ExtractResult,
  NavigateOptions,
  NavigateResult,
  ScreenshotOptions,
  ScreenshotResult,
  SnapshotOptions,
  SnapshotResult,
} from "./types.js";
