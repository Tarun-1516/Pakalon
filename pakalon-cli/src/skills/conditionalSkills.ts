/**
 * Conditional Skills
 *
 * Gitignore-style pattern matching for skill activation. Skills are
 * only activated when the current project matches specific patterns.
 *
 * Strategy:
 * 1. Define skill conditions using gitignore-style patterns
 * 2. Match against project files and directories
 * 3. Activate skills only when conditions match
 * 4. Support negative patterns (exclude)
 */

import * as fs from 'fs';
import * as path from 'path';
import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ConditionalSkillOptions {
  /** Project root directory */
  projectDir: string;
  /** Whether to check file existence (default: true) */
  checkFileExistence?: boolean;
  /** Maximum depth for pattern matching (default: 5) */
  maxDepth?: number;
}

export interface SkillCondition {
  /** Skill name */
  skillName: string;
  /** Conditions to activate skill */
  conditions: {
    /** Files that must exist (gitignore-style patterns) */
    files?: string[];
    /** Directories that must exist */
    directories?: string[];
    /** Files that must NOT exist (negative patterns) */
    excludeFiles?: string[];
    /** Directories that must NOT exist */
    excludeDirectories?: string[];
    /** Package.json dependencies */
    dependencies?: string[];
    /** File content patterns (regex) */
    contentPatterns?: Array<{
      file: string;
      pattern: string;
    }>;
  };
}

