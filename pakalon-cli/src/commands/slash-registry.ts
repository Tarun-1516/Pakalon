export interface SlashCommandEntry {
  name: string;
  description: string;
  category: string;
  usage?: string;
  aliases?: string[];
  insertValue?: string;
  hidden?: boolean;
  pluginId?: string;
}

export interface SlashCommandSuggestion {
  label: string;
  insertValue: string;
  description: string;
}

const CATEGORY_ORDER = [
  "session",
  "project",
  "agents",
  "workflow",
  "integrations",
  "plugins",
  "model",
  "git",
  "account",
  "ui",
  "advanced",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  session: "Session",
  project: "Project",
  agents: "Agents",
  workflow: "Workflow",
  integrations: "Integrations",
  plugins: "Plugins",
  model: "Model",
  git: "Git",
  account: "Account",
  ui: "UI",
  advanced: "Advanced",
};

const dynamicCommands = new Map<string, SlashCommandEntry>();

export const SLASH_COMMANDS: SlashCommandEntry[] = [
  { name: "help", description: "Show command help", category: "session", usage: "/help [command]", insertValue: "/help " },
  { name: "clear", description: "Clear the current conversation", category: "session", usage: "/clear" },
  { name: "compact", description: "Compress the current chat context", category: "session", usage: "/compact [messages]" },
  { name: "new", description: "Start a new chat session", category: "session", usage: "/new" },
  { name: "multi-session", description: "Open the multi-session switcher", category: "session", usage: "/multi-session [session-id|new|list]", aliases: ["mutli-session", "multisession"] },
  { name: "history", description: "List recent sessions for this directory", category: "session", usage: "/history" },
  { name: "session", description: "List sessions for this directory", category: "session", usage: "/session", aliases: ["sessions"] },
  { name: "resume", description: "Resume a previous session", category: "session", usage: "/resume [id]", insertValue: "/resume " },
  { name: "ans", description: "Ask a side-thread question without interrupting work", category: "session", usage: "/ans <question>", insertValue: "/ans " },
  { name: "fork", description: "Fork the current session with its message history", category: "session", usage: "/fork", aliases: ["branch"] },
  { name: "copy", description: "Copy an assistant response to the clipboard", category: "session", usage: "/copy [message-index] [--full] [--file path]", insertValue: "/copy " },
  { name: "export", description: "Export the conversation to markdown", category: "session", usage: "/export [filename]", insertValue: "/export " },
  { name: "release-notes", description: "Show recent imported Claude release notes", category: "session", usage: "/release-notes" },
  { name: "undo", description: "Show or apply undo operations", category: "session", usage: "/undo [all]" },
  { name: "rewind", description: "Restore a checkpoint from previous updates", category: "session", usage: "/rewind [checkpoint]" },
  { name: "cost", description: "Show token and spend estimates", category: "session", usage: "/cost" },
  { name: "cost-threshold", description: "Set or view the session cost threshold", category: "session", usage: "/cost-threshold [view|set <usd>|clear|mode <warn|confirm|pause>]" },
  { name: "token-warning", description: "Configure token usage warning thresholds", category: "session", usage: "/token-warning [view|set <notice> <warning> <critical> <compact>|enable|disable|reset]", aliases: ["token-limit", "token-warning-levels"] },
  { name: "autocompact", description: "Configure automatic context compaction", category: "session", usage: "/autocompact [on|off|threshold <pct>]" },
  { name: "exit", description: "Exit the CLI", category: "session", usage: "/exit", aliases: ["q"] },

  { name: "cwd", description: "Show or change the working directory", category: "project", usage: "/cwd [path]", insertValue: "/cwd " },
  { name: "add-dir", description: "Add a trusted directory", category: "project", usage: "/add-dir <path>", insertValue: "/add-dir " },
  { name: "context", description: "Show current context and token information", category: "project", usage: "/context" },
  { name: "ctx-viz", description: "Show detailed token budget visualization", category: "project", usage: "/ctx-viz", aliases: ["ctx_viz"] },
  { name: "permissions", description: "Manage project permission rules", category: "project", usage: "/permissions [list|add|remove]" },
  { name: "directory", description: "Show the current project tree", category: "project", usage: "/directory [path]", insertValue: "/directory " },
  { name: "doctor", description: "Run environment diagnostics", category: "project", usage: "/doctor" },
  { name: "install", description: "Verify local installation requirements", category: "project", usage: "/install" },
  { name: "memory", description: "View and manage project memory", category: "project", usage: "/memory [view|add|clear|reload|search]" },
  { name: "dream", description: "Run or configure automatic memory consolidation", category: "project", usage: "/dream [run|status|config]" },
  { name: "search", description: "Run a semantic or indexed project search", category: "project", usage: "/search <query>", insertValue: "/search " },
  { name: "grep", description: "Search the codebase with grep-style matching", category: "project", usage: "/grep <pattern>", insertValue: "/grep " },
  { name: "files", description: "List project files", category: "project", usage: "/files [pattern]", insertValue: "/files " },
  { name: "find-symbol", description: "Look up a symbol in the project", category: "project", usage: "/find-symbol <name>", insertValue: "/find-symbol " },
  { name: "goto", description: "Jump to a file or symbol", category: "project", usage: "/goto <target>", insertValue: "/goto " },
  { name: "clean", description: "Run project cleanup helpers", category: "project", usage: "/clean [target]", insertValue: "/clean " },
  { name: "error-help", description: "Explain and troubleshoot an error", category: "project", usage: "/error-help <message>", insertValue: "/error-help " },
  { name: "test-gen", description: "Generate tests for the current code", category: "project", usage: "/test-gen <target>", insertValue: "/test-gen " },
  { name: "update", description: "Apply a targeted codebase update", category: "project", usage: "/update <instruction>", insertValue: "/update " },
  { name: "design-update", description: "Apply a targeted wireframe or design update", category: "project", usage: "/design-update <instruction>", insertValue: "/design-update " },
  { name: "explore", description: "Run a read-only codebase exploration pass", category: "project", usage: "/explore <question>", insertValue: "/explore " },

  { name: "agents", description: "Create, update, and list saved agents", category: "agents", usage: "/agents [list|create|update|remove]" },
  { name: "agent", description: "Switch into agent mode", category: "agents", usage: "/agent" },
  { name: "skills", description: "List, create, and load available skills", category: "agents", usage: "/skills [list|create|load <name>]" },
  { name: "auditor", description: "Run the auditor agent against the codebase", category: "agents", usage: "/auditor [--yolo]" },
  { name: "insights", description: "Show workspace insights and analysis", category: "agents", usage: "/insights" },

  { name: "plan", description: "Generate a project plan", category: "workflow", usage: "/plan <description>", insertValue: "/plan " },
  { name: "build", description: "Start the build pipeline", category: "workflow", usage: "/build <description>", insertValue: "/build " },
  { name: "chat", description: "Return to normal chat mode", category: "workflow", usage: "/chat" },
  { name: "web", description: "Run web search or analyze a URL", category: "workflow", usage: "/web <query-or-url>", insertValue: "/web " },
  { name: "init", description: "Initialize Pakalon workspace files", category: "workflow", usage: "/init [prompt]", insertValue: "/init " },
  { name: "pakalon", description: "Launch the full six-phase Pakalon pipeline", category: "workflow", usage: "/pakalon <description>", insertValue: "/pakalon " },
  { name: "pakalon-agents", description: "Create .pakalon-agents scaffolding", category: "workflow", usage: "/pakalon-agents" },
  { name: "connect", description: "Connect the Telegram bridge", category: "workflow", usage: "/connect [bot-token]", insertValue: "/connect " },
  { name: "connect-end", description: "Disconnect the Telegram bridge", category: "workflow", usage: "/connect-end" },
  { name: "phase-1", description: "Run phase 1 planning workflow", category: "workflow", usage: "/phase-1" },
  { name: "phase-2", description: "Run phase 2 wireframe workflow", category: "workflow", usage: "/phase-2" },
  { name: "phase-3", description: "Run phase 3 implementation workflow", category: "workflow", usage: "/phase-3" },
  { name: "phase-4", description: "Run phase 4 security workflow", category: "workflow", usage: "/phase-4" },
  { name: "phase-5", description: "Run phase 5 deployment workflow", category: "workflow", usage: "/phase-5" },
  { name: "phase-6", description: "Run phase 6 documentation workflow", category: "workflow", usage: "/phase-6" },
  { name: "yolo", description: "Switch to YOLO mode (fully autonomous, no approval needed)", category: "workflow", usage: "/yolo" },
  { name: "HIL", description: "Switch to Human-in-Loop mode (requires approval for each action)", category: "workflow", usage: "/HIL", aliases: ["hil"] },
  { name: "workflows", description: "Manage saved workflows", category: "workflow", usage: "/workflows [list|show|save|create|run|delete|schedule|tag]" },
  { name: "automations", description: "Manage automations and connectors", category: "workflow", usage: "/automations [list|templates|create|connect|toggle|run|delete|logs|cron]" },

  { name: "plugins", description: "Manage installed plugins", category: "integrations", usage: "/plugins [list|install|remove|update|check|marketplace]" },
  { name: "mcp", description: "Manage MCP servers and prompts", category: "integrations", usage: "/mcp [list|add|remove|get|enable|disable|status|import-claude]" },
  { name: "penpot", description: "Open the Penpot design workflow", category: "integrations", usage: "/penpot" },
  { name: "hooks", description: "Manage hook configuration", category: "integrations", usage: "/hooks [list|add|remove|reload|disable]" },
  { name: "share", description: "Share the current conversation", category: "integrations", usage: "/share" },
  { name: "install-github-app", description: "Open the Pakalon GitHub App install flow", category: "integrations", usage: "/install-github-app" },
  { name: "enterprise", description: "Manage enterprise integrations like Jira and Notion", category: "integrations", usage: "/enterprise <service> <command>" },
  { name: "notifications", description: "Show account notifications", category: "integrations", usage: "/notifications" },
  { name: "desktop", description: "Open the desktop bridge", category: "integrations", usage: "/desktop" },
  { name: "mobile", description: "Show mobile companion information", category: "integrations", usage: "/mobile" },
  { name: "chrome", description: "Connect to Chrome remote debugging", category: "integrations", usage: "/chrome <subcommand>", insertValue: "/chrome " },

  { name: "models", description: "List available models", category: "model", usage: "/models [model-id]", aliases: ["model"], insertValue: "/models " },
  { name: "status", description: "Show account and workspace status", category: "model", usage: "/status" },
  { name: "config", description: "Open configuration management", category: "model", usage: "/config [project|global]" },
  { name: "settings", description: "Open settings", category: "model", usage: "/settings" },
  { name: "output-style", description: "Choose how responses are written", category: "model", usage: "/output-style <explanatory|concise|learning>", insertValue: "/output-style " },
  { name: "terse", description: "Toggle terse token-saving mode (ultra-compressed output)", category: "model", usage: "/terse [lite|full|ultra|wenyan-lite|wenyan|wenyan-ultra|off]", insertValue: "/terse " },
  { name: "terse-commit", description: "Generate terse conventional commit message", category: "model", usage: "/terse-commit" },
  { name: "terse-review", description: "Generate one-line code review comments", category: "model", usage: "/terse-review" },
  { name: "terse:compress", description: "Compress a markdown file to reduce tokens ~46%", category: "model", usage: "/terse:compress <filepath>", insertValue: "/terse:compress " },
  { name: "effort", description: "Show or set model reasoning effort", category: "model", usage: "/effort [status|low|medium|high|max]" },
  { name: "rate-limit-options", description: "Show rate-limit recovery and extra-usage options", category: "model", usage: "/rate-limit-options [status|open]" },

  { name: "git", description: "Run Git helper commands", category: "git", usage: "/git <subcommand>", insertValue: "/git " },
  { name: "diff", description: "Show git diff output", category: "git", usage: "/diff [ref]", insertValue: "/diff " },
  { name: "pr-comments", description: "Fetch GitHub pull request comments", category: "git", usage: "/pr-comments [repo]", aliases: ["pr_comments"] },
  { name: "review", description: "Review the current changes", category: "git", usage: "/review [target]", insertValue: "/review " },
  { name: "security-review", description: "Run a security-focused review of current changes", category: "git", usage: "/security-review" },
  { name: "worktree", description: "Manage git worktrees", category: "git", usage: "/worktree [subcommand]" },
  { name: "find-usages", description: "Find symbol usages", category: "git", usage: "/find-usages <symbol>", insertValue: "/find-usages " },

  { name: "logout", description: "Log out of the CLI and web session", category: "account", usage: "/logout" },
  { name: "upgrade", description: "Open upgrade instructions", category: "account", usage: "/upgrade" },
  { name: "extra-usage", description: "Request or open extra usage controls", category: "account", usage: "/extra-usage" },

  { name: "statusline", description: "Toggle the bottom status line", category: "ui", usage: "/statusline [on|off]" },
  { name: "vim", description: "Toggle vim mode", category: "ui", usage: "/vim [on|off|status]" },
  { name: "ide", description: "Toggle IDE integration mode", category: "ui", usage: "/ide [on|off|auto|status]" },
  { name: "keybindings", description: "Show keyboard shortcuts", category: "ui", usage: "/keybindings" },
  { name: "theme", description: "Switch the TUI theme", category: "ui", usage: "/theme <name>", insertValue: "/theme " },
  { name: "sandbox", description: "View and manage the AIO Sandbox container", category: "advanced", usage: "/sandbox [status|logs|destroy|provision]", aliases: ["sandbox-status"] },
  { name: "terminal-setup", description: "Show terminal environment setup checklist", category: "ui", usage: "/terminal-setup", aliases: ["terminalsetup"] },
  { name: "voice", description: "Toggle and manage voice mode", category: "ui", usage: "/voice [on|off|status|test]", aliases: ["v"] },
  { name: "teleport", description: "Teleport session to remote environment", category: "session", usage: "/teleport [target|--list|--status]", aliases: ["tp"] },
  { name: "tasks", description: "List and manage background tasks", category: "session", usage: "/tasks [list|get|stop] [task-id]" },

  { name: "swarm", description: "Run multi-agent swarm mode for complex tasks", category: "agents", usage: "/swarm <task> [--workers N] [--model <model>]", aliases: ["coordinator"], insertValue: "/swarm " },
  { name: "explain", description: "Explain code or diffs", category: "advanced", usage: "/explain <target>", insertValue: "/explain " },
  { name: "refactor", description: "Refactor a target file or symbol", category: "advanced", usage: "/refactor <target>", insertValue: "/refactor " },
  { name: "fix-lint", description: "Fix lint issues", category: "advanced", usage: "/fix-lint [path]", insertValue: "/fix-lint " },
  { name: "docstring", description: "Generate docstrings", category: "advanced", usage: "/docstring <target>", insertValue: "/docstring " },
  { name: "analyze-image", description: "Analyze an image file", category: "advanced", usage: "/analyze-image <path>", insertValue: "/analyze-image " },
  { name: "analyze-video", description: "Analyze a video file", category: "advanced", usage: "/analyze-video <path>", insertValue: "/analyze-video " },
  { name: "benchmark", description: "Run benchmark helpers", category: "advanced", usage: "/benchmark [subcommand]" },
  { name: "fake-pakalon", description: "Development-only telemetry reset helpers", category: "advanced", usage: "/fake-pakalon reset" },
  { name: "debug-tool-call", description: "Inspect tool-call traces captured in this session", category: "advanced", usage: "/debug-tool-call [tool-name-filter]" },
  { name: "mock-limits", description: "Configure internal mock rate-limit scenarios", category: "advanced", usage: "/mock-limits [status|list|<scenario>|clear]" },
  { name: "reset-limits", description: "Clear all active mock rate-limit headers", category: "advanced", usage: "/reset-limits" },
  { name: "break-cache", description: "Clear runtime caches (skills, MCP, prompts, search)", category: "advanced", usage: "/break-cache" },
  { name: "heapdump", description: "Write a heap snapshot and memory diagnostics file", category: "advanced", usage: "/heapdump" },
  { name: "perf-issue", description: "Capture a quick local performance diagnostics report", category: "advanced", usage: "/perf-issue" },
  { name: "good-claude", description: "Generate a concise runtime health report", category: "advanced", usage: "/good-claude" },
  { name: "auto-dream", description: "Run memory consolidation — scan sessions for recurring topics", category: "advanced", usage: "/auto-dream" },
];

