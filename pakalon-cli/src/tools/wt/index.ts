/**
 * Worktree control plane CLI.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const wtInit = tool({
  description: "Initialize a new worktree for a task.",
  args: {
    repo: tool.schema.string(),
    task_id: tool.schema.string(),
    base: tool.schema.string().default("main"),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/worktree/init", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const wtDiff = tool({
  description: "Get the diff of a worktree vs its base.",
  args: { wid: tool.schema.string() },
  async execute({ wid }) {
    return JSON.stringify(await backendFetch(`/worktree/${wid}/diff`));
  },
});

export const wtMerge = tool({
  description: "Merge a worktree back to its base.",
  args: { wid: tool.schema.string() },
  async execute({ wid }) {
    return JSON.stringify(
      await backendFetch(`/worktree/${wid}/merge`, { method: "POST" }),
    );
  },
});

export const wtCleanup = tool({
  description: "Remove a worktree.",
  args: { wid: tool.schema.string(), force: tool.schema.boolean().default(false) },
  async execute({ wid, force }) {
    return JSON.stringify(
      await backendFetch(`/worktree/${wid}/cleanup?force=${force}`, { method: "POST" }),
    );
  },
});

export const wtList = tool({
  description: "List all worktrees in this session.",
  args: {},
  async execute() {
    return JSON.stringify(await backendFetch("/worktree/list"));
  },
});
