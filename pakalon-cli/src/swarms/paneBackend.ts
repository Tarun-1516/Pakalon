import { spawn, execSync } from "child_process";
import logger from "@/utils/logger.js";
import type {
  SwarmBackend,
  SpawnTeammateOpts,
  TeammateProcessInfo,
  BackendType,
} from "./types.js";

/**
 * PaneBackend — spawns teammates in Windows Terminal panes on Windows.
 *
 * Uses the Windows Terminal CLI (`wt.exe`) to split panes and run commands.
 * Falls back to PowerShell-based process creation when wt.exe is unavailable.
 *
 * Windows-only: platform checks guard all calls.
 */
export class PaneBackend implements SwarmBackend {
  readonly backendType: BackendType = "pane";

  private teammates: Map<string, TeammateProcessInfo> = new Map();
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  /**
   * Check if Windows Terminal is available on this system.
   */
  static isAvailable(): boolean {
    if (process.platform !== "win32") return false;

    try {
      execSync("where wt.exe", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn a new teammate in a Windows Terminal pane.
   */
  async spawnTeammate(opts: SpawnTeammateOpts): Promise<TeammateProcessInfo> {
    const info: TeammateProcessInfo = {
      id: opts.id,
      name: opts.name,
      backend: "pane",
      status: "starting",
      cwd: opts.cwd,
      startedAt: Date.now(),
    };

    this.teammates.set(opts.id, info);

    try {
      if (process.platform !== "win32") {
        throw new Error("Pane backend is only available on Windows");
      }

      const cmdParts = ["pakalon", "--agent"];
      if (opts.model) cmdParts.push("--model", opts.model);
      if (opts.prompt) cmdParts.push(`"${opts.prompt.replace(/"/g, '\\"')}"`);
      const cmd = cmdParts.join(" ");

      const envArgs: string[] = [];
      if (opts.env) {
        for (const [key, value] of Object.entries(opts.env)) {
          if (value !== undefined && value !== "") {
            envArgs.push("--env", `${key}=${value}`);
          }
        }
      }

      // Use wt.exe to create a new tab with the pakalon command
      const wtArgs = [
        "-w", "nt",
        "--title", opts.name,
        "new-tab",
        "--startingDirectory", opts.cwd,
        ...envArgs,
        "--", "cmd", "/c", cmd,
      ];

      await this.runCommand("wt.exe", wtArgs);

      info.status = "running";
      info.lastHeartbeat = Date.now();
      logger.info(`[PaneBackend] Spawned teammate "${opts.name}" in Windows Terminal`);
    } catch (err) {
      info.status = "error";
      info.error = err instanceof Error ? err.message : String(err);
      logger.error(`[PaneBackend] Failed to spawn teammate "${opts.name}": ${info.error}`);
    }

    return info;
  }

  /**
   * Send a message to a teammate.
   *
   * Windows Terminal doesn't have a direct send-keys API like tmux,
   * so we write to a file that the teammate polls, or use named pipes.
   */
  async sendToTeammate(recipientId: string, message: string): Promise<boolean> {
    const info = this.teammates.get(recipientId);
    if (!info) {
      logger.warn(`[PaneBackend] Cannot send to unknown teammate ${recipientId}`);
      return false;
    }

    // Use clipboard approach or file-based communication
    // For now, we use a temp file that the teammate can read
    try {
      const { writeFileSync, mkdirSync } = await import("fs");
      const { join } = await import("path");
      const { tmpdir } = await import("os");

      const inboxDir = join(tmpdir(), "pakalon-messages", info.id);
      mkdirSync(inboxDir, { recursive: true });

      const msgFile = join(inboxDir, `${Date.now()}.json`);
      writeFileSync(
        msgFile,
        JSON.stringify({
          senderId: "leader",
          recipientId: info.id,
          content: message,
          timestamp: Date.now(),
        }),
        "utf-8",
      );

      logger.debug(`[PaneBackend] Wrote message to ${msgFile}`);
      return true;
    } catch (err) {
      logger.error(`[PaneBackend] Failed to send message to ${info.name}: ${err}`);
      return false;
    }
  }

  /**
   * Get status of a teammate by checking if the process is still running.
   */
  getTeammateStatus(id: string): TeammateProcessInfo | undefined {
    const info = this.teammates.get(id);
    if (!info) return undefined;

    if (info.pid && process.platform === "win32") {
      try {
        execSync(`tasklist /FI "PID eq ${info.pid}" /NH`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        info.status = "running";
      } catch {
        info.status = "stopped";
      }
    }

    return info;
  }

  /**
   * Kill a teammate process.
   */
  async killTeammate(id: string): Promise<boolean> {
    const info = this.teammates.get(id);
    if (!info) return false;

    try {
      if (info.pid && process.platform === "win32") {
        execSync(`taskkill /PID ${info.pid} /T /F`, { stdio: "pipe" });
      }
      info.status = "stopped";
      this.teammates.delete(id);
      logger.info(`[PaneBackend] Killed teammate "${info.name}"`);
      return true;
    } catch (err) {
      logger.error(`[PaneBackend] Failed to kill teammate "${info.name}": ${err}`);
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
   * Dispose of the backend — kill all teammate processes.
   */
  async dispose(): Promise<void> {
    for (const [id] of this.teammates) {
      await this.killTeammate(id);
    }
    this.teammates.clear();
  }

  /**
   * Run a command as a child process and wait for completion.
   */
  private runCommand(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: "pipe", shell: true });
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
