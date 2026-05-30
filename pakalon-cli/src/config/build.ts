/**
 * Build Configuration for Pakalon CLI
 *
 * Provides build-time configuration and validation.
 */

import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildConfig {
  buildTarget: string;
  isCloudBuild: boolean;
  isOSSBuild: boolean;
  features: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Build Configuration
// ---------------------------------------------------------------------------

let buildConfig: BuildConfig | null = null;

/**
 * Get build configuration
 */
export function getBuildConfig(): BuildConfig {
  if (!buildConfig) {
    buildConfig = createBuildConfig();
  }
  return buildConfig;
}

/**
 * Create build configuration
 */
function createBuildConfig(): BuildConfig {
  const buildTarget = process.env.BUILD_TARGET || "oss";
  const isCloudBuild = buildTarget === "cloud";
  const isOSSBuild = buildTarget === "oss";

  // Feature flags based on build target
  const features: Record<string, boolean> = {
    openrouter: isCloudBuild,
    auth: isCloudBuild,
    session_limits: isCloudBuild,
    pro_models: isCloudBuild,
    analytics: isCloudBuild,
    local_models: true,
    cloud_providers: isCloudBuild,
    billing: isCloudBuild,
    subscriptions: isCloudBuild,
    audit_logging: isCloudBuild,
    rate_limiting: isCloudBuild,
  };

  return {
    buildTarget,
    isCloudBuild,
    isOSSBuild,
    features,
  };
}

/**
 * Log build information
 */
export function logBuildInfo(): void {
  const config = getBuildConfig();

  if (config.isOSSBuild) {
    logger.info("Building Open-Source version");
    logger.info("- Local models only (Ollama, LM Studio)");
    logger.info("- No OpenRouter integration");
    logger.info("- No authentication required");
  } else {
    logger.info("Building Cloud version");
    logger.info("- All model providers available");
    logger.info("- OpenRouter integration enabled");
    logger.info("- Authentication required");
  }
}

/**
 * Check if a feature is enabled
 */
export function isFeatureEnabled(feature: string): boolean {
  const config = getBuildConfig();
  return config.features[feature] ?? false;
}

/**
 * Get feature flags for this build
 */
export function getBuildFeatureFlags(): Record<string, boolean> {
  const config = getBuildConfig();
  return { ...config.features };
}

/**
 * Initialize build configuration
 */
export function initializeBuildConfig(): BuildConfig {
  const config = getBuildConfig();
  logBuildInfo();
  return config;
}
