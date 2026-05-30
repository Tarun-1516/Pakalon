/**
 * Permissions Module
 * 
 * Complete permission system including:
 * - Rule-based permissions (rule-engine.ts)
 * - Bash command arity (bashArity.ts)
 * - Permission ruleset schema (permissionRuleset.ts)
 * - External directory permissions (externalDirectory.ts)
 * - Denial tracking (denialTracking.ts)
 * - YOLO classifier (yoloClassifier.ts)
 */

// Rule Engine
export {
  initPermissionSystem,
  addRule,
  removeRule,
  updateRule,
  getRules,
  getRulesByScope,
  evaluatePermission,
  requiresPermission,
  getPermissionSuggestion,
  clearRules,
  addDefaultAllowRules,
  addDefaultDenyRules,
  addDefaultBashAllowRules,
} from './rule-engine.js';
export type { PermissionRule, PermissionBehavior, PermissionContext, PermissionDecision } from './rule-engine.js';

// Bash Arity
export {
  extractCommandPrefix,
  prefix,
  getCommandName,
  matchesCommandPattern,
  getSupportedCommands,
  getArity,
} from './bashArity.js';

// Permission Ruleset Schema
export {
  evaluate as evaluateRuleset,
  merge as mergeRulesets,
  disabled as getDisabledTools,
  matchesPattern,
  fromConfig,
  loadRules,
  saveRules,
  addRule as addRulesetRule,
  removeRule as removeRulesetRule,
} from './permissionRuleset.js';
export type { PermissionAction, PermissionRule as RulesetRule, PermissionRuleset, PermissionRequest, PermissionDecision as RulesetDecision } from './permissionRuleset.js';

// External Directory
export {
  assertExternalDirectory,
  isWithinProject,
  getExternalDirectoryPattern,
  checkExternalDirectory,
} from './externalDirectory.js';
export type { ExternalDirectoryCheck, ExternalDirectoryOptions } from './externalDirectory.js';

// Denial Tracking
export {
  trackDenial,
  getDenialStats,
  clearDenialHistory,
} from './denialTracking.js';

// YOLO Classifier
export {
  classifyToolUse,
  isYOLOMode,
} from './yoloClassifier.js';
