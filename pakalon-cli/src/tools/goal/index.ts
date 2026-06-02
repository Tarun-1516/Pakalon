/**
 * Goal CLI: hierarchical goal management.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const goalCreate = tool({
  description: "Create a goal (optionally with parent / session).",
  args: {
    title: tool.schema.string(),
    description: tool.schema.string().default(""),
    parent_id: tool.schema.string().default(""),
    session_id: tool.schema.string().default(""),
    priority: tool.schema.number().default(0),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/goals", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const goalUpdate = tool({
  description: "Update a goal's status / progress / priority / blockers.",
  args: {
    goal_id: tool.schema.string(),
    status: tool.schema.enum(["pending", "active", "blocked", "done", "cancelled"]).optional(),
    progress: tool.schema.number().min(0).max(1).optional(),
    priority: tool.schema.number().optional(),
    add_blocker: tool.schema.string().optional(),
    remove_blocker: tool.schema.string().optional(),
  },
  async execute({ goal_id, ...body }) {
    return JSON.stringify(
      await backendFetch(`/goals/${goal_id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    );
  },
});

export const goalList = tool({
  description: "List goals, optionally filtered by session/status.",
  args: {
    session_id: tool.schema.string().optional(),
    status: tool.schema
      .enum(["pending", "active", "blocked", "done", "cancelled"])
      .optional(),
  },
  async execute(args) {
    const q = new URLSearchParams();
    if (args.session_id) q.set("session_id", args.session_id);
    if (args.status) q.set("status", args.status);
    return JSON.stringify(await backendFetch(`/goals?${q}`));
  },
});

export const goalReady = tool({
  description: "List goals that are ready (all blockers done).",
  args: { session_id: tool.schema.string().optional() },
  async execute({ session_id }) {
    const q = session_id ? `?session_id=${session_id}` : "";
    return JSON.stringify(await backendFetch(`/goals/ready/list${q}`));
  },
});
