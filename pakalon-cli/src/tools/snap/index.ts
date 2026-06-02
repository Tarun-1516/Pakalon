/**
 * Snapshot / Patch / Share CLI.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const snapshotCapture = tool({
  description: "Capture a snapshot of file paths.",
  args: {
    paths: tool.schema.array(tool.schema.string()),
    label: tool.schema.string().default(""),
    session_id: tool.schema.string().default(""),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/snapshots/capture", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const snapshotRestore = tool({
  description: "Restore a snapshot.",
  args: { snapshot_id: tool.schema.string(), target_dir: tool.schema.string().default(".") },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/snapshots/restore", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const patchCreateText = tool({
  description: "Create a unified-diff patch from before/after text.",
  args: {
    file: tool.schema.string(),
    before: tool.schema.string(),
    after: tool.schema.string(),
    summary: tool.schema.string().default(""),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/patches/text", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const patchCreateJson = tool({
  description: "Create a JSON-Patch (RFC 6902) from before/after JSON.",
  args: {
    file: tool.schema.string(),
    before: tool.schema.record(tool.schema.string(), tool.schema.any()).default({}),
    after: tool.schema.record(tool.schema.string(), tool.schema.any()).default({}),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/patches/json", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const shareCreate = tool({
  description: "Create a shareable link to a session/branch/snapshot/patch.",
  args: {
    scope: tool.schema.enum(["session", "branch", "snapshot", "patch"]),
    target_id: tool.schema.string(),
    password: tool.schema.string().default(""),
    ttl_seconds: tool.schema.number().default(0),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/shares", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});