function normalizeSlashCommand(name: string): string {
  return name.trim().replace(/^\//, "").toLowerCase();
}

function compareCommands(a: SlashCommandEntry, b: SlashCommandEntry): number {
  const categoryDelta =
    CATEGORY_ORDER.indexOf(a.category as (typeof CATEGORY_ORDER)[number]) -
    CATEGORY_ORDER.indexOf(b.category as (typeof CATEGORY_ORDER)[number]);
  if (categoryDelta !== 0) return categoryDelta;
  return a.name.localeCompare(b.name);
}

export function getAllSlashCommands(): SlashCommandEntry[] {
  return [...SLASH_COMMANDS, ...dynamicCommands.values()]
    .filter((command) => !command.hidden)
    .slice()
    .sort(compareCommands);
}

export function getSlashCommand(name: string): SlashCommandEntry | undefined {
  const normalized = normalizeSlashCommand(name);
  const dynamic = dynamicCommands.get(normalized);
  if (dynamic) return dynamic;
  return SLASH_COMMANDS.find((command) => {
    if (command.name === normalized) return true;
    return (command.aliases ?? []).some((alias) => alias === normalized);
  });
}

export function registerSlashCommand(command: SlashCommandEntry): void {
  const normalized = normalizeSlashCommand(command.name);
  dynamicCommands.set(normalized, { ...command, name: normalized });
}

export function unregisterSlashCommand(name: string): boolean {
  return dynamicCommands.delete(normalizeSlashCommand(name));
}

export function getSlashCommandSuggestions(query = ""): SlashCommandSuggestion[] {
  const normalized = normalizeSlashCommand(query);
  const commands = getAllSlashCommands();
  const deduped = new Map<string, SlashCommandSuggestion>();

  const ranked = commands
    .filter((command) => {
      if (!normalized) return true;
      if (command.name.includes(normalized)) return true;
      return (command.aliases ?? []).some((alias) => alias.includes(normalized));
    })
    .sort((a, b) => {
      const aStarts = a.name.startsWith(normalized) ? 0 : 1;
      const bStarts = b.name.startsWith(normalized) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return compareCommands(a, b);
    });

  for (const command of ranked) {
    const key = command.name;
    if (deduped.has(key)) continue;
    deduped.set(key, {
      label: `/${command.name}`,
      insertValue: command.insertValue ?? `/${command.name}`,
      description: command.description,
    });
  }

  return [...deduped.values()];
}

export function formatSlashCommandHelp(commandName: string): string {
  const command = getSlashCommand(commandName);
  if (!command) {
    return `Unknown command: /${normalizeSlashCommand(commandName)}\n\nRun /help for the available slash commands.`;
  }

  const lines = [
    `/${command.name}`,
    "=".repeat(command.name.length + 1),
    command.description,
  ];

  if (command.usage) {
    lines.push("", `Usage: ${command.usage}`);
  }

  if (command.aliases?.length) {
    lines.push("", `Aliases: ${command.aliases.map((alias) => `/${alias}`).join(", ")}`);
  }

  lines.push("", `Category: ${CATEGORY_LABELS[command.category] ?? command.category}`);
  return lines.join("\n");
}

export function formatSlashHelpOverview(): string {
  const byCategory = new Map<string, SlashCommandEntry[]>();

  for (const command of getAllSlashCommands()) {
    if (!byCategory.has(command.category)) {
      byCategory.set(command.category, []);
    }
    byCategory.get(command.category)!.push(command);
  }

  const lines = [
    "Pakalon slash commands",
    "",
    "Type /help <command> for command-specific usage.",
  ];

  for (const category of CATEGORY_ORDER) {
    const commands = byCategory.get(category);
    if (!commands?.length) continue;
    lines.push("", `${CATEGORY_LABELS[category] ?? category}`);
    lines.push("-".repeat((CATEGORY_LABELS[category] ?? category).length));
    for (const command of commands) {
      lines.push(`  /${command.name} - ${command.description}`);
    }
  }

  lines.push("", "Tip: type / in the input bar to browse slash command suggestions.");
  return lines.join("\n");
}
