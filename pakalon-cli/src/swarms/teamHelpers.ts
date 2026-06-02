import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import logger from "@/utils/logger.js";
import type {
  BackendType,
  SpawnTeammateOpts,
  SwarmBackend,
  TeammateProcessInfo,
  TeamConfig,
} from "./types.js";
import { writeToMailbox, consumeMessages, cleanupMailbox } from "./teammateMailbox.js";
import { removeTeammatePermissions, syncLeaderPermissions } from "./permissionSync.js";

/**
 * TeamHelpers — high-level helper functions for team management.
 *
 * Orchestrates spawning, messaging, and lifecycle of a team of teammates.
 */

const TEAM_FILE = "team.json";

/**
 * Get the path to the team configuration file.
 */
function getTeamFilePath(projectDir: string): string {
  return path.join(projectDir, ".pakalon", TEAM_FILE);
}

/**
 * Save team configuration to disk.
 */
export function saveTeamConfig(projectDir: string, config: TeamConfig): void {
  const filePath = getTeamFilePath(projectDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Load team configuration from disk.
 */
export function loadTeamConfig(projectDir: string): TeamConfig | undefined {
  const filePath = getTeamFilePath(projectDir);
  if (!fs.existsSync(filePath)) return undefined;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as TeamConfig;
  } catch {
    return undefined;
  }
}

/**
 * Generate a unique teammate ID.
 */
export function generateTeammateId(name: string): string {
  const short = randomUUID().slice(0, 8);
  return `${name}@${short}`;
}

/**
 * Spawn a teammate and register it in the team.
 */
export async function spawnTeamMember(
  backend: SwarmBackend,
  projectDir: string,
  opts: Omit<SpawnTeammateOpts, "id" | "cwd">,
): Promise<TeammateProcessInfo> {
  const id = generateTeammateId(opts.name);
  const fullOpts: SpawnTeammateOpts = {
    ...opts,
    id,
    cwd: projectDir,
  };

  const info = await backend.spawnTeammate(fullOpts);

  // Initialize mailbox for the teammate
  const { initTeammateMailbox } = await import("./teammateMailbox.js");
  initTeammateMailbox(projectDir, id);

  return info;
}

/**
 * Send a shutdown signal to a teammate via mailbox.
 */
export function requestTeammateShutdown(
  projectDir: string,
  teammateId: string,
): void {
  writeToMailbox(projectDir, "leader", teammateId, "shutdown", "shutdown");
  logger.info(`[Team] Shutdown requested for teammate ${teammateId}`);
}

/**
 * Clean up a teammate after it has stopped.
 */
export function cleanupTeammate(
  projectDir: string,
  teammateId: string,
): void {
  cleanupMailbox(projectDir, teammateId);
  removeTeammatePermissions(projectDir, teammateId);
  logger.info(`[Team] Cleaned up teammate ${teammateId}`);
}

/**
 * Get all active teammate IDs from a backend.
 */
export function getActiveTeammateIds(backend: SwarmBackend): string[] {
  return backend
    .listTeammates()
    .filter((t) => t.status === "running" || t.status === "idle" || t.status === "busy")
    .map((t) => t.id);
}

/**
 * Get teammate names and statuses for display.
 */
export function getTeamStatusSummary(
  backend: SwarmBackend,
): Array<{ id: string; name: string; status: string; backend: string }> {
  return backend.listTeammates().map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    backend: t.backend,
  }));
}

/**
 * Synchronize permissions from the leader to all workers.
 */
export function syncTeamPermissions(
  projectDir: string,
  leaderId: string,
  backend: SwarmBackend,
  leaderPermissions: string[],
  leaderMode: "hil" | "yolo",
): void {
  const workerIds = backend
    .listTeammates()
    .filter((t) => t.id !== leaderId && (t.status === "running" || t.status === "idle"))
    .map((t) => t.id);

  syncLeaderPermissions(projectDir, leaderId, workerIds, leaderPermissions, leaderMode);
}

/**
 * Send a message to a teammate via the backend's messaging mechanism.
 */
export async function sendToTeammate(
  backend: SwarmBackend,
  projectDir: string,
  senderId: string,
  recipientId: string,
  content: string,
): Promise<boolean> {
  return backend.sendToTeammate(recipientId, content);
}

/**
 * Dispose of the entire team — kill all teammates and clean up.
 */
export async function disposeTeam(
  backend: SwarmBackend,
  projectDir: string,
): Promise<void> {
  const teammates = backend.listTeammates();
  for (const t of teammates) {
    await backend.killTeammate(t.id);
    cleanupTeammate(projectDir, t.id);
  }
  await backend.dispose();
}
