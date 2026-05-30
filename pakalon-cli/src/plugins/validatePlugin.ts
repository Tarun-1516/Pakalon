/**
 * Plugin Validation
 *
 * Validates plugin structure, dependencies, and safety.
 */

import * as fs from 'fs';
import * as path from 'path';
import logger from '@/utils/logger.js';

/**
 * Validation result.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a plugin at the given path.
 */
export function validatePlugin(pluginPath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if path exists
  if (!fs.existsSync(pluginPath)) {
    return { valid: false, errors: ['Plugin path does not exist'], warnings: [] };
  }

  const stat = fs.statSync(pluginPath);

  // If it's a file, validate as single-file plugin
  if (stat.isFile()) {
    return validateSingleFilePlugin(pluginPath);
  }

  // If it's a directory, validate as directory plugin
  if (stat.isDirectory()) {
    return validateDirectoryPlugin(pluginPath);
  }

  return { valid: false, errors: ['Path is neither a file nor directory'], warnings: [] };
}

/**
 * Validate a plugin manifest (package.json).
 */
export function validatePluginManifest(manifest: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest is not an object'], warnings: [] };
  }

  const m = manifest as Record<string, unknown>;

  // Required fields
  if (!m.name || typeof m.name !== 'string') {
    errors.push('Missing or invalid "name" field');
  }

  if (!m.version || typeof m.version !== 'string') {
    errors.push('Missing or invalid "version" field');
  }

  // Validate name format
  if (typeof m.name === 'string') {
    if (m.name.length < 3) {
      errors.push('Plugin name must be at least 3 characters');
    }
    if (!/^[a-z0-9@\-_/]+$/.test(m.name)) {
      warnings.push('Plugin name contains unusual characters');
    }
  }

  // Validate version format
  if (typeof m.version === 'string') {
    if (!/^\d+\.\d+\.\d+/.test(m.version)) {
      warnings.push('Version does not follow semver format');
    }
  }

  // Check for dangerous permissions
  if (m.pakalon && typeof m.pakalon === 'object') {
    const pakalon = m.pakalon as Record<string, unknown>;
    if (pakalon.permissions && Array.isArray(pakalon.permissions)) {
      const perms = pakalon.permissions as string[];
      if (perms.includes('filesystem:write') || perms.includes('network:all')) {
        warnings.push('Plugin requests broad permissions');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ── Internal helpers ──

function validateSingleFilePlugin(filePath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const ext = path.extname(filePath);
  if (!['.js', '.ts', '.mjs'].includes(ext)) {
    errors.push(`Unsupported file extension: ${ext}`);
  }

  // Check file size
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 1024 * 1024) {
      warnings.push('Plugin file is unusually large (>1MB)');
    }
    if (stat.size === 0) {
      errors.push('Plugin file is empty');
    }
  } catch (err) {
    errors.push(`Failed to read plugin file: ${err}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateDirectoryPlugin(dirPath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for package.json
  const packageJsonPath = path.join(dirPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const manifestResult = validatePluginManifest(packageJson);
      errors.push(...manifestResult.errors);
      warnings.push(...manifestResult.warnings);
    } catch (err) {
      errors.push(`Failed to parse package.json: ${err}`);
    }
  } else {
    warnings.push('No package.json found');
  }

  // Check for entry file
  const entryCandidates = ['index.js', 'index.ts', 'main.js', 'main.ts', 'dist/index.js'];
  const hasEntry = entryCandidates.some((candidate) =>
    fs.existsSync(path.join(dirPath, candidate)),
  );

  if (!hasEntry) {
    errors.push('No entry file found (index.js, index.ts, main.js, etc.)');
  }

  return { valid: errors.length === 0, errors, warnings };
}
