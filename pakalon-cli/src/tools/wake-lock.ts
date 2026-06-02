/**
 * /wake-lock — keep the machine awake while a long-running build
 * is in progress. Windows / macOS / Linux each need a different
 * shell-out.
 */
import { spawn } from "child_process";
import logger from "@/utils/logger.js";

let currentChild: ReturnType<typeof spawn> | null = null;

/** Start a wake-lock. Returns a stop() function. */
export function acquireWakeLock(): () => void {
  if (currentChild) return () => stopWakeLock();
  const cmd = pickCommand();
  if (!cmd) {
    logger.warn("Wake-lock not supported on this platform");
    return () => undefined;
  }
  try {
    currentChild = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true });
    logger.info({ cmd }, "Wake-lock acquired");
  } catch (err) {
    logger.warn({ err }, "Failed to acquire wake-lock");
    currentChild = null;
  }
  return () => stopWakeLock();
}

export function stopWakeLock(): void {
  if (currentChild) {
    try {
      currentChild.kill();
    } catch {
      // ignore
    }
    currentChild = null;
    logger.info("Wake-lock released");
  }
}

function pickCommand(): string[] | null {
  if (process.platform === "win32") {
    // PowerShell SetThreadExecutionState — ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    return [
      "powershell.exe",
      "-NoProfile",
      "-Command",
      "Add-Type -Namespace W -Name K -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'; [W.K]::SetThreadExecutionState(0x80000002) | Out-Null; while ($true) { Start-Sleep -Seconds 30 }",
    ];
  }
  if (process.platform === "darwin") {
    return ["caffeinate", "-di"];
  }
  // Linux: systemd-inhibit
  return ["systemd-inhibit", "--what=handle-lid-switch:sleep:idle", "--who=pakalon", "--why=long-build", "sleep", "infinity"];
}
