/**
 * PTY CLI: pseudo-terminal session control.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const ptyStart = tool({
  description: "Start a PTY session.",
  args: {
    command: tool.schema.string(),
    cwd: tool.schema.string().default(""),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/pty/start", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const ptyWrite = tool({
  description: "Write to a PTY session.",
  args: {
    session_id: tool.schema.string(),
    data: tool.schema.string(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch(`/pty/${args.session_id}/write`, {
        method: "POST",
        body: JSON.stringify({ data: args.data }),
      }),
    );
  },
});

export const ptyRead = tool({
  description: "Read from a PTY session.",
  args: {
    session_id: tool.schema.string(),
    timeout: tool.schema.number().default(1),
    max_bytes: tool.schema.number().default(4096),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch(`/pty/${args.session_id}/read`, {
        method: "POST",
        body: JSON.stringify({ timeout: args.timeout, max_bytes: args.max_bytes }),
      }),
    );
  },
});

export const ptyKill = tool({
  description: "Kill a PTY session.",
  args: { session_id: tool.schema.string() },
  async execute({ session_id }) {
    return JSON.stringify(
      await backendFetch(`/pty/${session_id}/kill`, { method: "POST" }),
    );
  },
});

export const ptyList = tool({
  description: "List active PTY sessions.",
  args: {},
  async execute() {
    return JSON.stringify(await backendFetch("/pty/list"));
  },
});
