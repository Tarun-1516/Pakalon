/**
 * Internal Logging Service for pakalon-cli
 *
 * Provides internal logging for debugging and analytics.
 * Logs permission context and container information for internal users.
 */

import { readFile } from "fs/promises";
import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type ToolPermissionContext = Record<string, unknown>;

// ============================================================================
// Internal Logging Service
// ============================================================================

/**
 * Get the current Kubernetes namespace
 * Returns null on laptops/local development
 */
async function getKubernetesNamespace(): Promise<string | null> {
  if (process.env.USER_TYPE !== "ant") {
    return null;
  }
  const namespacePath =
    "/var/run/secrets/kubernetes.io/serviceaccount/namespace";
  try {
    const content = await readFile(namespacePath, { encoding: "utf8" });
    return content.trim();
  } catch {
    return null;
  }
}

/**
 * Get the OCI container ID from within a running container
 */
export async function getContainerId(): Promise<string | null> {
  if (process.env.USER_TYPE !== "ant") {
    return null;
  }
  const containerIdPath = "/proc/self/mountinfo";
  try {
    const mountinfo = (
      await readFile(containerIdPath, { encoding: "utf8" })
    ).trim();

    const containerIdPattern =
      /(?:\/docker\/containers\/|\/sandboxes\/)([0-9a-f]{64})/;

    const lines = mountinfo.split("\n");
    for (const line of lines) {
      const match = line.match(containerIdPattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Logs an event with the current namespace and tool permission context
 */
export async function logPermissionContextForAnts(
  toolPermissionContext: ToolPermissionContext | null,
  moment: "summary" | "initialization"
): Promise<void> {
  if (process.env.USER_TYPE !== "ant") {
    return;
  }

  const namespace = await getKubernetesNamespace();
  const containerId = await getContainerId();

  logger.info("[InternalLogging] Permission context", {
    moment,
    namespace,
    containerId,
    toolPermissionContext: toolPermissionContext
      ? JSON.stringify(toolPermissionContext)
      : null,
  });
}
