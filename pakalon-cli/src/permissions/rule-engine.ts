/**
 * Permission System
 *
 * Rule-based allow/deny/ask framework for tool permissions.
 * Supports:
 * - Global rules (apply to all sessions)
 * - Project rules (apply to specific project)
 * - Session rules (apply to current session)
 * - Tool-specific rules
 * - Path-based rules
 * - User prompt-based rules
 */

import * as fs from 'fs';
import * as path from 'path';
import logger from '@/utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionBehavior = 'allow' | 'deny' | 'ask';

export interface PermissionRule {
  /** Unique rule ID */
  id: string;
  /** Rule name/description */
  name: string;
  /** Permission behavior */
  behavior: PermissionBehavior;
  /** Tool name pattern (glob supported) */
  toolPattern: string;
  /** Path pattern (glob supported, optional) */
  pathPattern?: string;
  /** User prompt pattern (regex, optional) */
  promptPattern?: string;
  /** Rule priority (higher = more important) */
  priority: number;
  /** Rule scope */
  scope: 'global' | 'project' | 'session';
  /** Whether rule is enabled */
  enabled: boolean;
  /** Rule creation timestamp */
  createdAt: Date;
  /** Rule expiration (optional) */
  expiresAt?: Date;
}

export interface PermissionContext {
  /** Current tool name */
  toolName: string;
  /** File path (if applicable) */
  filePath?: string;
  /** User prompt (if applicable) */
  userPrompt?: string;
  /** Current session ID */
  sessionId?: string;
  /** Current project directory */
  projectDir?: string;
}

