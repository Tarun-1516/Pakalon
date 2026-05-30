/**
 * Permission Ruleset Schema
 * 
 * Schema-based permission system with rulesets, patterns, and evaluation.
 * Modeled after opencode's permission/index.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PermissionAction = 'allow' | 'deny' | 'ask';

export interface PermissionRule {
  /** Permission type (e.g., 'bash', 'edit', 'external_directory') */
  permission: string;
  /** Pattern to match (e.g., '*', 'git*', '/path/to/*') */
  pattern: string;
  /** Action to take */
  action: PermissionAction;
}

export type PermissionRuleset = PermissionRule[];

export interface PermissionRequest {
  /** Unique request ID */
  id: string;
  /** Session ID */
  sessionID: string;
  /** Permission type being requested */
  permission: string;
  /** Patterns to match against */
  patterns: string[];
  /** Metadata about the request */
  metadata: Record<string, unknown>;
  /** Patterns that can be approved "always" */
  always: string[];
}

export interface PermissionDecision {
  /** Decision action */
  action: PermissionAction;
  /** Rule that caused this decision */
  rule?: PermissionRule;
  /** Human-readable reason */
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expand path patterns (~/path, $HOME/path)
 */
function expandPattern(pattern: string): string {
  const home = os.homedir();
  if (pattern.startsWith('~/')) return path.join(home, pattern.slice(2));
  if (pattern === '~') return home;
  if (pattern.startsWith('$HOME/')) return path.join(home, pattern.slice(6));
  if (pattern.startsWith('$HOME')) return path.join(home, pattern.slice(5));
  return pattern;
}

/**
 * Check if a string matches a wildcard pattern
 */
export function matchesPattern(pattern: string, value: string): boolean {
  const expanded = expandPattern(pattern);
  
  // Exact match
  if (expanded === value) return true;
  
  // Wildcard match
  const regex = expanded
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  
  return new RegExp(`^${regex}$`, 'i').test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate a permission against rulesets
 */
export function evaluate(
  permission: string,
  pattern: string,
  ...rulesets: PermissionRuleset[]
): PermissionDecision {
  // Flatten all rules
  const allRules = rulesets.flat();
  
  // Find matching rules (most specific first)
  const matchingRules = allRules.filter(rule => {
    if (rule.permission !== permission) return false;
    return matchesPattern(rule.pattern, pattern);
  });

  if (matchingRules.length === 0) {
    return {
      action: 'ask',
      reason: 'No matching rules found',
    };
  }

  // Deny takes precedence, then allow, then ask
  const denyRule = matchingRules.find(r => r.action === 'deny');
  if (denyRule) {
    return {
      action: 'deny',
      rule: denyRule,
      reason: `Denied by rule: ${denyRule.pattern}`,
    };
  }

  const allowRule = matchingRules.find(r => r.action === 'allow');
  if (allowRule) {
    return {
      action: 'allow',
      rule: allowRule,
      reason: `Allowed by rule: ${allowRule.pattern}`,
    };
  }

  return {
    action: 'ask',
    reason: 'Permission requires user approval',
  };
}

/**
 * Merge multiple rulesets (later rulesets override earlier ones)
 */
export function merge(...rulesets: PermissionRuleset[]): PermissionRuleset {
  return rulesets.flat();
}

/**
 * Get disabled tools from rulesets
 */
export function disabled(tools: string[], ruleset: PermissionRuleset): Set<string> {
  const disabled = new Set<string>();
  
  for (const tool of tools) {
    const decision = evaluate(tool, '*', ruleset);
    if (decision.action === 'deny') {
      disabled.add(tool);
    }
  }
  
  return disabled;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert config-based permission to ruleset
 */
export function fromConfig(permission: Record<string, string | Record<string, PermissionAction>>): PermissionRuleset {
  const ruleset: PermissionRuleset = [];
  
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === 'string') {
      ruleset.push({ permission: key, action: value as PermissionAction, pattern: '*' });
    } else {
      for (const [pattern, action] of Object.entries(value)) {
        ruleset.push({ permission: key, pattern: expandPattern(pattern), action });
      }
    }
  }
  
  return ruleset;
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────

function getPermissionPath(): string {
  return path.join(os.homedir(), '.pakalon', 'permissions.json');
}

/**
 * Load rules from disk
 */
export function loadRules(): PermissionRuleset {
  try {
    const filePath = getPermissionPath();
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as PermissionRuleset;
  } catch {
    return [];
  }
}

/**
 * Save rules to disk
 */
export function saveRules(ruleset: PermissionRuleset): void {
  try {
    const filePath = getPermissionPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(ruleset, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Permission] Failed to save rules:', err);
  }
}

/**
 * Add a rule to the ruleset
 */
export function addRule(rule: PermissionRule): void {
  const rules = loadRules();
  // Remove existing rule for same permission+pattern
  const filtered = rules.filter(r => 
    !(r.permission === rule.permission && r.pattern === rule.pattern)
  );
  filtered.push(rule);
  saveRules(filtered);
}

/**
 * Remove a rule from the ruleset
 */
export function removeRule(permission: string, pattern: string): void {
  const rules = loadRules();
  const filtered = rules.filter(r => 
    !(r.permission === permission && r.pattern === pattern)
  );
  saveRules(filtered);
}

export * as PermissionRuleset from './permissionRuleset.js';
