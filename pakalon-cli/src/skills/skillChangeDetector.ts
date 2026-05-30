/**
 * Skill Change Detector
 *
 * Monitors skill directories for file changes and notifies callbacks
 * when skills are created, modified, or deleted.
 */

import * as fs from 'fs';
import * as path from 'path';
import logger from '@/utils/logger.js';

/**
 * Skill change event types.
 */
export type SkillChangeEventType = 'created' | 'modified' | 'deleted';

/**
 * Skill change event.
 */
export interface SkillChangeEvent {
  type: SkillChangeEventType;
  skillName: string;
  path: string;
  timestamp: number;
}

/**
 * Monitors skill directories for changes.
 */
export class SkillChangeDetector {
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private changes: SkillChangeEvent[] = [];
  private callbacks: Array<(event: SkillChangeEvent) => void> = [];
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly debounceMs: number;

  constructor(options?: { debounceMs?: number }) {
    this.debounceMs = options?.debounceMs ?? 300;
  }

  /**
   * Start watching skill directories.
   */
  watch(dirs: string[]): void {
    for (const dir of dirs) {
      this.watchDir(dir);
    }
  }

  /**
   * Stop all watchers.
   */
  stop(): void {
    for (const [dir, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();

    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Register a callback for skill changes.
   */
  onSkillChanged(callback: (event: SkillChangeEvent) => void): void {
    this.callbacks.push(callback);
  }

  /**
   * Get all recorded changes.
   */
  getChanges(): SkillChangeEvent[] {
    return [...this.changes];
  }

  /**
   * Clear recorded changes.
   */
  clearChanges(): void {
    this.changes = [];
  }

  // ── Internal helpers ──

  private watchDir(dir: string): void {
    if (this.watchers.has(dir)) return;

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const watcher = fs.watch(dir, { recursive: false }, (eventType, filename) => {
        if (!filename) return;

        // Only watch skill files
        if (!filename.endsWith('.md') && !filename.endsWith('.yaml') && !filename.endsWith('.yml')) {
          return;
        }

        this.handleDebouncedChange(dir, filename);
      });

      this.watchers.set(dir, watcher);
      logger.debug('[SkillChangeDetector] Watching', { dir });
    } catch (err) {
      logger.warn('[SkillChangeDetector] Failed to watch', { dir, error: String(err) });
    }
  }

  private handleDebouncedChange(dir: string, filename: string): void {
    const key = `${dir}:${filename}`;

    // Clear existing debounce timer
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.processChange(dir, filename);
      this.debounceTimers.delete(key);
    }, this.debounceMs);

    this.debounceTimers.set(key, timer);
  }

  private processChange(dir: string, filename: string): void {
    const filePath = path.join(dir, filename);
    const skillName = path.basename(filename, path.extname(filename));
    const exists = fs.existsSync(filePath);

    const type: SkillChangeEventType = exists ? 'modified' : 'deleted';

    // Check if file was just created
    if (exists) {
      try {
        const stat = fs.statSync(filePath);
        // If created within last second, it's a creation
        if (Date.now() - stat.birthtimeMs < 1000) {
          this.emitChange('created', skillName, filePath);
          return;
        }
      } catch {
        // Ignore stat errors
      }
    }

    this.emitChange(type, skillName, filePath);
  }

  private emitChange(type: SkillChangeEventType, skillName: string, filePath: string): void {
    const event: SkillChangeEvent = {
      type,
      skillName,
      path: filePath,
      timestamp: Date.now(),
    };

    this.changes.push(event);

    // Notify callbacks
    for (const callback of this.callbacks) {
      try {
        callback(event);
      } catch (err) {
        logger.warn('[SkillChangeDetector] Callback error', { error: String(err) });
      }
    }

    logger.info('[SkillChangeDetector] Change detected', { type, skillName });
  }
}

// Singleton instance
let _instance: SkillChangeDetector | null = null;

/**
 * Get the global skill change detector.
 */
export function getSkillChangeDetector(): SkillChangeDetector {
  if (!_instance) {
    _instance = new SkillChangeDetector();
  }
  return _instance;
}
