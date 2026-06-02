/**
 * /teleport — resume a session from a different machine.
 *
 * Serialises the current session state (history, plan, working
 * directory) and posts it to the backend, returning a one-time
 * resume token the user can paste on another machine to pick up
 * exactly where they left off.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { getApiClient } from "@/api/client.js";
import logger from "@/utils/logger.js";

export interface TeleportSnapshot {
  sessionId: string;
  projectDir: string;
  historyFile?: string;
  planFile?: string;
  takenAt: string;
}

export interface TeleportResult {
  token: string;
  expiresAt: string;
  resumeUrl: string;
}

export async function takeTeleportSnapshot(opts: { projectDir: string; sessionId: string }): Promise<TeleportSnapshot> {
  const root = path.join(opts.projectDir, ".pakalon");
  const historyFile = path.join(root, "history", `${opts.sessionId}.json`);
  const planFile = path.join(root, "plan.md");
  return {
    sessionId: opts.sessionId,
    projectDir: opts.projectDir,
    historyFile: (await fileExists(historyFile)) ? historyFile : undefined,
    planFile: (await fileExists(planFile)) ? planFile : undefined,
    takenAt: new Date().toISOString(),
  };
}

export async function uploadTeleport(snapshot: TeleportSnapshot): Promise<TeleportResult> {
  const payload: Record<string, unknown> = {
    session_id: snapshot.sessionId,
    project_dir: snapshot.projectDir,
    taken_at: snapshot.takenAt,
  };
  if (snapshot.historyFile) payload.history = await fs.readFile(snapshot.historyFile, "utf-8");
  if (snapshot.planFile) payload.plan = await fs.readFile(snapshot.planFile, "utf-8");

  const res = await getApiClient().post<TeleportResult>("/sessions/teleport", payload);
  logger.info({ session: snapshot.sessionId }, "Teleport snapshot uploaded");
  return res.data;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
