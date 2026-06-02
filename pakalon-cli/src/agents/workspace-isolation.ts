/**
 * Workspace Isolation for Subagents
 *
 * Provides isolated workspaces for subagents to prevent conflicts:
 * - Git worktree-based isolation
 * - File system namespace isolation
 * - Conflict-free parallel execution
 * - Result merging and validation
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import logger from '@/utils/logger.js';
import { execAsync } from '@/utils/exec.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkspaceConfig {
  /** Base project directory */
  baseDir: string;
  /** Workspace name/identifier */
  name: string;
  /** Isolation strategy */
  strategy: 'worktree' | 'copy' | 'namespace';
  /** Whether to preserve git history */
  preserveGitHistory: boolean;
  /** Files/dirs to exclude from isolation */
  excludePatterns: string[];
}

export interface IsolatedWorkspace {
  /** Unique workspace ID */
  id: string;
  /** Workspace root directory */
  rootDir: string;
  /** Original project directory */
  baseDir: string;
  /** Isolation strategy used */
  strategy: string;
  /** Whether workspace is active */
  active: boolean;
  /** Creation timestamp */
  createdAt: number;
  /** Cleanup function */
  cleanup: () => Promise<void>;
}

export interface WorkspaceResult<T> {
  /** Whether operation succeeded */
  success: boolean;
  /** Result data */
  data?: T;
  /** Error message if failed */
  error?: string;
  /** Files modified in workspace */
  modifiedFiles: string[];
  /** Workspace ID */
  workspaceId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Manager
// ─────────────────────────────────────────────────────────────────────────────

export class WorkspaceIsolationManager {
  private workspaces: Map<string, IsolatedWorkspace> = new Map();
  private workspaceCounter = 0;

  /**
   * Create an isolated workspace for a subagent
   */
  async createWorkspace(config: WorkspaceConfig): Promise<IsolatedWorkspace> {
    const workspaceId = `ws_${Date.now()}_${++this.workspaceCounter}`;
    const workspaceName = `${config.name}_${workspaceId}`;

    let workspaceDir: string;
    let cleanupFn: () => Promise<void>;

    switch (config.strategy) {
      case 'worktree':
        const worktreeResult = await this.createWorktree(config.baseDir, workspaceName);
        workspaceDir = worktreeResult.path;
        cleanupFn = worktreeResult.cleanup;
        break;

      case 'copy':
        const copyResult = await this.createCopy(config.baseDir, workspaceName, config.excludePatterns);
        workspaceDir = copyResult.path;
        cleanupFn = copyResult.cleanup;
        break;

      case 'namespace':
        workspaceDir = path.join(config.baseDir, '.workspaces', workspaceName);
        await fs.mkdir(workspaceDir, { recursive: true });
        cleanupFn = () => fs.rm(workspaceDir, { recursive: true, force: true });
        break;

      default:
        throw new Error(`Unknown isolation strategy: ${config.strategy}`);
    }

    const workspace: IsolatedWorkspace = {
      id: workspaceId,
      rootDir: workspaceDir,
      baseDir: config.baseDir,
      strategy: config.strategy,
      active: true,
      createdAt: Date.now(),
      cleanup: cleanupFn,
    };

    this.workspaces.set(workspaceId, workspace);
    logger.info(`[WorkspaceIsolation] Created workspace ${workspaceId} at ${workspaceDir}`);

    return workspace;
  }

  /**
   * Create a git worktree
   */
  private async createWorktree(
    baseDir: string,
    name: string
  ): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const worktreeDir = path.join(baseDir, '.worktrees', name);
    await fs.mkdir(path.dirname(worktreeDir), { recursive: true });

    // Create worktree from current HEAD
    await execAsync(`git worktree add "${worktreeDir}" HEAD`, { cwd: baseDir });

    const cleanup = async () => {
      try {
        await execAsync(`git worktree remove "${worktreeDir}" --force`, { cwd: baseDir });
        logger.info(`[WorkspaceIsolation] Removed worktree ${worktreeDir}`);
      } catch (error) {
        logger.warn(`[WorkspaceIsolation] Failed to remove worktree: ${error}`);
      }
    };

    return { path: worktreeDir, cleanup };
  }

  /**
   * Create a copy-based workspace
   */
  private async createCopy(
    baseDir: string,
    name: string,
    excludePatterns: string[]
  ): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const copyDir = path.join(baseDir, '.workspaces', name);
    await fs.mkdir(copyDir, { recursive: true });

    // Copy project files excluding patterns
    const excludeArgs = excludePatterns
      .map(p => `--exclude="${p}"`)
      .join(' ');

    await execAsync(
      `rsync -a ${excludeArgs} "${baseDir}/" "${copyDir}/"`,
      { cwd: baseDir }
    );

    const cleanup = async () => {
      try {
        await fs.rm(copyDir, { recursive: true, force: true });
        logger.info(`[WorkspaceIsolation] Removed copy workspace ${copyDir}`);
      } catch (error) {
        logger.warn(`[WorkspaceIsolation] Failed to remove copy workspace: ${error}`);
      }
    };

