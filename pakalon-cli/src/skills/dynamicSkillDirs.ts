/**
 * Dynamic Skill Directories
 *
 * Allows adding skill directories at runtime. This enables plugins
 * and extensions to register their own skill directories.
 *
 * Strategy:
 * 1. Maintain a list of skill directories
 * 2. Watch directories for changes
 * 3. Auto-discover skills in new directories
 * 4. Support hot-reloading of skills
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DynamicSkillDirOptions {
  /** Whether to watch for changes (default: true) */
  watch?: boolean;
  /** Watch interval in ms (default: 5000) */
  watchInterval?: number;
  /** Skill file name (default: SKILL.md) */
  skillFileName?: string;
  /** Callback when skills change */
  onSkillsChange?: (directory: string, skills: string[]) => void;
}

export interface SkillDirectory {
  /** Directory path */
  path: string;
  /** Whether directory exists */
  exists: boolean;
  /** Skills found in directory */
  skills: string[];
  /** Last scan time */
  lastScan: Date;
  /** Watcher (if watching) */
  watcher?: fs.FSWatcher;
}

export interface SkillDirEvent {
  type: 'added' | 'removed' | 'updated';
  directory: string;
  skill?: string;
  timestamp: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Skill Directory Manager
// ─────────────────────────────────────────────────────────────────────────────

export class DynamicSkillDirManager extends EventEmitter {
  private directories: Map<string, SkillDirectory> = new Map();
  private options: Required<DynamicSkillDirOptions>;
  private scanInterval?: NodeJS.Timeout;

  constructor(options: DynamicSkillDirOptions = {}) {
    super();

    this.options = {
      watch: true,
      watchInterval: 5000,
      skillFileName: 'SKILL.md',
      onSkillsChange: () => {},
      ...options,
    };
  }

  /**
   * Add a skill directory.
   */
  async addDirectory(dirPath: string): Promise<void> {
    const absolutePath = path.resolve(dirPath);

    if (this.directories.has(absolutePath)) {
      logger.debug('[DynamicSkillDirs] Directory already registered', {
        path: absolutePath,
      });
      return;
    }

    // Check if directory exists
    let exists = false;
    try {
      await fs.promises.access(absolutePath);
      exists = true;
    } catch {
      // Directory doesn't exist
    }

    // Scan for skills
    const skills = exists ? await this.scanDirectory(absolutePath) : [];

    // Create directory entry
    const dirEntry: SkillDirectory = {
      path: absolutePath,
      exists,
      skills,
      lastScan: new Date(),
    };

    // Set up watcher if enabled
    if (this.options.watch && exists) {
      try {
        dirEntry.watcher = fs.watch(
          absolutePath,
          { recursive: true },
          () => this.onDirectoryChange(absolutePath)
        );
      } catch (error) {
        logger.warn('[DynamicSkillDirs] Failed to watch directory', {
          path: absolutePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.directories.set(absolutePath, dirEntry);

    logger.debug('[DynamicSkillDirs] Added directory', {
      path: absolutePath,
      exists,
      skillCount: skills.length,
    });

    this.emit('directoryAdded', absolutePath);
  }

  /**
   * Remove a skill directory.
   */
  removeDirectory(dirPath: string): boolean {
    const absolutePath = path.resolve(dirPath);
    const dirEntry = this.directories.get(absolutePath);

    if (!dirEntry) {
      return false;
    }

    // Close watcher
    if (dirEntry.watcher) {
      dirEntry.watcher.close();
    }

    this.directories.delete(absolutePath);

    logger.debug('[DynamicSkillDirs] Removed directory', {
      path: absolutePath,
    });

    this.emit('directoryRemoved', absolutePath);
    return true;
  }

  /**
   * Get all skill directories.
   */
  getDirectories(): SkillDirectory[] {
    return Array.from(this.directories.values());
  }

  /**
   * Get all discovered skills.
   */
  getAllSkills(): Array<{ directory: string; skill: string }> {
    const skills: Array<{ directory: string; skill: string }> = [];

    for (const dir of this.directories.values()) {
      for (const skill of dir.skills) {
        skills.push({ directory: dir.path, skill });
      }
    }

    return skills;
  }

  /**
   * Scan a directory for skills.
   */
  private async scanDirectory(dirPath: string): Promise<string[]> {
    const skills: string[] = [];

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Check if directory contains a skill file
          const skillFile = path.join(dirPath, entry.name, this.options.skillFileName);
          try {
            await fs.promises.access(skillFile);
            skills.push(entry.name);
          } catch {
            // No skill file
          }
        } else if (entry.name === this.options.skillFileName) {
          // Directory itself is a skill
          skills.push(path.basename(dirPath));
        }
      }
    } catch (error) {
      logger.warn('[DynamicSkillDirs] Failed to scan directory', {
        path: dirPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return skills;
  }

  /**
   * Handle directory change event.
   */
  private async onDirectoryChange(dirPath: string): Promise<void> {
    const dirEntry = this.directories.get(dirPath);
    if (!dirEntry) return;

    const oldSkills = [...dirEntry.skills];
    const newSkills = await this.scanDirectory(dirPath);

    // Detect changes
    const added = newSkills.filter(s => !oldSkills.includes(s));
    const removed = oldSkills.filter(s => !newSkills.includes(s));

    if (added.length > 0 || removed.length > 0) {
      dirEntry.skills = newSkills;
      dirEntry.lastScan = new Date();

      // Emit events
      for (const skill of added) {
        this.emit('skillAdded', { directory: dirPath, skill });
      }
      for (const skill of removed) {
        this.emit('skillRemoved', { directory: dirPath, skill });
      }

      this.options.onSkillsChange(dirPath, newSkills);
    }
  }

  /**
   * Start watching all directories.
   */
  startWatching(): void {
    if (!this.options.watch) return;

    this.scanInterval = setInterval(async () => {
      for (const [dirPath, dirEntry] of this.directories) {
        if (dirEntry.exists) {
          await this.onDirectoryChange(dirPath);
        }
      }
    }, this.options.watchInterval);
  }

  /**
   * Stop watching all directories.
   */
  stopWatching(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }

    for (const dirEntry of this.directories.values()) {
      if (dirEntry.watcher) {
        dirEntry.watcher.close();
        dirEntry.watcher = undefined;
      }
    }
  }

  /**
   * Clear all directories and stop watching.
   */
  clear(): void {
    this.stopWatching();
    this.directories.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a dynamic skill directory manager.
 */
export function createDynamicSkillDirManager(
  options: DynamicSkillDirOptions = {}
): DynamicSkillDirManager {
  return new DynamicSkillDirManager(options);
}

/**
 * Add default skill directories.
 */
export async function addDefaultSkillDirectories(
  manager: DynamicSkillDirManager,
  projectDir: string
): Promise<void> {
  const defaultDirs = [
    path.join(projectDir, '.pakalon', 'skills'),
    path.join(projectDir, 'skills'),
    path.join(projectDir, '.agents', 'skills'),
  ];

  for (const dir of defaultDirs) {
    await manager.addDirectory(dir);
  }
}

export default DynamicSkillDirManager;