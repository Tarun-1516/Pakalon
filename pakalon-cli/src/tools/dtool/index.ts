/**
 * DAP CLI: Debug Adapter Protocol client.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const dapStart = tool({
  description: "Start a DAP debug adapter (python/node/go).",
  args: {
    language: tool.schema.enum(["python", "node", "go"]).or(tool.schema.string()),
    custom_cmd: tool.schema.string().optional(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/dap/start", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const dapRequest = tool({
  description: "Send a DAP request to a running adapter.",
  args: {
    key: tool.schema.string(),
    command: tool.schema.string(),
    arguments: tool.schema.record(tool.schema.string(), tool.schema.any()).optional(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch(`/dap/${args.key}/request`, {
        method: "POST",
        body: JSON.stringify({ command: args.command, arguments: args.arguments || {} }),
      }),
    );
  },
});

export const dapStop = tool({
  description: "Stop a DAP client.",
  args: { key: tool.schema.string() },
  async execute({ key }) {
    return JSON.stringify(await backendFetch(`/dap/${key}/stop`, { method: "POST" }));
  },
});
