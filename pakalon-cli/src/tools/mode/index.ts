/**
 * Project + Tiny + Eval + Scraper + Btw + Mode CLI wrappers.
 */
import { tool } from "@opencode-ai/plugin";
import { backendFetch } from "../util/backend";

export const projectCreate = tool({
  description: "Create a project (multi-project workspace).",
  args: {
    name: tool.schema.string(),
    root: tool.schema.string().default(""),
    description: tool.schema.string().default(""),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/projects", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const projectList = tool({
  description: "List all projects.",
  args: {},
  async execute() {
    return JSON.stringify(await backendFetch("/projects"));
  },
});

export const tinyCreate = tool({
  description: "Create a tiny item (note / link / snippet / bookmark / reminder / quote / todo / contact).",
  args: {
    kind: tool.schema.enum([
      "note", "link", "snippet", "bookmark", "reminder", "quote", "todo", "contact",
    ]),
    title: tool.schema.string(),
    body: tool.schema.string().default(""),
    url: tool.schema.string().default(""),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/tiny", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const tinyList = tool({
  description: "List tiny items.",
  args: {
    kind: tool.schema.string().optional(),
    limit: tool.schema.number().default(50),
  },
  async execute(args) {
    const q = new URLSearchParams();
    if (args.kind) q.set("kind", args.kind);
    q.set("limit", String(args.limit));
    return JSON.stringify(await backendFetch(`/tiny?${q}`));
  },
});

export const evalRun = tool({
  description: "Run a code snippet in a sandboxed subprocess.",
  args: {
    code: tool.schema.string(),
    language: tool.schema.enum(["python", "javascript", "typescript", "shell"]).default("python"),
    timeout: tool.schema.number().default(10),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/eval/run", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const scrapeUrl = tool({
  description: "Scrape a URL (auto-detects domain adapter, fallback builtin extractor).",
  args: {
    url: tool.schema.string(),
    provider: tool.schema.enum(["builtin", "firecrawl", "scrapingbee"]).default("builtin"),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/scrapers/scrape", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const scrapeDomains = tool({
  description: "List supported scraper domain adapters.",
  args: {},
  async execute() {
    return JSON.stringify(await backendFetch("/scrapers/domains"));
  },
});

export const btwPush = tool({
  description: "Push a by-the-way note (ambient event).",
  args: {
    severity: tool.schema.enum(["info", "success", "warn", "error"]).default("info"),
    title: tool.schema.string(),
    body: tool.schema.string(),
    session_id: tool.schema.string().default(""),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/btw/push", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const modeList = tool({
  description: "List available agent modes (chat/plan/edit/yolo/ultrathink/...).",
  args: {},
  async execute() {
    return JSON.stringify(await backendFetch("/modes"));
  },
});

export const modeInvoke = tool({
  description: "Invoke an agent mode (e.g. ultrathink) with a payload.",
  args: {
    mode: tool.schema.string(),
    payload: tool.schema.record(tool.schema.string(), tool.schema.any()).optional(),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/modes/invoke", { method: "POST", body: JSON.stringify(args) }),
    );
  },
});

export const sessionObserverMetric = tool({
  description: "Record a tool-start or tool-end event for session observability.",
  args: {
    session_id: tool.schema.string(),
    tool: tool.schema.string(),
    success: tool.schema.boolean().default(true),
    error: tool.schema.string().default(""),
    phase: tool.schema.enum(["start", "end"]).default("end"),
  },
  async execute({ session_id, tool: t, success, error, phase }) {
    const path =
      phase === "start"
        ? `/session-observer/${session_id}/tool-start`
        : `/session-observer/${session_id}/tool-end`;
    return JSON.stringify(
      await backendFetch(path, {
        method: "POST",
        body: JSON.stringify({ tool: t, success, error }),
      }),
    );
  },
});

export const dashboardUpsert = tool({
  description: "Upsert a tile on the dashboard.",
  args: {
    id: tool.schema.string(),
    title: tool.schema.string(),
    value: tool.schema.any().optional(),
    detail: tool.schema.string().default(""),
    status: tool.schema.enum(["ok", "warn", "error"]).default("ok"),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/dashboard/tiles", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});

export const dashboardSummary = tool({
  description: "Get the full dashboard summary.",
  args: {},
  async execute() {
    return JSON.stringify(await backendFetch("/dashboard"));
  },
});

export const bootstrapStart = tool({
  description: "Start a fresh-deployment bootstrap flow.",
  args: {},
  async execute() {
    return JSON.stringify(
      await backendFetch("/bootstrap/start", { method: "POST" }),
    );
  },
});

export const compactBranch = tool({
  description: "Compact a branch's events into a summary.",
  args: {
    branch_id: tool.schema.string(),
    events: tool.schema.array(
      tool.schema.object({ kind: tool.schema.string(), payload: tool.schema.string() }),
    ),
    max_chars: tool.schema.number().default(4000),
  },
  async execute(args) {
    return JSON.stringify(
      await backendFetch("/compaction/branch", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    );
  },
});
