/**
 * v2 session CLI: durable, multi-branch, event-sourced sessions.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const v2SessionCreate = tool({
  description: "Create a v2 session.",
  args: {
    title: tool.schema.string().default(""),
    project_id: tool.schema.string().default(""),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/v2/sessions", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const v2SessionAddTurn = tool({
  description: "Append a turn to a v2 session.",
  args: {
    session_id: tool.schema.string(),
    role: tool.schema.enum(["user", "assistant", "system", "tool"]),
    content: tool.schema.string(),
    model: tool.schema.string().default(""),
    parent_turn_id: tool.schema.string().default(""),
  },
  async execute({ session_id, ...body }) {
    return JSON.stringify(
      await backendFetch(`/v2/sessions/${session_id}/turns`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  },
});

export const v2SessionFork = tool({
  description: "Fork a v2 session at a turn.",
  args: {
    session_id: tool.schema.string(),
    fork_turn_id: tool.schema.string(),
    name: tool.schema.string().default(""),
  },
  async execute({ session_id, ...body }) {
    return JSON.stringify(
      await backendFetch(`/v2/sessions/${session_id}/fork`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  },
});

export const v2SessionLogEvent = tool({
  description: "Log an event into a v2 session.",
  args: {
    session_id: tool.schema.string(),
    kind: tool.schema.string(),
    payload: tool.schema.record(tool.schema.string(), tool.schema.any()).optional(),
  },
  async execute({ session_id, ...body }) {
    return JSON.stringify(
      await backendFetch(`/v2/sessions/${session_id}/events`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  },
});
