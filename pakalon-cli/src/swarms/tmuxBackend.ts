import { spawn, execSync } from "child_process";
import logger from "@/utils/logger.js";
import type {
  SwarmBackend,
  SpawnTeammateOpts,
  TeammateProcessInfo,
  TeammateProcessStatus,
  BackendType,
} from "./types.js";

/**
 * TmuxBackend — spawns teammates in tmux sessions/panes.
 *
 * Each teammate gets its own tmux session. Communication is done via
 * `tmux send-keys` to the session. Status is checked via
 * `tmux list-panes`.
 *
 * Requires tmux to be installed and on PATH.
 */
export class TmuxBackend implements SwarmBackend {
  readonly backendType: BackendType = "tmux";

  private teammates: Map<string, TeammateProcessInfo> = new Map();
  private sessionPrefix: string;
  private projectDir: string;

  constructor(projectDir: string, sessionPrefix = "pakalon") {
    this.projectDir = projectDir;
    this.sessionPrefix = sessionPrefix;
  }

  /**
   * Check if tmux is available on this system.
   */
  static isAvailable(): boolean {
    try {
      execSync("which tmux", { stdio: "pipe" });
      return true;
    } catch {
      try {
        execSync("where tmux", { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Check if we're currently inside a tmux session.
   */
  static isInsideTmux(): boolean {
    return !!process.env.TMUX;
  }

  /**
   * Spawn a new teammate in a dedicated tmux session.
   */
  async spawnTeammate(opts: SpawnTeammateOpts): Promise<TeammateProcessInfo> {
    const sessionName = `${this.sessionPrefix}-${opts.name}`;

    const info: TeammateProcessInfo = {
      id: opts.id,
      name: opts.name,
      backend: "tmux",
      status: "starting",
      sessionName,
      cwd: opts.cwd,
      startedAt: Date.now(),
    };

    this.teammates.set(opts.id, info);

    try {
      // Kill existing session with same name if it exists
      try {
        execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, { stdio: "pipe" });
      } catch {
        // Session didn't exist, that's fine
      }

      // Build the command to run inside the tmux session
      const cmdParts = ["pakalon", "--agent"];
      if (opts.model) {
        cmdParts.push("--model", opts.model);
      }
      if (opts.prompt) {
        cmdParts.push(`"${opts.prompt.replace(/"/g, '\\"')}"`);
      }
      const cmd = cmdParts.join(" ");

      // Create the tmux session
      const env = {
        ...process.env,
        ...opts.env,
        PAKALON_AGENT_NAME: opts.name,
        PAKALON_TEAM_NAME: opts.teamName ?? "",
        PAKALON_TEAMMATE_ID: opts.id,
        PAKALON_COLOR: opts.color ?? "",
      };

      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && value !== "") {
          envArgs.push("-e", `${key}=${value}`);
        }
      }

      const args = [
        "new-session",
        "-d",
        "-s", sessionName,
        "-c", opts.cwd,
        ...envArgs,
        cmd,
      ];

      await this.runCommand("tmux", args);

      info.status = "running";
      info.pid = await this.getPanePid(sessionName);
      info.lastHeartbeat = Date.now();

      logger.info(`[TmuxBackend] Spawned teammate "${opts.name}" in tmux session ${sessionName}`);
    } catch (err) {
      info.status = "error";
      info.error = err instanceof Error ? err.message : String(err);
      logger.error(`[TmuxBackend] Failed to spawn teammate "${opts.name}": ${info.error}`);
    }

    return info;
  }

  /**
   * Send a message (command text) to a teammate's tmux session.
   */
  async sendToTeammate(recipientId: string, message: string): Promise<boolean> {
    const info = this.teammates.get(recipientId);
    if (!info || !info.sessionName) {
      logger.warn(`[TmuxBackend] Cannot send to unknown teammate ${recipientId}`);
      return false;
    }

    try {
      await this.runCommand("tmux", [
        "send-keys",
        "-t", info.sessionName,
        message,
        "Enter",
      ]);
      return true;
    } catch (err) {
      logger.error(`[TmuxBackend] Failed to send message to ${info.name}: ${err}`);
      return false;
    }
  }

  /**
   * Get the current status of a teammate by checking tmux session.
   */
  getTeammateStatus(id: string): TeammateProcessInfo | undefined {
    const info = this.teammates.get(id);
    if (!info) return undefined;

    // Update status based on whether the tmux session still exists
    if (info.sessionName) {
      try {
        execSync(`tmux has-session -t ${info.sessionName} 2>/dev/null`, { stdio: "pipe" });
        info.status = info.status === "error" ? "running" : info.status;
      } catch {
        info.status = "stopped";
      }
    }

    return info;
  }

  /**
   * Kill a teammate's tmux session.
   */
  async killTeammate(id: string): Promise<boolean> {
    const info = this.teammates.get(id);
    if (!info || !info.sessionName) return false;

    try {
      await this.runCommand("tmux", ["kill-session", "-t", info.sessionName]);
      info.status = "stopped";
      this.teammates.delete(id);
      logger.info(`[TmuxBackend] Killed teammate "${info.name}"`);
      return true;
    } catch (err) {
      logger.error(`[TmuxBackend] Failed to kill teammate "${info.name}": ${err}`);
      return false;
    }
  }

  /**
   * List all teammates managed by this backend.
   */
  listTeammates(): TeammateProcessInfo[] {
    return Array.from(this.teammates.values());
  }

  /**
   * Dispose of the backend — kill all sessions.
   */
  async dispose(): Promise<void> {
    for (const [id] of this.teammates) {
      await this.killTeammate(id);
    }
    this.teammates.clear();
  }

  /**
   * Capture the current pane output for a teammate.
   */
  async capturePaneOutput(sessionName: string): Promise<string | null> {
    try {
      return execSync(`tmux capture-pane -t ${sessionName} -p`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return null;
    }
  }

  /**
   * Split the current pane to create a new pane for a teammate.
   */
  async splitPane(
    sessionName: string,
    direction: "horizontal" | "vertical" = "horizontal",
  ): Promise<boolean> {
    try {
      const flag = direction === "horizontal" ? "-h" : "-v";
      await this.runCommand("tmux", [
        "split-window",
        flag,
        "-t", sessionName,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Set pane title for a teammate.
   */
  setPaneTitle(sessionName: string, title: string): void {
    try {
      execSync(`tmux select-pane -t ${sessionName} -T "${title}"`, { stdio: "pipe" });
    } catch {
      // Best-effort — title setting may not be supported everywhere
    }
  }

  /**
   * Get the PID of the main process in a tmux pane.
   */
  private async getPanePid(sessionName: string): Promise<number | undefined> {
    try {
      const output = execSync(
        `tmux list-panes -t ${sessionName} -F "#{pane_pid}" 2>/dev/null`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      const pid = parseInt(output.trim().split("\n")[0] ?? "", 10);
      return isNaN(pid) ? undefined : pid;
    } catch {
      return undefined;
    }
  }

  /**
   * Run a command as a child process and wait for completion.
   */
  private runCommand(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: "pipe" });
      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed (exit ${code}): ${stderr}`));
        }
      });
      proc.on("error", reject);
    });
  }
}