    return { path: copyDir, cleanup };
  }

  /**
   * Get workspace by ID
   */
  getWorkspace(id: string): IsolatedWorkspace | undefined {
    return this.workspaces.get(id);
  }

  /**
   * Get all active workspaces
   */
  getActiveWorkspaces(): IsolatedWorkspace[] {
    return Array.from(this.workspaces.values()).filter(ws => ws.active);
  }

  /**
   * Mark workspace as completed
   */
  async completeWorkspace(id: string): Promise<void> {
    const workspace = this.workspaces.get(id);
    if (workspace) {
      workspace.active = false;
      logger.info(`[WorkspaceIsolation] Workspace ${id} marked as completed`);
    }
  }

  /**
   * Cleanup workspace
   */
  async cleanupWorkspace(id: string): Promise<void> {
    const workspace = this.workspaces.get(id);
    if (workspace) {
      await workspace.cleanup();
      workspace.active = false;
      this.workspaces.delete(id);
      logger.info(`[WorkspaceIsolation] Cleaned up workspace ${id}`);
    }
  }

  /**
   * Cleanup all workspaces
   */
  async cleanupAll(): Promise<void> {
    for (const [id, workspace] of this.workspaces) {
      try {
        await workspace.cleanup();
        logger.info(`[WorkspaceIsolation] Cleaned up workspace ${id}`);
      } catch (error) {
        logger.warn(`[WorkspaceIsolation] Failed to cleanup workspace ${id}: ${error}`);
      }
    }
    this.workspaces.clear();
  }

  /**
   * Get workspace file path (handles namespace isolation)
   */
  getWorkspacePath(workspaceId: string, relativePath: string): string {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    if (workspace.strategy === 'namespace') {
      return path.join(workspace.rootDir, relativePath);
    }

    // For worktree and copy strategies, map to workspace root
    return path.join(workspace.rootDir, relativePath);
  }

  /**
   * Read file from workspace
   */
  async readFile(workspaceId: string, relativePath: string): Promise<string> {
    const filePath = this.getWorkspacePath(workspaceId, relativePath);
    return await fs.readFile(filePath, 'utf-8');
  }

  /**
   * Write file to workspace
   */
  async writeFile(workspaceId: string, relativePath: string, content: string): Promise<void> {
    const filePath = this.getWorkspacePath(workspaceId, relativePath);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Get modified files in workspace
   */
  async getModifiedFiles(workspaceId: string): Promise<string[]> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return [];

    if (workspace.strategy === 'worktree') {
      try {
        const { stdout } = await execAsync('git diff --name-only', { cwd: workspace.rootDir });
        return stdout.split('\n').filter(f => f.trim());
      } catch {
        return [];
      }
    }

    // For copy/namespace strategies, track via metadata
    return [];
  }

  /**
   * Merge workspace changes back to base
   */
  async mergeWorkspace(workspaceId: string): Promise<boolean> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return false;

    if (workspace.strategy === 'worktree') {
      try {
        await execAsync(`git merge --no-ff ${workspaceId}`, { cwd: workspace.baseDir });
        logger.info(`[WorkspaceIsolation] Merged workspace ${workspaceId}`);
        return true;
      } catch (error) {
        logger.error(`[WorkspaceIsolation] Merge failed: ${error}`);
        return false;
      }
    }

    // For copy/namespace, copy files back
    try {
      const modifiedFiles = await this.getModifiedFiles(workspaceId);
      for (const file of modifiedFiles) {
        const srcPath = path.join(workspace.rootDir, file);
        const destPath = path.join(workspace.baseDir, file);
        await fs.copyFile(srcPath, destPath);
      }
      logger.info(`[WorkspaceIsolation] Copied ${modifiedFiles.length} files from workspace ${workspaceId}`);
      return true;
    } catch (error) {
      logger.error(`[WorkspaceIsolation] Copy back failed: ${error}`);
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Instance
// ─────────────────────────────────────────────────────────────────────────────

export const workspaceIsolationManager = new WorkspaceIsolationManager();

// ─────────────────────────────────────────────────────────────────────────────
// Schema Validation for Subagent Results
// ─────────────────────────────────────────────────────────────────────────────

export interface SubagentResultSchema {
  /** Required fields */
  required: string[];
  /** Optional fields */
  optional?: string[];
  /** Field types */
  types?: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object'>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate subagent result against schema
 */
export function validateSubagentResult(
  result: unknown,
  schema: SubagentResultSchema
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof result !== 'object' || result === null) {
    return { valid: false, errors: ['Result must be an object'], warnings: [] };
  }

  const obj = result as Record<string, unknown>;

  // Check required fields
  for (const field of schema.required) {
    if (!(field in obj)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Check types
  if (schema.types) {
    for (const [field, expectedType] of Object.entries(schema.types)) {
      if (field in obj) {
        const value = obj[field];
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== expectedType) {
          errors.push(`Field ${field} has wrong type: expected ${expectedType}, got ${actualType}`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an isolated workspace for a subagent
 */
export async function createIsolatedWorkspace(
  config: WorkspaceConfig
): Promise<IsolatedWorkspace> {
  return workspaceIsolationManager.createWorkspace(config);
}

/**
 * Cleanup all workspaces
 */
export async function cleanupAllWorkspaces(): Promise<void> {
  return workspaceIsolationManager.cleanupAll();
}

/**
 * Validate subagent result
 */
export function validateResult(
  result: unknown,
  schema: SubagentResultSchema
): ValidationResult {
  return validateSubagentResult(result, schema);
}
