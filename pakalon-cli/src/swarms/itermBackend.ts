import { spawn, execSync } from "child_process";
import logger from "@/utils/logger.js";
import type {
  SwarmBackend,
  SpawnTeammateOpts,
  TeammateProcessInfo,
  BackendType,
} from "./types.js";

/**
 * ITermBackend — spawns teammates in iTerm2 tabs/panes on macOS.
 *
 * Uses AppleScript (osascript) to open new iTerm2 tabs and send keystrokes,
 * or the `it2` CLI when available.
 *
 * macOS-only: platform checks guard all calls.
 */
export class ITermBackend implements SwarmBackend {
  readonly backendType: BackendType = "iterm";

  private teammates: Map<string, TeammateProcessInfo> = new Map();
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  /**
   * Check if iTerm2 is available on this system (macOS only).
   */
  static isAvailable(): boolean {
    if (process.platform !== "darwin") return false;

    try {
      execSync(
        'osascript -e "tell application \\"System Events\\" to get name of every process whose background only is false"',
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch {
      return false;
    }

    try {
      execSync('osascript -e "tell application \\"iTerm2\\"" 2>/dev/null', { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build an AppleScript to open a new iTerm2 tab and run a command.
   */
  private buildAppleScript(opts: SpawnTeammateOpts): string {
    const envLines: string[] = [];
    if (opts.env) {
      for (const [key, value] of Object.entries(opts.env)) {
        if (value !== undefined && value !== "") {
          envLines.push(`set environment variable "${key}" to "${value.replace(/"/g, '\\"')}"`);
        }
      }
    }

    const envBlock = envLines.length > 0 ? `\n${envLines.join("\n")}\n` : "";

    const cmdParts = ["pakalon", "--agent"];
    if (opts.model) cmdParts.push("--model", opts.model);
    if (opts.prompt) cmdParts.push(`"${opts.prompt.replace(/"/g, '\\"')}"`);
    const cmd = cmdParts.join(" ");

    return `
      tell application "iTerm2"
        activate
        tell current session of current window
          set newSession to (split vertically with default profile)
          tell newSession
            ${envBlock}
            write text "cd ${opts.cwd.replace(/"/g, '\\"')} && ${cmd}"
            set name to "${opts.name}"
          end tell
        end tell
      end tell
    `;
  }

  /**
   * Spawn a new teammate in an iTerm2 pane.
   */
  async spawnTeammate(opts: SpawnTeammateOpts): Promise<TeammateProcessInfo> {
    const info: TeammateProcessInfo = {
      id: opts.id,
      name: opts.name,
      backend: "iterm",
      status: "starting",
      cwd: opts.cwd,
      startedAt: Date.now(),
    };

    this.teammates.set(opts.id, info);

    try {
      if (process.platform !== "darwin") {
        throw new Error("iTerm2 backend is only available on macOS");
      }

      const script = this.buildAppleScript(opts);
      await this.runAppleScript(script);

      info.status = "running";
      info.lastHeartbeat = Date.now();
      logger.info(`[ITermBackend] Spawned teammate "${opts.name}" in iTerm2`);
    } catch (err) {
      info.status = "error";
      info.error = err instanceof Error ? err.message : String(err);
      logger.error(`[ITermBackend] Failed to spawn teammate "${opts.name}": ${info.error}`);
    }

    return info;
  }

  /**
   * Send a message to a teammate's iTerm2 pane via AppleScript keystrokes.
   */
  async sendToTeammate(recipientId: string, message: string): Promise<boolean> {
    const info = this.teammates.get(recipientId);
    if (!info) {
      logger.warn(`[ITermBackend] Cannot send to unknown teammate ${recipientId}`);
      return false;
    }

    try {
      const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `
        tell application "iTerm2"
          tell current session of current window
            write text "${escaped}"
          end tell
        end tell
      `;
      await this.runAppleScript(script);
      return true;
    } catch (err) {
      logger.error(`[ITermBackend] Failed to send message to ${info.name}: ${err}`);
      return false;
    }
  }

  /**
   * Get status of a teammate. iTerm2 doesn't expose per-pane status,
   * so we rely on internal tracking.
   */
  getTeammateStatus(id: string): TeammateProcessInfo | undefined {
    return this.teammates.get(id);
  }

  /**
   * Kill a teammate's iTerm2 pane.
   */
  async killTeammate(id: string): Promise<boolean> {
    const info = this.teammates.get(id);
    if (!info) return false;

    try {
      if (process.platform === "darwin") {
        const script = `
          tell application "iTerm2"
            tell current session of current window
              close
            end tell
          end tell
        `;
        await this.runAppleScript(script);
      }
      info.status = "stopped";
      this.teammates.delete(id);
      logger.info(`[ITermBackend] Killed teammate "${info.name}"`);
      return true;
    } catch (err) {
      logger.error(`[ITermBackend] Failed to kill teammate "${info.name}": ${err}`);
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
   * Dispose of the backend — clean up internal state.
   */
  async dispose(): Promise<void> {
    for (const [id] of this.teammates) {
      await this.killTeammate(id);
    }
    this.teammates.clear();
  }

  /**
   * Run an AppleScript string via osascript.
   */
  private runAppleScript(script: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("osascript", ["-e", script], { stdio: "pipe" });
      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`AppleScript failed (exit ${code}): ${stderr}`));
        }
      });
      proc.on("error", reject);
    });
  }
}
