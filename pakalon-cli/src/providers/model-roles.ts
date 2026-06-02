/**
 * Model Roles System
 *
 * Routes work by intent using role-based model selection:
 * - default: Normal turns (main agent work)
 * - smol: Cheap subagent fan-out (quick tasks, searches)
 * - slow: Deep reasoning (complex architecture, debugging)
 * - plan: Plan mode (read-only analysis)
 * - commit: Changelogs and documentation
 *
 * Roles can be overridden at launch (--smol, --slow, --plan)
 * or cycled with Ctrl+P during session.
 */

import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ModelRole = 'default' | 'smol' | 'slow' | 'plan' | 'commit';

export interface RoleConfig {
  /** Role identifier */
  role: ModelRole;
  /** Human-readable name */
  displayName: string;
  /** Description of when to use this role */
  description: string;
  /** Default model for this role */
  defaultModel: string;
  /** Max tokens for this role */
  maxTokens: number;
  /** Temperature for this role */
  temperature: number;
  /** Whether this role is available */
  enabled: boolean;
}

export interface PathScopedRole {
  /** Path pattern (glob supported) */
  pathPattern: string;
  /** Role to use for this path */
  role: ModelRole;
  /** Model override for this path */
  modelId?: string;
  /** Priority (higher = more specific) */
  priority: number;
}

