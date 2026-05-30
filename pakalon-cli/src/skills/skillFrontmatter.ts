/**
 * Skill Frontmatter Parser
 *
 * Extracts allowed-tools, arguments, hooks, and other metadata from
 * skill definitions in SKILL.md files.
 *
 * Strategy:
 * 1. Parse YAML frontmatter from SKILL.md files
 * 2. Extract tool permissions, arguments, hooks
 * 3. Validate frontmatter structure
 * 4. Support defaults and inheritance
 */

import * as fs from 'fs';
import * as path from 'path';
import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillFrontmatter {
  /** Skill name */
  name?: string;
  /** Skill description */
  description?: string;
  /** Allowed tools */
  allowedTools?: string[];
  /** Denied tools */
  deniedTools?: string[];
  /** Skill arguments */
  arguments?: Record<string, SkillArgument>;
  /** Hooks to execute */
  hooks?: SkillHook[];
  /** Skill version */
  version?: string;
  /** Skill author */
  author?: string;
  /** Skill tags */
  tags?: string[];
  /** Skill dependencies */
  dependencies?: string[];
  /** Whether skill is enabled */
  enabled?: boolean;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

export interface SkillArgument {
  /** Argument type */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** Argument description */
  description?: string;
  /** Whether argument is required */
  required?: boolean;
  /** Default value */
  default?: unknown;
  /** Allowed values (for enum) */
  enum?: unknown[];
}

export interface SkillHook {
  /** Hook name */
  name: string;
  /** Hook event */
  event: 'pre' | 'post' | 'error';
  /** Hook command */
  command?: string;
  /** Hook script path */
  script?: string;
  /** Hook timeout in ms */
  timeout?: number;
}

export interface ParsedSkillFile {
  /** Skill directory path */
  directory: string;
  /** Skill file path */
  filePath: string;
  /** Parsed frontmatter */
  frontmatter: SkillFrontmatter;
  /** Skill content (after frontmatter) */
  content: string;
  /** Parse errors */
  errors: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from content.
 * Supports both YAML and JSON frontmatter.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  // Check for YAML frontmatter (---...---)
  const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

  if (yamlMatch) {
    const [, yamlContent, body] = yamlMatch;
    try {
      const frontmatter = parseYaml(yamlContent);
      return { frontmatter, body };
    } catch (error) {
      logger.warn('[SkillFrontmatter] Failed to parse YAML frontmatter', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Check for JSON frontmatter ({...})
  const jsonMatch = content.match(/^\{[\s\S]*\}\s*\n([\s\S]*)$/);

  if (jsonMatch) {
    const [, body] = jsonMatch;
    try {
      const frontmatter = JSON.parse(jsonMatch[0].slice(0, jsonMatch[0].indexOf('\n')));
      return { frontmatter, body };
    } catch (error) {
      logger.warn('[SkillFrontmatter] Failed to parse JSON frontmatter', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // No frontmatter found
  return { frontmatter: {}, body: content };
}

/**
 * Simple YAML parser (minimal implementation).
 */
function parseYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentValue: unknown = null;
  let isArray = false;
  let arrayItems: unknown[] = [];

  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Check for array item
    if (trimmed.startsWith('- ')) {
      if (isArray && currentKey) {
        const value = trimmed.slice(2).trim();
        arrayItems.push(parseYamlValue(value));
      }
      continue;
    }

    // Check for key: value
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      // Save previous key/value
      if (currentKey) {
        if (isArray) {
          result[currentKey] = arrayItems;
        } else {
          result[currentKey] = currentValue;
        }
      }

      currentKey = trimmed.slice(0, colonIndex).trim();
      const valuePart = trimmed.slice(colonIndex + 1).trim();

      if (valuePart === '' || valuePart === '|' || valuePart === '>') {
        // Multi-line or nested value
        isArray = false;
        currentValue = null;
        arrayItems = [];
      } else if (valuePart.startsWith('[')) {
        // Inline array
        try {
          currentValue = JSON.parse(valuePart);
        } catch {
          currentValue = valuePart;
        }
        isArray = false;
      } else {
        currentValue = parseYamlValue(valuePart);
        isArray = false;
      }
    }
  }

  // Save last key/value
  if (currentKey) {
    if (isArray) {
      result[currentKey] = arrayItems;
    } else {
      result[currentKey] = currentValue;
    }
  }

  return result;
}

/**
 * Parse a YAML value.
 */
function parseYamlValue(value: string): unknown {
  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Null
  if (value === 'null' || value === '~') return null;

  // Number
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value);

  // String (remove quotes)
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Array-like string
  if (value.startsWith('[') && value.endsWith(']')) {
    try {
      return JSON.parse(value);
    } catch {
      // Fall through
    }
  }

  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill File Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a SKILL.md file.
 */
export async function parseSkillFile(filePath: string): Promise<ParsedSkillFile> {
  const errors: string[] = [];

  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    // Validate and normalize frontmatter
    const normalizedFrontmatter = normalizeFrontmatter(frontmatter, errors);

    return {
      directory: path.dirname(filePath),
      filePath,
      frontmatter: normalizedFrontmatter,
      content: body,
      errors,
    };
  } catch (error) {
    return {
      directory: path.dirname(filePath),
      filePath,
      frontmatter: {},
      content: '',
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/**
 * Normalize frontmatter to standard structure.
 */
function normalizeFrontmatter(
  raw: Record<string, unknown>,
  errors: string[]
): SkillFrontmatter {
  const frontmatter: SkillFrontmatter = {};

  // Name
  if (typeof raw.name === 'string') {
    frontmatter.name = raw.name;
  }

  // Description
  if (typeof raw.description === 'string') {
    frontmatter.description = raw.description;
  }

  // Allowed tools
  if (Array.isArray(raw.allowedTools)) {
    frontmatter.allowedTools = raw.allowedTools.filter(
      (t): t is string => typeof t === 'string'
    );
  } else if (typeof raw.allowedTools === 'string') {
    frontmatter.allowedTools = [raw.allowedTools];
  }

  // Denied tools
  if (Array.isArray(raw.deniedTools)) {
    frontmatter.deniedTools = raw.deniedTools.filter(
      (t): t is string => typeof t === 'string'
    );
  } else if (typeof raw.deniedTools === 'string') {
    frontmatter.deniedTools = [raw.deniedTools];
  }

  // Arguments
  if (typeof raw.arguments === 'object' && raw.arguments !== null) {
    frontmatter.arguments = {};
    for (const [key, value] of Object.entries(raw.arguments)) {
      if (typeof value === 'object' && value !== null) {
        frontmatter.arguments[key] = normalizeArgument(value as Record<string, unknown>);
      }
    }
  }

  // Hooks
  if (Array.isArray(raw.hooks)) {
    frontmatter.hooks = raw.hooks
      .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
      .map(normalizeHook);
  }

  // Version
  if (typeof raw.version === 'string') {
    frontmatter.version = raw.version;
  }

  // Author
  if (typeof raw.author === 'string') {
    frontmatter.author = raw.author;
  }

  // Tags
  if (Array.isArray(raw.tags)) {
    frontmatter.tags = raw.tags.filter(
      (t): t is string => typeof t === 'string'
    );
  }

  // Dependencies
  if (Array.isArray(raw.dependencies)) {
    frontmatter.dependencies = raw.dependencies.filter(
      (d): d is string => typeof d === 'string'
    );
  }

  // Enabled
  if (typeof raw.enabled === 'boolean') {
    frontmatter.enabled = raw.enabled;
  } else {
    frontmatter.enabled = true;
  }

  // Metadata
  if (typeof raw.metadata === 'object' && raw.metadata !== null) {
    frontmatter.metadata = raw.metadata as Record<string, unknown>;
  }

  return frontmatter;
}

/**
 * Normalize an argument definition.
 */
function normalizeArgument(raw: Record<string, unknown>): SkillArgument {
  return {
    type: (['string', 'number', 'boolean', 'array', 'object'].includes(raw.type as string)
      ? raw.type
      : 'string') as SkillArgument['type'],
    description: typeof raw.description === 'string' ? raw.description : undefined,
    required: typeof raw.required === 'boolean' ? raw.required : false,
    default: raw.default,
    enum: Array.isArray(raw.enum) ? raw.enum : undefined,
  };
}

/**
 * Normalize a hook definition.
 */
function normalizeHook(raw: Record<string, unknown>): SkillHook {
  return {
    name: typeof raw.name === 'string' ? raw.name : 'unknown',
    event: (['pre', 'post', 'error'].includes(raw.event as string)
      ? raw.event
      : 'post') as SkillHook['event'],
    command: typeof raw.command === 'string' ? raw.command : undefined,
    script: typeof raw.script === 'string' ? raw.script : undefined,
    timeout: typeof raw.timeout === 'number' ? raw.timeout : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Directory Scanner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan a directory for skill files.
 */
export async function scanSkillDirectory(
  dirPath: string,
  skillFileName: string = 'SKILL.md'
): Promise<ParsedSkillFile[]> {
  const skills: ParsedSkillFile[] = [];

  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = path.join(dirPath, entry.name, skillFileName);
        try {
          await fs.promises.access(skillFile);
          const parsed = await parseSkillFile(skillFile);
          if (parsed.errors.length === 0) {
            skills.push(parsed);
          }
        } catch {
          // No skill file in directory
        }
      } else if (entry.name === skillFileName) {
        const parsed = await parseSkillFile(path.join(dirPath, entry.name));
        if (parsed.errors.length === 0) {
          skills.push(parsed);
        }
      }
    }
  } catch (error) {
    logger.warn('[SkillFrontmatter] Failed to scan directory', {
      path: dirPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return skills;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate frontmatter structure.
 */
export function validateFrontmatter(
  frontmatter: SkillFrontmatter
): string[] {
  const errors: string[] = [];

  if (frontmatter.name && typeof frontmatter.name !== 'string') {
    errors.push('name must be a string');
  }

  if (frontmatter.allowedTools && !Array.isArray(frontmatter.allowedTools)) {
    errors.push('allowedTools must be an array');
  }

  if (frontmatter.deniedTools && !Array.isArray(frontmatter.deniedTools)) {
    errors.push('deniedTools must be an array');
  }

  if (frontmatter.arguments && typeof frontmatter.arguments !== 'object') {
    errors.push('arguments must be an object');
  }

  if (frontmatter.hooks && !Array.isArray(frontmatter.hooks)) {
    errors.push('hooks must be an array');
  }

  return errors;
}

/**
 * Merge frontmatter from multiple sources.
 */
export function mergeFrontmatter(
  ...sources: SkillFrontmatter[]
): SkillFrontmatter {
  const result: SkillFrontmatter = {};

  for (const source of sources) {
    if (source.name) result.name = source.name;
    if (source.description) result.description = source.description;
    if (source.version) result.version = source.version;
    if (source.author) result.author = source.author;

    if (source.allowedTools) {
      result.allowedTools = [
        ...(result.allowedTools || []),
        ...source.allowedTools,
      ];
    }

    if (source.deniedTools) {
      result.deniedTools = [
        ...(result.deniedTools || []),
        ...source.deniedTools,
      ];
    }

    if (source.arguments) {
      result.arguments = {
        ...(result.arguments || {}),
        ...source.arguments,
      };
    }

    if (source.hooks) {
      result.hooks = [
        ...(result.hooks || []),
        ...source.hooks,
      ];
    }

    if (source.tags) {
      result.tags = [
        ...(result.tags || []),
        ...source.tags,
      ];
    }

    if (source.dependencies) {
      result.dependencies = [
        ...(result.dependencies || []),
        ...source.dependencies,
      ];
    }

    if (source.enabled !== undefined) {
      result.enabled = source.enabled;
    }

    if (source.metadata) {
      result.metadata = {
        ...(result.metadata || {}),
        ...source.metadata,
      };
    }
  }

  return result;
}

export default parseSkillFile;