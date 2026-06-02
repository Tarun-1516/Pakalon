/**
 * Hindsight CLI: multi-bank memory with transcript awareness.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const hindsightRemember = tool({
  description: "Remember content in a hindsight bank (global/project/branch/session).",
  args: {
    content: tool.schema.string(),
    bank: tool.schema.enum(["global", "project", "branch", "session"]).default("global"),
    scope_id: tool.schema.string().default(""),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/hindsight/remember", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const hindsightRecall = tool({
  description: "Recall from a hindsight bank.",
  args: {
    query: tool.schema.string(),
    bank: tool.schema.enum(["global", "project", "branch", "session"]).optional(),
    k: tool.schema.number().default(5),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/hindsight/recall", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const hindsightLog = tool({
  description: "Log a transcript event for a session.",
  args: {
    session_id: tool.schema.string(),
    kind: tool.schema.string(),
    payload: tool.schema.string(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/hindsight/transcript", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const hindsightGetState = tool({
  description: "Get the focus / summary / todos / open-threads for a session.",
  args: { session_id: tool.schema.string() },
  async execute({ session_id }) {
    return JSON.stringify(await backendFetch(`/hindsight/state/${session_id}`));
  },
});