export interface PermissionDecision {
  /** Decision behavior */
  behavior: PermissionBehavior;
  /** Rule that caused this decision */
  ruleId?: string;
  /** Reason for decision */
  reason: string;
  /** Whether to show suggestion to user */
  showSuggestion?: boolean;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const rules: PermissionRule[] = [];
let settingsPath: string | null = null;

/**
 * Initialize permission system with project directory
 */
export function initPermissionSystem(projectDir: string): void {
  settingsPath = path.join(projectDir, '.pakalon', 'settings.local.json');
  loadRules();
}

/**
 * Load rules from settings file
 */
function loadRules(): void {
  if (!settingsPath || !fs.existsSync(settingsPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content) as { permissionRules?: PermissionRule[] };

    if (settings.permissionRules) {
      rules.length = 0;
      for (const rule of settings.permissionRules) {
        rules.push({
          ...rule,
          createdAt: new Date(rule.createdAt),
          expiresAt: rule.expiresAt ? new Date(rule.expiresAt) : undefined,
        });
      }
      logger.info(`[permissions] Loaded ${rules.length} rules from settings`);
    }
  } catch (error) {
    logger.error(`[permissions] Failed to load rules: ${error}`);
  }
}

/**
 * Save rules to settings file
 */
function saveRules(): void {
  if (!settingsPath) {
    return;
  }

  try {
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let settings: { permissionRules?: PermissionRule[] } = {};
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(content) as { permissionRules?: PermissionRule[] };
    }

    settings.permissionRules = rules;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    logger.info(`[permissions] Saved ${rules.length} rules to settings`);
  } catch (error) {
    logger.error(`[permissions] Failed to save rules: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Rule Management
// ---------------------------------------------------------------------------

/**
 * Add a new permission rule
 */
export function addRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): PermissionRule {
  const newRule: PermissionRule = {
    ...rule,
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date(),
  };

  rules.push(newRule);
  saveRules();

  logger.info(`[permissions] Added rule: ${newRule.name} (${newRule.behavior})`);
  return newRule;
}

/**
 * Remove a permission rule
 */
export function removeRule(ruleId: string): boolean {
  const index = rules.findIndex((r) => r.id === ruleId);
  if (index >= 0) {
    rules.splice(index, 1);
    saveRules();
    logger.info(`[permissions] Removed rule: ${ruleId}`);
    return true;
  }
  return false;
}

/**
 * Update a permission rule
 */
export function updateRule(ruleId: string, updates: Partial<PermissionRule>): boolean {
  const rule = rules.find((r) => r.id === ruleId);
  if (rule) {
    Object.assign(rule, updates);
    saveRules();
    logger.info(`[permissions] Updated rule: ${ruleId}`);
    return true;
  }
  return false;
}

/**
 * Get all rules
 */
export function getRules(): PermissionRule[] {
  return [...rules];
}

/**
 * Get rules for a specific scope
 */
export function getRulesByScope(scope: PermissionRule['scope']): PermissionRule[] {
  return rules.filter((r) => r.scope === scope && r.enabled);
}

// ---------------------------------------------------------------------------
// Bash Arity Integration
// ---------------------------------------------------------------------------

import { getCommandName, matchesCommandPattern } from './bashArity.js';

// ---------------------------------------------------------------------------
// Permission Evaluation
// ---------------------------------------------------------------------------

/**
 * Check if a rule matches a pattern
 */
function matchesPattern(pattern: string, value: string): boolean {
  // Simple glob matching
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, 'i').test(value);
}

/**
 * Check if a bash command matches a pattern using arity-aware matching.
 * This extracts the command name (e.g., "git", "npm run") and compares.
 */
function matchesBashCommandPattern(pattern: string, command: string): boolean {
  // First try direct pattern match
  if (matchesPattern(pattern, command)) {
    return true;
  }
  
  // Then try arity-aware command name matching
  const commandName = getCommandName(command);
  return matchesCommandPattern(pattern, commandName);
}

/**
 * Check if a rule matches a context
 */
function matchesRule(rule: PermissionRule, context: PermissionContext): boolean {
  // Check if rule is expired
  if (rule.expiresAt && rule.expiresAt < new Date()) {
    return false;
  }

  // Check tool pattern - use arity-aware matching for Bash tool
  if (context.toolName === 'Bash' && context.userPrompt) {
    // For Bash commands, use arity-aware matching
    if (!matchesBashCommandPattern(rule.toolPattern, context.userPrompt)) {
      return false;
    }
  } else {
    // For other tools, use standard pattern matching
    if (!matchesPattern(rule.toolPattern, context.toolName)) {
      return false;
    }
  }

  // Check path pattern (if specified)
  if (rule.pathPattern && context.filePath) {
    if (!matchesPattern(rule.pathPattern, context.filePath)) {
      return false;
    }
  }

  // Check prompt pattern (if specified)
  if (rule.promptPattern && context.userPrompt) {
    const regex = new RegExp(rule.promptPattern, 'i');
    if (!regex.test(context.userPrompt)) {
      return false;
    }
  }

  return true;
}

/**
 * Evaluate permission for a context
 */
export function evaluatePermission(context: PermissionContext): PermissionDecision {
  // Get applicable rules (sorted by priority)
  const applicableRules = rules
    .filter((r) => r.enabled && matchesRule(r, context))
    .sort((a, b) => b.priority - a.priority);

  if (applicableRules.length === 0) {
    return {
      behavior: 'ask',
      reason: 'No matching rules found',
      showSuggestion: true,
    };
  }

  // Use highest priority rule
  const rule = applicableRules[0];
  return {
    behavior: rule.behavior,
    ruleId: rule.id,
    reason: `Matched rule: ${rule.name}`,
    showSuggestion: false,
  };
}

// ---------------------------------------------------------------------------
// Preset Rules
// ---------------------------------------------------------------------------

/**
 * Add default allow rules for safe operations
 */
export function addDefaultAllowRules(): void {
  const safeTools = [
    'Read',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'LSP',
    'lsp_goto_definition',
    'lsp_hover',
    'lsp_find_references',
    'lsp_workspace_symbols',
    'lsp_diagnostics',
    'lsp_completion',
    'AskUserQuestion',
  ];

  for (const tool of safeTools) {
    addRule({
      name: `Allow ${tool}`,
      behavior: 'allow',
      toolPattern: tool,
      priority: 10,
      scope: 'global',
      enabled: true,
    });
  }

  logger.info(`[permissions] Added ${safeTools.length} default allow rules`);
}

/**
 * Add default deny rules for dangerous operations
 */
export function addDefaultDenyRules(): void {
  const dangerousPatterns = [
    { pattern: 'rm -rf /', name: 'Block rm -rf /' },
    { pattern: 'mkfs', name: 'Block filesystem formatting' },
    { pattern: 'dd if=', name: 'Block disk writes' },
  ];

  for (const { pattern, name } of dangerousPatterns) {
    addRule({
      name,
      behavior: 'deny',
      toolPattern: 'Bash',
      promptPattern: pattern,
      priority: 100,
      scope: 'global',
      enabled: true,
    });
  }

  logger.info(`[permissions] Added ${dangerousPatterns.length} default deny rules`);
}

/**
 * Add default allow rules for safe bash commands using arity-aware matching.
 * These rules use the bash command prefix dictionary to match commands.
 */
export function addDefaultBashAllowRules(): void {
  const safeBashCommands = [
    { pattern: 'git', name: 'Allow git commands' },
    { pattern: 'git status', name: 'Allow git status' },
    { pattern: 'git log', name: 'Allow git log' },
    { pattern: 'git diff', name: 'Allow git diff' },
    { pattern: 'git branch', name: 'Allow git branch' },
    { pattern: 'npm', name: 'Allow npm commands' },
    { pattern: 'npm run', name: 'Allow npm run' },
    { pattern: 'npm install', name: 'Allow npm install' },
    { pattern: 'npm test', name: 'Allow npm test' },
    { pattern: 'bun', name: 'Allow bun commands' },
    { pattern: 'bun run', name: 'Allow bun run' },
    { pattern: 'bun install', name: 'Allow bun install' },
    { pattern: 'bun test', name: 'Allow bun test' },
    { pattern: 'pnpm', name: 'Allow pnpm commands' },
    { pattern: 'pnpm run', name: 'Allow pnpm run' },
    { pattern: 'pnpm install', name: 'Allow pnpm install' },
    { pattern: 'yarn', name: 'Allow yarn commands' },
    { pattern: 'yarn run', name: 'Allow yarn run' },
    { pattern: 'yarn install', name: 'Allow yarn install' },
    { pattern: 'docker', name: 'Allow docker commands' },
    { pattern: 'docker compose', name: 'Allow docker compose' },
    { pattern: 'docker ps', name: 'Allow docker ps' },
    { pattern: 'docker images', name: 'Allow docker images' },
    { pattern: 'kubectl', name: 'Allow kubectl commands' },
    { pattern: 'kubectl get', name: 'Allow kubectl get' },
    { pattern: 'kubectl describe', name: 'Allow kubectl describe' },
    { pattern: 'kubectl logs', name: 'Allow kubectl logs' },
    { pattern: 'python', name: 'Allow python commands' },
    { pattern: 'pip', name: 'Allow pip commands' },
    { pattern: 'cargo', name: 'Allow cargo commands' },
    { pattern: 'cargo build', name: 'Allow cargo build' },
    { pattern: 'cargo test', name: 'Allow cargo test' },
    { pattern: 'go', name: 'Allow go commands' },
    { pattern: 'go build', name: 'Allow go build' },
    { pattern: 'go test', name: 'Allow go test' },
    { pattern: 'gh', name: 'Allow gh commands' },
    { pattern: 'gh pr', name: 'Allow gh pr commands' },
    { pattern: 'gh issue', name: 'Allow gh issue commands' },
  ];

  for (const { pattern, name } of safeBashCommands) {
    addRule({
      name,
      behavior: 'allow',
      toolPattern: 'Bash',
      promptPattern: pattern,
      priority: 15,
      scope: 'global',
      enabled: true,
    });
  }

  logger.info(`[permissions] Added ${safeBashCommands.length} default bash allow rules`);
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Check if a tool requires permission
 */
export function requiresPermission(toolName: string): boolean {
  const decision = evaluatePermission({ toolName });
  return decision.behavior === 'ask';
}

/**
 * Get permission suggestion for a tool
 */
export function getPermissionSuggestion(toolName: string): string {
  return `Allow ${toolName} for this session?`;
}

/**
 * Clear all rules
 */
export function clearRules(): void {
  rules.length = 0;
  saveRules();
  logger.info('[permissions] Cleared all rules');
}