export interface ModelRoleConfig {
  /** Role configurations */
  roles: Record<ModelRole, RoleConfig>;
  /** Path-scoped role overrides */
  pathScopedRoles: PathScopedRole[];
  /** Fallback chain per role */
  fallbackChains: Record<ModelRole, string[]>;
  /** Per-credential round-robin settings */
  roundRobin: {
    enabled: boolean;
    /** Session affinity duration in ms */
    affinityDuration: number;
    /** Per-credential cooldown on error in ms */
    cooldownDuration: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configurations
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ROLE_CONFIG: ModelRoleConfig = {
  roles: {
    default: {
      role: 'default',
      displayName: 'Default',
      description: 'Normal turns - main agent work',
      defaultModel: 'anthropic/claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 0.7,
      enabled: true,
    },
    smol: {
      role: 'smol',
      displayName: 'Smol',
      description: 'Cheap subagent fan-out - quick tasks, searches',
      defaultModel: 'anthropic/claude-3.5-haiku',
      maxTokens: 4096,
      temperature: 0.5,
      enabled: true,
    },
    slow: {
      role: 'slow',
      displayName: 'Slow',
      description: 'Deep reasoning - complex architecture, debugging',
      defaultModel: 'anthropic/claude-opus-4-20250514',
      maxTokens: 16384,
      temperature: 0.3,
      enabled: true,
    },
    plan: {
      role: 'plan',
      displayName: 'Plan',
      description: 'Plan mode - read-only analysis',
      defaultModel: 'anthropic/claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 0.5,
      enabled: true,
    },
    commit: {
      role: 'commit',
      displayName: 'Commit',
      description: 'Changelogs and documentation',
      defaultModel: 'anthropic/claude-3.5-haiku',
      maxTokens: 4096,
      temperature: 0.3,
      enabled: true,
    },
  },
  pathScopedRoles: [],
  fallbackChains: {
    default: ['openrouter', 'anthropic', 'openai'],
    smol: ['openrouter', 'anthropic'],
    slow: ['anthropic', 'openrouter'],
    plan: ['anthropic', 'openrouter'],
    commit: ['openrouter', 'anthropic'],
  },
  roundRobin: {
    enabled: false,
    affinityDuration: 30 * 60 * 1000, // 30 minutes
    cooldownDuration: 60 * 1000, // 1 minute
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Model Roles Manager
// ─────────────────────────────────────────────────────────────────────────────

export class ModelRolesManager {
  private config: ModelRoleConfig;
  private activeRole: ModelRole = 'default';
  private credentialState: Map<string, {
    lastUsed: number;
    cooldownUntil: number;
    usageCount: number;
  }> = new Map();

  constructor(config?: Partial<ModelRoleConfig>) {
    this.config = {
      ...DEFAULT_ROLE_CONFIG,
      ...config,
      roles: {
        ...DEFAULT_ROLE_CONFIG.roles,
        ...config?.roles,
      },
    };
  }

  /**
   * Get the active role
   */
  getActiveRole(): ModelRole {
    return this.activeRole;
  }

  /**
   * Set the active role
   */
  setActiveRole(role: ModelRole): void {
    if (!this.config.roles[role]?.enabled) {
      logger.warn(`[ModelRoles] Role ${role} is disabled`);
      return;
    }
    this.activeRole = role;
    logger.info(`[ModelRoles] Active role set to ${role}`);
  }

  /**
   * Get role configuration
   */
  getRoleConfig(role: ModelRole): RoleConfig | undefined {
    return this.config.roles[role];
  }

  /**
   * Get all enabled roles
   */
  getEnabledRoles(): RoleConfig[] {
    return Object.values(this.config.roles).filter(r => r.enabled);
  }

  /**
   * Get model for a role, considering path-scoped overrides
   */
  getModelForRole(role: ModelRole, filePath?: string): string {
    // Check path-scoped roles first
    if (filePath) {
      const pathRole = this.getPathScopedRole(filePath);
      if (pathRole && pathRole.role === role) {
        return pathRole.modelId || this.config.roles[role].defaultModel;
      }
    }

    return this.config.roles[role].defaultModel;
  }

  /**
   * Get max tokens for a role
   */
  getMaxTokensForRole(role: ModelRole): number {
    return this.config.roles[role].maxTokens;
  }

  /**
   * Get temperature for a role
   */
  getTemperatureForRole(role: ModelRole): number {
    return this.config.roles[role].temperature;
  }

  /**
   * Get fallback chain for a role
   */
  getFallbackChain(role: ModelRole): string[] {
    return this.config.fallbackChains[role] || [];
  }

  /**
   * Add a path-scoped role
   */
  addPathScopedRole(pathScopedRole: PathScopedRole): void {
    this.config.pathScopedRoles.push(pathScopedRole);
    this.config.pathScopedRoles.sort((a, b) => b.priority - a.priority);
    logger.info(`[ModelRoles] Added path-scoped role for ${pathScopedRole.pathPattern}`);
  }

  /**
   * Remove a path-scoped role
   */
  removePathScopedRole(pathPattern: string): boolean {
    const index = this.config.pathScopedRoles.findIndex(r => r.pathPattern === pathPattern);
    if (index !== -1) {
      this.config.pathScopedRoles.splice(index, 1);
      logger.info(`[ModelRoles] Removed path-scoped role for ${pathPattern}`);
      return true;
    }
    return false;
  }

  /**
   * Get path-scoped role for a file path
   */
  private getPathScopedRole(filePath: string): PathScopedRole | undefined {
    for (const pathRole of this.config.pathScopedRoles) {
      if (this.matchesGlob(pathRole.pathPattern, filePath)) {
        return pathRole;
      }
    }
    return undefined;
  }

  /**
   * Simple glob matching
   */
  private matchesGlob(pattern: string, value: string): boolean {
    const regex = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${regex}$`, 'i').test(value);
  }

  /**
   * Get next available credential for round-robin
   */
  getNextCredential(providerId: string, credentials: string[]): string | null {
    if (!this.config.roundRobin.enabled || credentials.length === 0) {
      return credentials[0] || null;
    }

    const now = Date.now();

    // Filter out credentials in cooldown
    const available = credentials.filter(cred => {
      const state = this.credentialState.get(cred);
      if (!state) return true;
      return state.cooldownUntil < now;
    });

    if (available.length === 0) {
      // All credentials in cooldown, use the one with shortest cooldown
      let bestCred = credentials[0];
      let shortestCooldown = Infinity;

      for (const cred of credentials) {
        const state = this.credentialState.get(cred);
        if (state && state.cooldownUntil < shortestCooldown) {
          shortestCooldown = state.cooldownUntil;
          bestCred = cred;
        }
      }

      return bestCred;
    }

    // Check session affinity
    const affinitized = available.find(cred => {
      const state = this.credentialState.get(cred);
      if (!state) return false;
      return (now - state.lastUsed) < this.config.roundRobin.affinityDuration;
    });

    if (affinitized) {
      return affinitized;
    }

    // Round-robin: pick least recently used
    let bestCred = available[0];
    let oldestUse = Infinity;

    for (const cred of available) {
      const state = this.credentialState.get(cred);
      if (!state || state.lastUsed < oldestUse) {
        oldestUse = state?.lastUsed || 0;
        bestCred = cred;
      }
    }

    return bestCred;
  }

  /**
   * Mark credential as used
   */
  markCredentialUsed(credential: string): void {
    const state = this.credentialState.get(credential) || {
      lastUsed: 0,
      cooldownUntil: 0,
      usageCount: 0,
    };

    state.lastUsed = Date.now();
    state.usageCount++;
    this.credentialState.set(credential, state);
  }

  /**
   * Mark credential as failed (enter cooldown)
   */
  markCredentialFailed(credential: string): void {
    const state = this.credentialState.get(credential) || {
      lastUsed: 0,
      cooldownUntil: 0,
      usageCount: 0,
    };

    state.cooldownUntil = Date.now() + this.config.roundRobin.cooldownDuration;
    this.credentialState.set(credential, state);
    logger.warn(`[ModelRoles] Credential ${credential} entered cooldown`);
  }

  /**
   * Get credential state for debugging
   */
  getCredentialState(): Map<string, {
    lastUsed: number;
    cooldownUntil: number;
    usageCount: number;
  }> {
    return new Map(this.credentialState);
  }

  /**
   * Export config for persistence
   */
  exportConfig(): ModelRoleConfig {
    return { ...this.config };
  }

  /**
   * Import config from persistence
   */
  importConfig(config: Partial<ModelRoleConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      roles: {
        ...this.config.roles,
        ...config.roles,
      },
    };
    logger.info('[ModelRoles] Config imported');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Instance
// ─────────────────────────────────────────────────────────────────────────────

export const modelRolesManager = new ModelRolesManager();

// ─────────────────────────────────────────────────────────────────────────────
// Convenience Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the active model role
 */
export function getActiveModelRole(): ModelRole {
  return modelRolesManager.getActiveRole();
}

/**
 * Set the active model role
 */
export function setActiveModelRole(role: ModelRole): void {
  modelRolesManager.setActiveRole(role);
}

/**
 * Get model for current role and optional file path
 */
export function getModelForCurrentRole(filePath?: string): string {
  const role = modelRolesManager.getActiveRole();
  return modelRolesManager.getModelForRole(role, filePath);
}

/**
 * Get max tokens for current role
 */
export function getMaxTokensForCurrentRole(): number {
  const role = modelRolesManager.getActiveRole();
  return modelRolesManager.getMaxTokensForRole(role);
}

/**
 * Get temperature for current role
 */
export function getTemperatureForCurrentRole(): number {
  const role = modelRolesManager.getActiveRole();
  return modelRolesManager.getTemperatureForRole(role);
}

/**
 * Get fallback chain for current role
 */
export function getFallbackChainForCurrentRole(): string[] {
  const role = modelRolesManager.getActiveRole();
  return modelRolesManager.getFallbackChain(role);
}

/**
 * Add a path-scoped role
 */
export function addPathScopedRole(pathScopedRole: PathScopedRole): void {
  modelRolesManager.addPathScopedRole(pathScopedRole);
}

/**
 * Remove a path-scoped role
 */
export function removePathScopedRole(pathPattern: string): boolean {
  return modelRolesManager.removePathScopedRole(pathPattern);
}

/**
 * Get next available credential for round-robin
 */
export function getNextCredential(providerId: string, credentials: string[]): string | null {
  return modelRolesManager.getNextCredential(providerId, credentials);
}

/**
 * Mark credential as used
 */
export function markCredentialUsed(credential: string): void {
  modelRolesManager.markCredentialUsed(credential);
}

/**
 * Mark credential as failed
 */
export function markCredentialFailed(credential: string): void {
  modelRolesManager.markCredentialFailed(credential);
}
