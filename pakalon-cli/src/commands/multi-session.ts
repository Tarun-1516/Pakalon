/**
 * /multi-session command — manage multiple concurrent sessions.
 * 
 * Features:
 * - List all sessions with loading indicators
 * - Switch between sessions
 * - Create new sessions
 * - Show running status and input-needed state
 */
import type { CommandContext, CommandResult } from "./types.js";
import { useStore } from "@/store/index.js";
import { cmdListSessions, cmdCreateSession, cmdResumeSession } from "./session.js";
import { isSelfHosted } from "@/config/mode.js";
import { listLocalSessions, createLocalSession } from "@/db/local.js";
import { formatDuration } from "@/utils/format.js";

export interface MultiSessionInfo {
  id: string;
  title: string | null;
  mode: string;
  model_id: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
  isRunning?: boolean;
  needsInput?: boolean;
  loading?: boolean;
  error?: string;
}

function getCommandElapsed(sessionId: string, startedAt?: number | null): number | undefined {
  const store = useStore.getState();
  const commandStarts = store.runningCommands
    .filter((command) => command.sessionId === sessionId && command.status === "running")
    .map((command) => command.startTime);
  const commandStart = commandStarts.length > 0 ? Math.min(...commandStarts) : undefined;
  if (commandStart) return Date.now() - commandStart;
  if (startedAt) return Date.now() - startedAt;
  return undefined;
}

export function getMultiSessionStatus(session: MultiSessionInfo): "running" | "completed" | "failed" | "idle" {
  if (session.isRunning) return session.needsInput ? "running" : "running";
  return "idle";
}

/**
 * Get all sessions for current project with running status
 */
export async function getMultiSessions(projectDir?: string): Promise<MultiSessionInfo[]> {
  if (isSelfHosted()) {
    const sessions = listLocalSessions(20, projectDir) as MultiSessionInfo[];
    return sessions.map((s) => ({ ...s, isRunning: false, needsInput: false }));
  }
  return cmdListSessions(20, projectDir);
}

/**
 * Format session list for display with loading indicators
 */
export function formatMultiSessionList(sessions: MultiSessionInfo[]): string {
  const store = useStore.getState();
  const lines = [
    "\n── Multi-Session Manager ─────────────────────────────",
    "",
    "Sessions:",
    "",
  ];

  if (sessions.length === 0) {
    lines.push("  No sessions found for this project.");
    lines.push("");
    lines.push("Use /new to create a new session.");
    return lines.join("\n") + "\n";
  }

  for (const session of sessions) {
    const status = session.loading 
      ? "[...]" 
      : session.isRunning 
        ? session.needsInput ? "[?!]" : "[~~]" 
        : "[ok]";
    
    const indicator = session.loading
      ? " [loading...]"
      : session.isRunning
        ? session.needsInput ? " [input needed]" : " [running]"
        : session.error ? ` [error: ${session.error}]` : "";
    
    const elapsed = getCommandElapsed(session.id, store.sessionStartedAt);
    const date = new Date(session.updated_at).toLocaleTimeString();
    const title = session.title || "Untitled";
    const messageCount = session.message_count ?? 0;
    
    lines.push(`  ${status} ${session.id.slice(0, 8)}... ${title}${indicator}`);
    lines.push(`     Updated: ${date} | Messages: ${messageCount} | Model: ${session.model_id ?? "default"}${elapsed ? ` | Elapsed: ${formatDuration(elapsed)}` : ""}`);
    lines.push("");
  }

  lines.push("Commands:");
  lines.push("  /multi-session <session-id>  - Switch to session");
  lines.push("  /multi-session new           - Create new session");
  lines.push("  /multi-session list          - Show this list");
  lines.push("");

  return lines.join("\n");
}

export const multiSessionCommand = {
  name: "multi-session",
  aliases: ["multisession", "mutli-session"],
  description: "Open the multi-session switcher",
  usage: "/multi-session [session-id|new|list]",
  category: "session",

  async execute(context: CommandContext, args: string[]): Promise<CommandResult> {
    const subCommand = args[0];
    const projectDir = context.cwd ?? process.cwd();
    const store = useStore.getState();

    if (!subCommand || subCommand === "list") {
      const sessions = await getMultiSessions(projectDir);
      return {
        success: true,
        message: formatMultiSessionList(sessions),
      };
    }

    if (subCommand === "new") {
      const { selectedModel } = store;
      const newSession = await cmdCreateSession(undefined, "chat", projectDir);
      store.setSessionId(newSession.id);
      return {
        success: true,
        message: `Created new session: ${newSession.id.slice(0, 8)}...`,
      };
    }

    if (subCommand === "current") {
      const currentId = store.sessionId;
      if (!currentId) {
        return {
          success: false,
          message: "No active session. Use /new to create one.",
        };
      }
      const sessions = await getMultiSessions(projectDir);
      const found = sessions.find((s) => s.id === currentId);
      if (found) {
        store.setSessionId(found.id);
        return {
          success: true,
          message: `Switched to session: ${found.id.slice(0, 8)}...`,
        };
      }
      return {
        success: false,
        message: `Current session not found in list.`,
      };
    }

    const sessions = await getMultiSessions(projectDir);
    const targetSession = sessions.find((s) => 
      s.id.startsWith(subCommand) || s.id === subCommand
    );

    if (!targetSession) {
      return {
        success: false,
        message: `Session not found: ${subCommand}\n\n${formatMultiSessionList(sessions)}`,
      };
    }

    await cmdResumeSession(targetSession.id, projectDir);
    return {
      success: true,
      message: `Switched to session: ${targetSession.id.slice(0, 8)}...`,
    };
  },
};

export default {
  multiSessionCommand,
  getMultiSessions,
  formatMultiSessionList,
};
