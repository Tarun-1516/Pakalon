/**
 * Feature Flags System for Pakalon CLI
 *
 * Provides granular control over features based on deployment mode (cloud vs selfhosted).
 */

import { detectMode, isSelfHosted, loadModeConfig } from "./mode.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeatureFlags {
  // Core features
  openrouter: boolean;
  auth: boolean;
  sessionLimits: boolean;
  proModels: boolean;
  analytics: boolean;

  // Provider features
  localModels: boolean;
  cloudProviders: boolean;

  // Billing features
  billing: boolean;
  subscriptions: boolean;

  // Security features
  auditLogging: boolean;
  rateLimiting: boolean;

  // UI features
  uiOpenrouter: boolean;
  uiProModels: boolean;
}

// Feature configurations for different modes
const OSS_FEATURES: FeatureFlags = {
  openrouter: false,
  auth: false,
  sessionLimits: false,
  proModels: false,
  analytics: false,
  localModels: true,
  cloudProviders: false,
  billing: false,
  subscriptions: false,
  auditLogging: false,
  rateLimiting: false,
  uiOpenrouter: false,
  uiProModels: false,
};

const CLOUD_FEATURES: FeatureFlags = {
  openrouter: true,
  auth: true,
  sessionLimits: true,
  proModels: true,
  analytics: true,
  localModels: true,
  cloudProviders: true,
  billing: true,
  subscriptions: true,
  auditLogging: true,
  rateLimiting: true,
  uiOpenrouter: true,
  uiProModels: true,
};

const SELFHOSTED_FEATURES: FeatureFlags = {
  openrouter: false,
  auth: false,
  sessionLimits: false,
  proModels: false,
  analytics: false,
  localModels: true,
  cloudProviders: false,
  billing: false,
  subscriptions: false,
  auditLogging: false,
  rateLimiting: false,
  uiOpenrouter: false,
  uiProModels: false,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cachedFlags: FeatureFlags | null = null;

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Get feature flags based on current deployment mode
 */
export function getFeatureFlags(): FeatureFlags {
  if (cachedFlags) {
    return cachedFlags;
  }

  const mode = detectMode();

  if (mode === "selfhosted") {
    cachedFlags = { ...SELFHOSTED_FEATURES };
  } else {
    cachedFlags = { ...CLOUD_FEATURES };
  }

  return cachedFlags;
}

/**
 * Check if a specific feature is enabled
 */
export function isFeatureEnabled(feature: keyof FeatureFlags): boolean {
  const flags = getFeatureFlags();
  return flags[feature];
}

/**
 * Get available providers based on feature flags
 */
export function getAvailableProviders(): string[] {
  const flags = getFeatureFlags();
  const providers: string[] = [];

  if (flags.localModels) {
    providers.push("ollama", "lmstudio");
  }

  if (flags.cloudProviders) {
    providers.push("openrouter");
  }

  return providers;
}

/**
 * Get available models grouped by provider
 */
export function getAvailableModels(): Record<string, string[]> {
  const flags = getFeatureFlags();
  const models: Record<string, string[]> = {};

  if (flags.localModels) {
    models["ollama"] = []; // Will be populated dynamically
    models["lmstudio"] = []; // Will be populated dynamically
  }

  if (flags.cloudProviders) {
    models["openrouter"] = []; // Will be populated dynamically
  }

  return models;
}

/**
 * Reset cached feature flags (useful for testing)
 */
export function resetFeatureFlags(): void {
  cachedFlags = null;
}

/**
 * Get feature flags status for display
 */
export function getFeatureFlagsStatus(): Record<string, boolean> {
  const flags = getFeatureFlags();
  return {
    "OpenRouter": flags.openrouter,
    "Authentication": flags.auth,
    "Session Limits": flags.sessionLimits,
    "Pro Models": flags.proModels,
    "Analytics": flags.analytics,
    "Local Models": flags.localModels,
    "Cloud Providers": flags.cloudProviders,
    "Billing": flags.billing,
    "Subscriptions": flags.subscriptions,
    "Audit Logging": flags.auditLogging,
    "Rate Limiting": flags.rateLimiting,
  };
}
