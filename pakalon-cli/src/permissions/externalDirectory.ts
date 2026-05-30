/**
 * External Directory Permissions
 * 
 * Handles permission checks for files outside the project directory.
 * Modeled after opencode's tool/external-directory.ts.
 */

import * as path from 'path';
import { evaluate, type PermissionRuleset } from './permissionRuleset.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ExternalDirectoryCheck {
  /** Whether the path is external */
  isExternal: boolean;
  /** The resolved path */
  resolvedPath: string;
  /** The directory to check */
  directory: string;
  /** Permission decision */
  decision: 'allow' | 'deny' | 'ask';
  /** Reason for decision */
  reason: string;
}

export interface ExternalDirectoryOptions {
  /** Bypass external directory checks */
  bypass?: boolean;
  /** Whether target is a directory (default: file) */
  kind?: 'file' | 'directory';
  /** Project root directory */
  projectRoot?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize path for cross-platform comparison
 */
function normalizePath(p: string): string {
  return path.normalize(p).toLowerCase();
}

/**
 * Check if a path is within the project directory
 */
export function isWithinProject(targetPath: string, projectRoot: string): boolean {
  const normalizedTarget = normalizePath(path.resolve(targetPath));
  const normalizedRoot = normalizePath(path.resolve(projectRoot));
  return normalizedTarget.startsWith(normalizedRoot);
}

/**
 * Assert that a target is within the project directory
 */
export function assertExternalDirectory(
  targetPath: string,
  options: ExternalDirectoryOptions = {},
): ExternalDirectoryCheck {
  const { bypass = false, kind = 'file', projectRoot = process.cwd() } = options;

  // Bypass check if requested
  if (bypass) {
    return {
      isExternal: false,
      resolvedPath: path.resolve(targetPath),
      directory: path.dirname(path.resolve(targetPath)),
      decision: 'allow',
      reason: 'Bypassed by configuration',
    };
  }

  const resolvedPath = path.resolve(targetPath);
  const directory = kind === 'directory' ? resolvedPath : path.dirname(resolvedPath);
  const isExternal = !isWithinProject(resolvedPath, projectRoot);

  if (!isExternal) {
    return {
      isExternal: false,
      resolvedPath,
      directory,
      decision: 'allow',
      reason: 'Path is within project directory',
    };
  }

  // Path is external - needs permission
  return {
    isExternal: true,
    resolvedPath,
    directory,
    decision: 'ask',
    reason: `Path ${resolvedPath} is outside project directory ${projectRoot}`,
  };
}

/**
 * Get the glob pattern for external directory permission
 */
export function getExternalDirectoryPattern(targetPath: string): string {
  const dir = path.dirname(targetPath);
  return path.join(dir, '*');
}

/**
 * Check external directory against rulesets
 */
export function checkExternalDirectory(
  targetPath: string,
  ruleset: PermissionRuleset,
  projectRoot: string = process.cwd(),
): ExternalDirectoryCheck {
  const check = assertExternalDirectory(targetPath, { projectRoot });

  if (!check.isExternal) {
    return check;
  }

  // Check against rulesets
  const pattern = getExternalDirectoryPattern(targetPath);
  const decision = evaluate('external_directory', pattern, ruleset);

  return {
    ...check,
    decision: decision.action,
    reason: decision.reason,
  };
}

export * as ExternalDirectory from './externalDirectory.js';
