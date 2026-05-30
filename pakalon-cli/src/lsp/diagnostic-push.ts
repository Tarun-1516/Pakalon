/**
 * Real-time LSP Diagnostics Push
 * Actively pushes diagnostics to the UI instead of passive polling
 */

import { EventEmitter } from 'events';
import { getLSPDiagnosticRegistry, type DiagnosticSnapshot, type Diagnostic } from './LSPDiagnosticRegistry.js';

export interface DiagnosticPushEvent {
  type: 'diagnostic' | 'clear' | 'batch';
  filePath: string;
  serverName: string;
  diagnostics: Diagnostic[];
  timestamp: number;
}

export interface DiagnosticPushOptions {
  workspaceDir: string;
  pollIntervalMs?: number;
  batchSize?: number;
  onDiagnostic?: (event: DiagnosticPushEvent) => void;
}

class DiagnosticPushManager extends EventEmitter {
  private options: DiagnosticPushOptions;
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastPollTime = 0;

  constructor(options: DiagnosticPushOptions) {
    super();
    this.options = {
      pollIntervalMs: 500,
      batchSize: 50,
      ...options,
    };
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastPollTime = Date.now();
    this.poll();
  }

  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.isRunning = false;
  }

  private poll(): void {
    if (!this.isRunning) return;

    const registry = getLSPDiagnosticRegistry(this.options.workspaceDir);
    const snapshots = registry.consumePending();

    if (snapshots.length > 0) {
      this.processSnapshots(snapshots);
    }

    this.pollTimer = setTimeout(() => {
      this.lastPollTime = Date.now();
      this.poll();
    }, this.options.pollIntervalMs!);
  }

  private processSnapshots(snapshots: DiagnosticSnapshot[]): void {
    const batch: DiagnosticPushEvent[] = [];

    for (const snapshot of snapshots) {
      const event: DiagnosticPushEvent = {
        type: 'diagnostic',
        filePath: snapshot.filePath,
        serverName: snapshot.serverName,
        diagnostics: snapshot.diagnostics,
        timestamp: Date.now(),
      };

      batch.push(event);

      // Emit individual event
      this.emit('diagnostic', event);
      this.options.onDiagnostic?.(event);
    }

    // Emit batch event
    if (batch.length > 1) {
      this.emit('batch', batch);
    }
  }

  pushDiagnostics(filePath: string, serverName: string, diagnostics: Diagnostic[]): void {
    const event: DiagnosticPushEvent = {
      type: 'diagnostic',
      filePath,
      serverName,
      diagnostics,
      timestamp: Date.now(),
    };

    this.emit('diagnostic', event);
    this.options.onDiagnostic?.(event);
  }

  clearDiagnostics(filePath: string, serverName: string): void {
    const event: DiagnosticPushEvent = {
      type: 'clear',
      filePath,
      serverName,
      diagnostics: [],
      timestamp: Date.now(),
    };

    this.emit('clear', event);
    this.options.onDiagnostic?.(event);
  }

  getStats(): { isRunning: boolean; lastPollTime: number; pendingCount: number } {
    const registry = getLSPDiagnosticRegistry(this.options.workspaceDir);
    return {
      isRunning: this.isRunning,
      lastPollTime: this.lastPollTime,
      pendingCount: registry.getPendingCount(),
    };
  }
}

const managers = new Map<string, DiagnosticPushManager>();

export function getDiagnosticPushManager(workspaceDir: string): DiagnosticPushManager {
  let manager = managers.get(workspaceDir);
  if (!manager) {
    manager = new DiagnosticPushManager({ workspaceDir });
    managers.set(workspaceDir, manager);
  }
  return manager;
}

export function startDiagnosticPush(workspaceDir: string): void {
  getDiagnosticPushManager(workspaceDir).start();
}

export function stopDiagnosticPush(workspaceDir: string): void {
  getDiagnosticPushManager(workspaceDir).stop();
}

export function pushDiagnostics(
  workspaceDir: string,
  filePath: string,
  serverName: string,
  diagnostics: Diagnostic[],
): void {
  getDiagnosticPushManager(workspaceDir).pushDiagnostics(filePath, serverName, diagnostics);
}

export function clearDiagnostics(workspaceDir: string, filePath: string, serverName: string): void {
  getDiagnosticPushManager(workspaceDir).clearDiagnostics(filePath, serverName);
}

export { DiagnosticPushManager };
