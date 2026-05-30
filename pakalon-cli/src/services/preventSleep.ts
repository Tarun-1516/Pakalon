/**
 * Prevent Sleep Service for pakalon-cli
 *
 * Prevents macOS from sleeping while Pakalon is working.
 * Uses the built-in `caffeinate` command to create a power assertion.
 *
 * Only runs on macOS - no-op on other platforms.
 */

import { type ChildProcess, spawn } from "child_process";
import logger from "@/utils/logger.js";

// ============================================================================
// Constants
// ============================================================================

const CAFFEINATE_TIMEOUT_SECONDS = 300; // 5 minutes
const RESTART_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

// ============================================================================
// Module State
// ============================================================================

let caffeinateProcess: ChildProcess | null = null;
let restartInterval: ReturnType<typeof setInterval> | null = null;
let refCount = 0;
let cleanupRegistered = false;

// ============================================================================
// Public API
// ============================================================================

/**
 * Increment the reference count and start preventing sleep if needed.
 * Call this when starting work that should keep the Mac awake.
 */
export function startPreventSleep(): void {
  refCount++;

  if (refCount === 1) {
    spawnCaffeinate();
    startRestartInterval();
  }
}

/**
 * Decrement the reference count and allow sleep if no more work is pending.
 * Call this when work completes.
 */
export function stopPreventSleep(): void {
  if (refCount > 0) {
    refCount--;
  }

  if (refCount === 0) {
    stopRestartInterval();
    killCaffeinate();
  }
}

/**
 * Force stop preventing sleep, regardless of reference count.
 * Use this for cleanup on exit.
 */
export function forceStopPreventSleep(): void {
  refCount = 0;
  stopRestartInterval();
  killCaffeinate();
}

// ============================================================================
// Internal Functions
// ============================================================================

function startRestartInterval(): void {
  // Only run on macOS
  if (process.platform !== "darwin") {
    return;
  }

  // Already running
  if (restartInterval !== null) {
    return;
  }

  restartInterval = setInterval(() => {
    if (refCount > 0) {
      logger.debug("[PreventSleep] Restarting caffeinate");
      killCaffeinate();
      spawnCaffeinate();
    }
  }, RESTART_INTERVAL_MS);

  // Don't let the interval keep the Node process alive
  restartInterval.unref();
}

function stopRestartInterval(): void {
  if (restartInterval !== null) {
    clearInterval(restartInterval);
    restartInterval = null;
  }
}

function spawnCaffeinate(): void {
  // Only run on macOS
  if (process.platform !== "darwin") {
    return;
  }

  // Already running
  if (caffeinateProcess !== null) {
    return;
  }

  try {
    caffeinateProcess = spawn(
      "caffeinate",
      ["-i", "-t", String(CAFFEINATE_TIMEOUT_SECONDS)],
      {
        stdio: "ignore",
      }
    );

    caffeinateProcess.unref();

    const thisProc = caffeinateProcess;
    caffeinateProcess.on("error", (err) => {
      logger.debug(`[PreventSleep] caffeinate spawn error: ${err.message}`);
      if (caffeinateProcess === thisProc) caffeinateProcess = null;
    });

    caffeinateProcess.on("exit", () => {
      if (caffeinateProcess === thisProc) caffeinateProcess = null;
    });

    logger.debug("[PreventSleep] Started caffeinate");
  } catch {
    caffeinateProcess = null;
  }
}

function killCaffeinate(): void {
  if (caffeinateProcess !== null) {
    const proc = caffeinateProcess;
    caffeinateProcess = null;
    try {
      proc.kill("SIGKILL");
      logger.debug("[PreventSleep] Stopped caffeinate");
    } catch {
      // Process may have already exited
    }
  }
}
