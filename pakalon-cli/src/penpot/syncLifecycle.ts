/**
 * Sync.js Auto-Lifecycle
 *
 * Auto-start/stop of sync.js when Penpot opens/closes.
 * Monitors Penpot container status and manages sync lifecycle.
 *
 * Strategy:
 * 1. Monitor Penpot container status
 * 2. Auto-start sync when Penpot is running
 * 3. Auto-stop sync when Penpot stops
 * 4. Handle container lifecycle events
 */

import { EventEmitter } from 'events';
import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncLifecycleOptions {
  /** Penpot host (default: localhost) */
  penpotHost?: string;
  /** Penpot port (default: 3449) */
  penpotPort?: number;
  /** Health check interval in ms (default: 5000) */
  healthCheckInterval?: number;
  /** Connection timeout in ms (default: 5000) */
  connectionTimeout?: number;
  /** Whether to auto-start sync (default: true) */
  autoStart?: boolean;
  /** Whether to auto-stop sync (default: true) */
  autoStop?: boolean;
  /** Callback when sync starts */
  onSyncStart?: () => void;
  /** Callback when sync stops */
  onSyncStop?: () => void;
  /** Callback when Penpot status changes */
  onPenpotStatusChange?: (running: boolean) => void;
}

export interface PenpotStatus {
  /** Whether Penpot is running */
  running: boolean;
  /** Penpot URL */
  url: string;
  /** Last health check time */
  lastCheck: Date;
  /** Response time in ms */
  responseTime?: number;
  /** Error message if check failed */
  error?: string;
}

export interface SyncState {
  /** Whether sync is running */
  running: boolean;
  /** Sync start time */
  startedAt?: Date;
  /** Penpot status */
  penpotStatus: PenpotStatus;
  /** Number of syncs performed */
  syncCount: number;
  /** Last sync time */
  lastSync?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Penpot Health Checker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if Penpot is running and accessible.
 */
export async function checkPenpotHealth(
  host: string,
  port: number,
  timeout: number
): Promise<PenpotStatus> {
  const url = `http://${host}:${port}`;
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    return {
      running: response.ok,
      url,
      lastCheck: new Date(),
      responseTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      running: false,
      url,
      lastCheck: new Date(),
      responseTime: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Lifecycle Manager
// ─────────────────────────────────────────────────────────────────────────────

export class SyncLifecycleManager extends EventEmitter {
  private options: Required<SyncLifecycleOptions>;
  private state: SyncState;
  private healthCheckTimer?: NodeJS.Timeout;
  private isMonitoring = false;

  constructor(options: SyncLifecycleOptions = {}) {
    super();

    this.options = {
      penpotHost: 'localhost',
      penpotPort: 3449,
      healthCheckInterval: 5000,
      connectionTimeout: 5000,
      autoStart: true,
      autoStop: true,
      onSyncStart: () => {},
      onSyncStop: () => {},
      onPenpotStatusChange: () => {},
      ...options,
    };

    this.state = {
      running: false,
      penpotStatus: {
        running: false,
        url: `http://${this.options.penpotHost}:${this.options.penpotPort}`,
        lastCheck: new Date(),
      },
      syncCount: 0,
    };
  }

  /**
   * Start monitoring Penpot status.
   */
  startMonitoring(): void {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;

    // Initial health check
    this.checkHealth();

    // Set up periodic health checks
    this.healthCheckTimer = setInterval(
      () => this.checkHealth(),
      this.options.healthCheckInterval
    );

    logger.debug('[SyncLifecycle] Started monitoring', {
      host: this.options.penpotHost,
      port: this.options.penpotPort,
      interval: this.options.healthCheckInterval,
    });
  }

  /**
   * Stop monitoring Penpot status.
   */
  stopMonitoring(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }

    // Stop sync if running
    if (this.state.running && this.options.autoStop) {
      this.stopSync();
    }

    logger.debug('[SyncLifecycle] Stopped monitoring');
  }

  /**
   * Check Penpot health and manage sync lifecycle.
   */
  private async checkHealth(): Promise<void> {
    const status = await checkPenpotHealth(
      this.options.penpotHost,
      this.options.penpotPort,
      this.options.connectionTimeout
    );

    const wasRunning = this.state.penpotStatus.running;
    this.state.penpotStatus = status;

    // Emit status change event
    if (wasRunning !== status.running) {
      this.emit('statusChange', status.running);
      this.options.onPenpotStatusChange(status.running);
    }

    // Auto-start sync when Penpot starts
    if (status.running && !this.state.running && this.options.autoStart) {
      await this.startSync();
    }

    // Auto-stop sync when Penpot stops
    if (!status.running && this.state.running && this.options.autoStop) {
      await this.stopSync();
    }
  }

  /**
   * Start sync.
   */
  async startSync(): Promise<void> {
    if (this.state.running) {
      return;
    }

    this.state.running = true;
    this.state.startedAt = new Date();
    this.state.syncCount++;

    this.emit('syncStart');
    this.options.onSyncStart();

    logger.info('[SyncLifecycle] Sync started', {
      syncCount: this.state.syncCount,
      penpotUrl: this.state.penpotStatus.url,
    });
  }

  /**
   * Stop sync.
   */
  async stopSync(): Promise<void> {
    if (!this.state.running) {
      return;
    }

    this.state.running = false;
    this.state.startedAt = undefined;
    this.state.lastSync = new Date();

    this.emit('syncStop');
    this.options.onSyncStop();

    logger.info('[SyncLifecycle] Sync stopped', {
      syncCount: this.state.syncCount,
    });
  }

  /**
   * Get current state.
   */
  getState(): SyncState {
    return { ...this.state };
  }

  /**
   * Check if Penpot is running.
   */
  isPenpotRunning(): boolean {
    return this.state.penpotStatus.running;
  }

  /**
   * Check if sync is running.
   */
  isSyncRunning(): boolean {
    return this.state.running;
  }

  /**
   * Force a health check.
   */
  async forceHealthCheck(): Promise<PenpotStatus> {
    await this.checkHealth();
    return this.state.penpotStatus;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a sync lifecycle manager.
 */
export function createSyncLifecycleManager(
  options: SyncLifecycleOptions = {}
): SyncLifecycleManager {
  return new SyncLifecycleManager(options);
}

/**
 * Create a sync lifecycle manager with default settings.
 */
export function createDefaultSyncLifecycle(): SyncLifecycleManager {
  return new SyncLifecycleManager({
    penpotHost: 'localhost',
    penpotPort: 3449,
    healthCheckInterval: 5000,
    autoStart: true,
    autoStop: true,
  });
}

export default SyncLifecycleManager;