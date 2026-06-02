import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";
import type { PermissionSyncState } from "./types.js";

/**
 * PermissionSync — synchronizes permission state across teammates.
 *
 * Each teammate reads a shared permission file to determine what it's
 * allowed to do. The leader writes the file; teammates poll it.
 */

const PERMISSIONS_FILE = "permissions.json";

/**
 * Get the path to the permissions file for a project.
 */
function getPermissionsPath(projectDir: string): string {
  return path.join(projectDir, ".pakalon", PERMISSIONS_FILE);
}

/**
 * Read the current permission state for all teammates.
 */
export function readPermissionState(projectDir: string): PermissionSyncState[] {
  const filePath = getPermissionsPath(projectDir);
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Write the full permission state for all teammates.
 */
export function writePermissionState(projectDir: string, states: PermissionSyncState[]): void {
  const filePath = getPermissionsPath(projectDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(states, null, 2), "utf-8");
  logger.debug(`[PermissionSync] Wrote permission state for ${states.length} teammate(s)`);
}

/**
 * Get the permission state for a specific teammate.
 */
export function getTeammatePermissions(
  projectDir: string,
  teammateId: string,
): PermissionSyncState | undefined {
  const states = readPermissionState(projectDir);
  return states.find((s) => s.teammateId === teammateId);
}

/**
 * Update or insert the permission state for a specific teammate.
 */
export function setTeammatePermissions(
  projectDir: string,
  teammateId: string,
  permissions: string[],
  permissionMode: "hil" | "yolo",
): void {
  const states = readPermissionState(projectDir);
  const existing = states.findIndex((s) => s.teammateId === teammateId);

  const newState: PermissionSyncState = {
    teammateId,
    permissions,
    permissionMode,
    updatedAt: Date.now(),
  };

  if (existing >= 0) {
    states[existing] = newState;
  } else {
    states.push(newState);
  }

  writePermissionState(projectDir, states);
}

/**
 * Remove a teammate's permission state.
 */
export function removeTeammatePermissions(projectDir: string, teammateId: string): void {
  const states = readPermissionState(projectDir);
  const filtered = states.filter((s) => s.teammateId !== teammateId);
  writePermissionState(projectDir, filtered);
}

/**
 * Synchronize leader permissions to all teammates.
 * Workers inherit the leader's permissions (or a subset if configured).
 */
export function syncLeaderPermissions(
  projectDir: string,
  leaderId: string,
  workerIds: string[],
  leaderPermissions: string[],
  leaderMode: "hil" | "yolo",
): void {
  const states = readPermissionState(projectDir);

  // Update leader
  const leaderState: PermissionSyncState = {
    teammateId: leaderId,
    permissions: leaderPermissions,
    permissionMode: leaderMode,
    updatedAt: Date.now(),
  };

  const filtered = states.filter(
    (s) => s.teammateId !== leaderId && !workerIds.includes(s.teammateId),
  );

  const workerStates: PermissionSyncState[] = workerIds.map((id) => ({
    teammateId: id,
    permissions: leaderPermissions,
    permissionMode: leaderMode,
    updatedAt: Date.now(),
  }));

  writePermissionState(projectDir, [leaderState, ...workerStates]);
}

/**
 * Check if a teammate has a specific permission.
 */
export function hasPermission(
  projectDir: string,
  teammateId: string,
  permission: string,
): boolean {
  const state = getTeammatePermissions(projectDir, teammateId);
  if (!state) return false;
  if (state.permissions.includes("all")) return true;
  return state.permissions.includes(permission);
}
