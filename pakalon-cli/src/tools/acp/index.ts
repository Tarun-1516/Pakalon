/**
 * ACP CLI: Agent Communication Protocol JSON-RPC 2.0 client.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const acpCreateSession = tool({
  description: "Create an ACP session.",
  args: { metadata: tool.schema.record(tool.schema.string(), tool.schema.any()).optional() },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/acp/session", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const acpRpc = tool({
  description: "Send a JSON-RPC 2.0 request to an ACP session.",
  args: {
    session_id: tool.schema.string(),
    method: tool.schema.string(),
    params: tool.schema.record(tool.schema.string(), tool.schema.any()).optional(),
  },
  async execute({ session_id, method, params }) {
    return JSON.stringify(
      await backendFetch(`/acp/rpc?session=${session_id}`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || {} }),
      }),
    );
  },
});

export const acpCancel = tool({
  description: "Cancel an ACP session.",
  args: { session_id: tool.schema.string() },
  async execute({ session_id }) {
    return JSON.stringify(
      await backendFetch("/acp/cancel", {
        method: "POST",
        body: JSON.stringify({ session_id }),
      }),
    );
  },
});
