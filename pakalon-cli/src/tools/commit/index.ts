/**
 * Commit CLI: structured commit messages.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const commitCreate = tool({
  description: "Create a structured commit record.",
  args: {
    subject: tool.schema.string(),
    type: tool.schema
      .enum(["feat", "fix", "refactor", "docs", "test", "chore", "perf", "style", "build", "ci"])
      .default("feat"),
    scope: tool.schema.string().default(""),
    body: tool.schema.string().default(""),
    files: tool.schema.array(tool.schema.string()).optional(),
    breaking: tool.schema.boolean().default(false),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/commits", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const commitList = tool({
  description: "List commits.",
  args: {
    session_id: tool.schema.string().optional(),
    branch: tool.schema.string().optional(),
    limit: tool.schema.number().default(50),
  },
  async execute(args) {
    const q = new URLSearchParams();
    if (args.session_id) q.set("session_id", args.session_id);
    if (args.branch) q.set("branch", args.branch);
    q.set("limit", String(args.limit));
    return JSON.stringify(await backendFetch(`/commits?${q}`));
  },
});
