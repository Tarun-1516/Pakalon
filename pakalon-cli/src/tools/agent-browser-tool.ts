/**
 * Agent Browser tool — exposes vercel-labs/agent-browser to the AI agent loop.
 *
 * The underlying CLI binary is spawned lazily on first use.  If the binary is
 * not installed, every invocation returns a clear error message.
 */

import { tool } from "ai";
import { z } from "zod";
import logger from "@/utils/logger.js";
import type {
  AgentBrowserClient,
  AgentBrowserOptions,
} from "@/integrations/agent-browser/types.js";

// ---------------------------------------------------------------------------
// Lazy singleton client
// ---------------------------------------------------------------------------

let clientInstance: AgentBrowserClient | null = null;
let clientInitFailed = false;

async function getClient(): Promise<AgentBrowserClient> {
  if (clientInstance) return clientInstance;
  if (clientInitFailed) {
    throw new Error(
      'agent-browser is not installed. Run "npm install -g agent-browser && agent-browser install" to enable it.',
    );
  }

  try {
    // Dynamic import so the module is only loaded when the tool is first used.
    const { createAgentBrowser } = await import(
      "@/integrations/agent-browser/adapter.js"
    );
    clientInstance = createAgentBrowser();
    return clientInstance;
  } catch (err) {
    clientInitFailed = true;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Schema — single discriminated-union action field
// ---------------------------------------------------------------------------

const actActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), selector: z.string() }),
  z.object({ type: z.literal("dblclick"), selector: z.string() }),
  z.object({ type: z.literal("fill"), selector: z.string(), value: z.string() }),
  z.object({ type: z.literal("type"), selector: z.string(), value: z.string() }),
  z.object({ type: z.literal("press"), key: z.string() }),
  z.object({ type: z.literal("select"), selector: z.string(), value: z.string() }),
  z.object({ type: z.literal("check"), selector: z.string() }),
  z.object({ type: z.literal("uncheck"), selector: z.string() }),
  z.object({ type: z.literal("hover"), selector: z.string() }),
  z.object({
    type: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    pixels: z.number().int().positive().optional(),
  }),
]);

const agentBrowserInputSchema = z.object({
  action: z.enum([
    "navigate",
    "act",
    "extract",
    "screenshot",
    "snapshot",
    "evaluate",
    "close",
  ]),
  url: z.string().url().optional().describe("URL for navigate action"),
  navigateOpts: z
    .object({
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
    })
    .optional()
    .describe("Options for navigate action"),
  actAction: actActionSchema.optional().describe("Action descriptor for act"),
  extract: z
    .object({
      selector: z.string(),
      kind: z.enum(["text", "html", "value", "attr", "count", "box"]).optional(),
      attr: z.string().optional(),
    })
    .optional()
    .describe("Extraction descriptor"),
  screenshot: z
    .object({
      path: z.string().optional(),
      fullPage: z.boolean().optional(),
      annotate: z.boolean().optional(),
      format: z.enum(["png", "jpeg"]).optional(),
      quality: z.number().int().min(0).max(100).optional(),
    })
    .optional()
    .describe("Screenshot options"),
  snapshot: z
    .object({
      interactive: z.boolean().optional(),
      urls: z.boolean().optional(),
      compact: z.boolean().optional(),
      depth: z.number().int().positive().optional(),
      selector: z.string().optional(),
    })
    .optional()
    .describe("Snapshot options"),
  evaluate: z.string().optional().describe("JavaScript to evaluate"),
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const agentBrowserTool = tool({
  description:
    "Control a headless browser via agent-browser (vercel-labs/agent-browser). " +
    "Actions: navigate (open URL), act (click/fill/type/press/select/hover/scroll), " +
    "extract (get text/html/value/attr/count/box), screenshot, snapshot (accessibility tree), " +
    "evaluate (run JS), close.",
  inputSchema: agentBrowserInputSchema,
  execute: async (input) => {
    const client = await getClient();

    try {
      switch (input.action) {
        case "navigate": {
          if (!input.url) return { error: "url is required for navigate" };
          const result = await client.navigate({
            url: input.url,
            waitUntil: input.navigateOpts?.waitUntil,
          });
          return { success: true, ...result };
        }

        case "act": {
          if (!input.actAction) return { error: "actAction is required for act" };
          const result = await client.act(input.actAction);
          return { success: true, ...result };
        }

        case "extract": {
          if (!input.extract) return { error: "extract descriptor is required" };
          const result = await client.extract(input.extract);
          return { success: true, ...result };
        }

        case "screenshot": {
          const result = await client.screenshot(input.screenshot);
          return { success: true, ...result };
        }

        case "snapshot": {
          const result = await client.snapshot(input.snapshot);
          return { success: true, ...result };
        }

        case "evaluate": {
          if (!input.evaluate) return { error: "evaluate script is required" };
          const result = await client.evaluate(input.evaluate);
          return { success: true, value: result };
        }

        case "close": {
          await client.close();
          clientInstance = null;
          clientInitFailed = false;
          return { success: true, message: "Browser session closed" };
        }

        default:
          return { error: `Unknown action: ${String(input)}` };
      }
    } catch (err) {
      logger.error("[agent-browser-tool] %s", err);
      return { error: String(err) };
    }
  },
});
