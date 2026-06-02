import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";
import type { BackendType, SpawnTeammateOpts, SwarmBackend } from "./types.js";
import { initTeammateMailbox } from "./teammateMailbox.js";
import { setTeammatePermissions } from "./permissionSync.js";

/**
 * TeammateInit — initializes a new teammate with the right environment,
 * configuration, and role before it starts executing.
 *
 * Sets up:
 * - Teammate mailbox directory
 * - Permission state
 * - Environment variables
 * - Working directory configuration
 * - .pakalon-agents config files
 */

/**
 * Configuration for initializing a teammate.
 */
export interface TeammateInitConfig {
  teammateId: string;
  name: string;
  teamName: string;
  role: "leader" | "worker";
  projectDir: string;
  backend: BackendType;
  model?: string;
  agentType?: string;
  color?: string;
  permissions?: string[];
  permissionMode?: "hil" | "yolo";
}

/**
 * Build the environment variables for a teammate process.
 */
export function buildTeammateEnv(config: TeammateInitConfig): Record<string, string> {
  return {
    PAKALON_TEAMMATE_ID: config.teammateId,
    PAKALON_AGENT_NAME: config.name,
    PAKALON_TEAM_NAME: config.teamName,
    PAKALON_TEAM_ROLE: config.role,
    PAKALON_BACKEND: config.backend,
    PAKALON_COLOR: config.color ?? "",
    ...(config.model ? { PAKALON_MODEL: config.model } : {}),
    ...(config.agentType ? { PAKALON_AGENT_TYPE: config.agentType } : {}),
  };
}

/**
 * Build spawn options from an init config.
 */
export function buildSpawnOpts(config: TeammateInitConfig, prompt: string): SpawnTeammateOpts {
  return {
    id: config.teammateId,
    name: config.name,
    prompt,
    cwd: config.projectDir,
    model: config.model,
    agentType: config.agentType,
    teamName: config.teamName,
    color: config.color,
    env: buildTeammateEnv(config),
  };
}

/**
 * Initialize the mailbox and permission state for a new teammate.
 */
export function initTeammateState(config: TeammateInitConfig): void {
  // Create mailbox directory
  initTeammateMailbox(config.projectDir, config.teammateId);

  // Set initial permissions
  setTeammatePermissions(
    config.projectDir,
    config.teammateId,
    config.permissions ?? ["read", "edit", "execute"],
    config.permissionMode ?? "hil",
  );

  logger.info(`[TeammateInit] Initialized teammate "${config.name}" (${config.teammateId})`);
}

/**
 * Ensure the .pakalon-agents directory exists for the project.
 */
export function ensureAgentsDir(projectDir: string): void {
  const agentsDir = path.join(projectDir, ".pakalon-agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  // Create settings.json if it doesn't exist
  const settingsPath = path.join(agentsDir, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          version: 1,
          createdAt: Date.now(),
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  // Ensure agents subdirectory exists
  const agentsSubdir = path.join(agentsDir, "agents");
  fs.mkdirSync(agentsSubdir, { recursive: true });
}

/**
 * Full initialization sequence for a new teammate.
 * Returns the spawn opts ready for use with a backend.
 */
export function initializeTeammate(
  config: TeammateInitConfig,
  prompt: string,
): SpawnTeammateOpts {
  ensureAgentsDir(config.projectDir);
  initTeammateState(config);
  return buildSpawnOpts(config, prompt);
}