export interface SkillActivationResult {
  /** Skill name */
  skillName: string;
  /** Whether skill is activated */
  activated: boolean;
  /** Conditions that matched */
  matchedConditions: string[];
  /** Conditions that didn't match */
  unmatchedConditions: string[];
  /** Error message if check failed */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a file path matches a gitignore-style pattern.
 */
function matchesPattern(pattern: string, filePath: string): boolean {
  // Convert gitignore pattern to regex
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    .replace(/\/$/, '/.*')
    .replace(/^\//, '^');

  const regex = new RegExp(regexPattern, 'i');
  return regex.test(filePath);
}

/**
 * Check if a path matches any of the patterns.
 */
function matchesAnyPattern(patterns: string[], filePath: string): boolean {
  return patterns.some(pattern => matchesPattern(pattern, filePath));
}

// ─────────────────────────────────────────────────────────────────────────────
// Condition Checker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a skill condition is met.
 */
export async function checkSkillCondition(
  condition: SkillCondition,
  options: ConditionalSkillOptions
): Promise<SkillActivationResult> {
  const {
    projectDir,
    checkFileExistence = true,
  } = options;

  const matchedConditions: string[] = [];
  const unmatchedConditions: string[] = [];

  // Check files
  if (condition.conditions.files) {
    for (const pattern of condition.conditions.files) {
      if (checkFileExistence) {
        // Check if any file matching pattern exists
        const exists = await fileExists(projectDir, pattern);
        if (exists) {
          matchedConditions.push(`file:${pattern}`);
        } else {
          unmatchedConditions.push(`file:${pattern}`);
        }
      } else {
        // Just check pattern validity
        matchedConditions.push(`file:${pattern}`);
      }
    }
  }

  // Check directories
  if (condition.conditions.directories) {
    for (const pattern of condition.conditions.directories) {
      if (checkFileExistence) {
        const exists = await directoryExists(projectDir, pattern);
        if (exists) {
          matchedConditions.push(`dir:${pattern}`);
        } else {
          unmatchedConditions.push(`dir:${pattern}`);
        }
      } else {
        matchedConditions.push(`dir:${pattern}`);
      }
    }
  }

  // Check exclude files
  if (condition.conditions.excludeFiles) {
    for (const pattern of condition.conditions.excludeFiles) {
      if (checkFileExistence) {
        const exists = await fileExists(projectDir, pattern);
        if (!exists) {
          matchedConditions.push(`exclude_file:${pattern}`);
        } else {
          unmatchedConditions.push(`exclude_file:${pattern}`);
        }
      } else {
        matchedConditions.push(`exclude_file:${pattern}`);
      }
    }
  }

  // Check exclude directories
  if (condition.conditions.excludeDirectories) {
    for (const pattern of condition.conditions.excludeDirectories) {
      if (checkFileExistence) {
        const exists = await directoryExists(projectDir, pattern);
        if (!exists) {
          matchedConditions.push(`exclude_dir:${pattern}`);
        } else {
          unmatchedConditions.push(`exclude_dir:${pattern}`);
        }
      } else {
        matchedConditions.push(`exclude_dir:${pattern}`);
      }
    }
  }

  // Check dependencies
  if (condition.conditions.dependencies) {
    const packageJson = await readPackageJson(projectDir);
    if (packageJson) {
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      for (const dep of condition.conditions.dependencies) {
        if (allDeps[dep]) {
          matchedConditions.push(`dependency:${dep}`);
        } else {
          unmatchedConditions.push(`dependency:${dep}`);
        }
      }
    } else {
      unmatchedConditions.push('dependency:package.json not found');
    }
  }

  // Check content patterns
  if (condition.conditions.contentPatterns) {
    for (const { file, pattern } of condition.conditions.contentPatterns) {
      const content = await readFileContent(projectDir, file);
      if (content) {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(content)) {
          matchedConditions.push(`content:${file}:${pattern}`);
        } else {
          unmatchedConditions.push(`content:${file}:${pattern}`);
        }
      } else {
        unmatchedConditions.push(`content:${file}:file not found`);
      }
    }
  }

  // Determine if skill should be activated
  // All conditions must match (AND logic)
  const activated = unmatchedConditions.length === 0;

  return {
    skillName: condition.skillName,
    activated,
    matchedConditions,
    unmatchedConditions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// File System Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fileExists(projectDir: string, pattern: string): Promise<boolean> {
  // Check common file locations
  const possiblePaths = [
    path.join(projectDir, pattern),
    path.join(projectDir, 'src', pattern),
    path.join(projectDir, 'lib', pattern),
  ];

  for (const p of possiblePaths) {
    try {
      const stats = await fs.promises.stat(p);
      if (stats.isFile()) {
        return true;
      }
    } catch {
      // File doesn't exist
    }
  }

  return false;
}

async function directoryExists(projectDir: string, pattern: string): Promise<boolean> {
  const possiblePaths = [
    path.join(projectDir, pattern),
    path.join(projectDir, 'src', pattern),
    path.join(projectDir, 'lib', pattern),
  ];

  for (const p of possiblePaths) {
    try {
      const stats = await fs.promises.stat(p);
      if (stats.isDirectory()) {
        return true;
      }
    } catch {
      // Directory doesn't exist
    }
  }

  return false;
}

async function readPackageJson(projectDir: string): Promise<{
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} | null> {
  try {
    const content = await fs.promises.readFile(
      path.join(projectDir, 'package.json'),
      'utf-8'
    );
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function readFileContent(
  projectDir: string,
  filePath: string
): Promise<string | null> {
  try {
    const fullPath = path.join(projectDir, filePath);
    return await fs.promises.readFile(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conditional Skills Manager
// ─────────────────────────────────────────────────────────────────────────────

export class ConditionalSkillsManager {
  private conditions: SkillCondition[] = [];
  private options: ConditionalSkillOptions;

  constructor(options: ConditionalSkillOptions) {
    this.options = options;
  }

  /**
   * Register a skill condition.
   */
  register(condition: SkillCondition): void {
    this.conditions.push(condition);
    logger.debug('[ConditionalSkills] Registered condition', {
      skillName: condition.skillName,
      conditionsCount: Object.keys(condition.conditions).length,
    });
  }

  /**
   * Check all skill conditions and return activated skills.
   */
  async checkAll(): Promise<SkillActivationResult[]> {
    const results: SkillActivationResult[] = [];

    for (const condition of this.conditions) {
      const result = await checkSkillCondition(condition, this.options);
      results.push(result);
    }

    return results;
  }

  /**
   * Get activated skills.
   */
  async getActivatedSkills(): Promise<string[]> {
    const results = await this.checkAll();
    return results
      .filter(r => r.activated)
      .map(r => r.skillName);
  }

  /**
   * Clear all conditions.
   */
  clear(): void {
    this.conditions = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a conditional skills manager.
 */
export function createConditionalSkillsManager(
  options: ConditionalSkillOptions
): ConditionalSkillsManager {
  return new ConditionalSkillsManager(options);
}

/**
 * Create a skill condition for React projects.
 */
export function createReactCondition(skillName: string): SkillCondition {
  return {
    skillName,
    conditions: {
      files: ['package.json'],
      dependencies: ['react'],
    },
  };
}

/**
 * Create a skill condition for Node.js projects.
 */
export function createNodeCondition(skillName: string): SkillCondition {
  return {
    skillName,
    conditions: {
      files: ['package.json'],
    },
  };
}

/**
 * Create a skill condition for Python projects.
 */
export function createPythonCondition(skillName: string): SkillCondition {
  return {
    skillName,
    conditions: {
      files: ['requirements.txt', 'pyproject.toml', 'setup.py'],
    },
  };
}

export default ConditionalSkillsManager;