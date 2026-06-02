/**
 * Mnemopi CLI: long-term semantic memory operations.
 *
 * Wraps the backend mnemopi endpoints so the agent can
 * remember / recall facts across sessions.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const mnemopiRemember = tool({
  description: "Remember a fact in long-term memory (mnemopi).",
  args: {
    content: tool.schema.string().describe("Fact to remember"),
    tags: tool.schema.array(tool.schema.string()).optional(),
    scope: tool.schema.enum(["global", "project", "session"]).default("global"),
    scope_id: tool.schema.string().default(""),
  },
  async execute({ content, tags, scope, scope_id }) {
    const res = await backendFetch("/mnemopi/remember", {
      method: "POST",
      body: JSON.stringify({ content, tags, scope, scope_id }),
    });
    return JSON.stringify(res);
  },
});

export const mnemopiRecall = tool({
  description: "Recall relevant memories by semantic query.",
  args: {
    query: tool.schema.string(),
    k: tool.schema.number().default(5),
  },
  async execute({ query, k }) {
    const res = await backendFetch("/mnemopi/recall", {
      method: "POST",
      body: JSON.stringify({ query, k }),
    });
    return JSON.stringify(res);
  },
});

export const mnemopiList = tool({
  description: "List recent memories.",
  args: {
    scope: tool.schema.enum(["global", "project", "session"]).optional(),
    limit: tool.schema.number().default(50),
  },
  async execute({ scope, limit }) {
    const q = new URLSearchParams();
    if (scope) q.set("scope", scope);
    q.set("limit", String(limit));
    return JSON.stringify(await backendFetch(`/mnemopi/list?${q}`));
  },
});
