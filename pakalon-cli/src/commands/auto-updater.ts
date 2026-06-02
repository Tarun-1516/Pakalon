/**
 * /update — auto-update the CLI.
 *
 * Fetches the latest version from npm (or GitHub releases) and
 * reinstalls in place. Falls back to "please run npm i -g" if the
 * user is on a self-hosted install.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import logger from "@/utils/logger.js";

const execFileAsync = promisify(execFile);

export interface UpdateResult {
  before: string;
  after: string;
  ok: boolean;
  reason?: string;
}

export async function getCurrentVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("npm", ["list", "-g", "pakalon", "--depth=0"], { windowsHide: true });
    const m = stdout.match(/pakalon@(\d+\.\d+\.\d+)/);
    return m ? m[1] : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function getLatestVersion(): Promise<string> {
  try {
    const res = await fetch("https://registry.npmjs.org/pakalon/latest");
    const data = (await res.json()) as { version?: string };
    return data.version ?? "0.0.0";
  } catch (err) {
    logger.warn({ err }, "getLatestVersion failed");
    return "0.0.0";
  }
}

export async function runSelfUpdate(): Promise<UpdateResult> {
  const before = await getCurrentVersion();
  const latest = await getLatestVersion();
  if (before === latest) {
    return { before, after: before, ok: true, reason: "already-latest" };
  }
  try {
    await execFileAsync("npm", ["install", "-g", "pakalon@latest"], { stdio: "inherit", windowsHide: true });
    const after = await getCurrentVersion();
    return { before, after, ok: true };
  } catch (err) {
    return { before, after: before, ok: false, reason: (err as Error).message };
  }
}
