import logger from "@/utils/logger.js";
import type {
  BackendType,
  ReconnectionState,
  SwarmBackend,
  TeammateProcessInfo,
} from "./types.js";

/**
 * Reconnection — handles reconnecting to a teammate after disconnect.
 *
 * When a host process restarts or a teammate loses connectivity,
 * this module attempts to re-establish the connection by checking
 * if the underlying tmux session / iTerm2 tab still exists.
 */

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_INTERVAL_MS = 2000;

/**
 * Create initial reconnection state for a teammate.
 */
export function createReconnectionState(
  teammateId: string,
  backend: BackendType,
  lastKnownCwd: string,
  lastKnownSession?: string,
  lastKnownPid?: number,
): ReconnectionState {
  return {
    teammateId,
    backend,
    lastKnownSession,
    lastKnownPid,
    lastKnownCwd,
    disconnectedAt: Date.now(),
    reconnectAttempts: 0,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
  };
}

/**
 * Attempt to reconnect to a teammate using the given backend.
 * Returns the reconnected TeammateProcessInfo if successful, or undefined.
 */
export async function attemptReconnect(
  backend: SwarmBackend,
  state: ReconnectionState,
): Promise<TeammateProcessInfo | undefined> {
  if (state.reconnectAttempts >= state.maxReconnectAttempts) {
    logger.warn(
      `[Reconnect] Max reconnect attempts (${state.maxReconnectAttempts}) reached for ${state.teammateId}`,
    );
    return undefined;
  }

  state.reconnectAttempts++;
  logger.info(
    `[Reconnect] Attempting reconnect ${state.reconnectAttempts}/${state.maxReconnectAttempts} for ${state.teammateId}`,
  );

  // Check if the teammate process is still tracked by the backend
  const existing = backend.getTeammateStatus(state.teammateId);
  if (existing && existing.status !== "stopped" && existing.status !== "error") {
    logger.info(`[Reconnect] Teammate ${state.teammateId} is still alive`);
    return existing;
  }

  // If the backend is tmux, check if the tmux session still exists
  if (state.backend === "tmux" && state.lastKnownSession) {
    try {
      const { execSync } = await import("child_process");
      execSync(`tmux has-session -t ${state.lastKnownSession} 2>/dev/null`, {
        stdio: "pipe",
      });
      // Session exists — the teammate is likely alive but we lost track
      logger.info(
        `[Reconnect] Tmux session "${state.lastKnownSession}" still exists`,
      );
    } catch {
      logger.warn(
        `[Reconnect] Tmux session "${state.lastKnownSession}" no longer exists`,
      );
    }
  }

  return undefined;
}

/**
 * Wait with a delay between reconnect attempts.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a full reconnection cycle: attempt reconnect with retries.
 */
export async function reconnectWithRetries(
  backend: SwarmBackend,
  state: ReconnectionState,
): Promise<TeammateProcessInfo | undefined> {
  while (state.reconnectAttempts < state.maxReconnectAttempts) {
    const result = await attemptReconnect(backend, state);
    if (result) return result;

    if (state.reconnectAttempts < state.maxReconnectAttempts) {
      await delay(RECONNECT_INTERVAL_MS);
    }
  }

  logger.warn(`[Reconnect] Failed to reconnect to ${state.teammateId} after ${state.reconnectAttempts} attempts`);
  return undefined;
}

/**
 * Get all pending reconnection states (for UI display).
 */
export function getPendingReconnections(): ReconnectionState[] {
  // In a full implementation, these would be persisted
  // For now, return empty — reconnection states are managed per-session
  return [];
}
