/**
 * Environment Variable Isolation for Pakalon CLI
 *
 * Controls which environment variables are loaded based on deployment mode.
 */

import logger from "@/utils/logger.js";
import { isSelfHosted } from "@/config/mode.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Environment variables allowed in self-hosted mode
const OSS_ENV_KEYS = [
  "OLLAMA_BASE_URL",
  "OLLAMA_PORT",
  "LMSTUDIO_BASE_URL",
  "LMSTUDIO_PORT",
  "APP_PORT",
  "APP_DEBUG",
  "PAKALON_MODE",
  "PAKALON_OLLAMA_URL",
  "PAKALON_LMSTUDIO_URL",
  "SELFHOSTED",
  "PAKALON_SELFHOSTED",
];

// Additional environment variables allowed in cloud mode
const CLOUD_ENV_KEYS = [
  ...OSS_ENV_KEYS,
  "OPENROUTER_API_KEY",
  "OPENROUTER_MASTER_KEY",
  "AUTH_SECRET",
  "SESSION_SECRET",
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "JWT_SECRET",
  "FEATURE_OPENROUTER",
  "FEATURE_AUTH",
];

// Cloud-only environment variables
const CLOUD_ONLY_VARS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_MASTER_KEY",
  "AUTH_SECRET",
  "SESSION_SECRET",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "JWT_SECRET",
];

// ---------------------------------------------------------------------------
// Environment Isolator
// ---------------------------------------------------------------------------

export class EnvironmentIsolator {
  private isCloud: boolean;
  private allowedKeys: string[];
  private originalValues: Map<string, string | undefined> = new Map();

  constructor(isCloud: boolean = false) {
    this.isCloud = isCloud;
    this.allowedKeys = isCloud ? CLOUD_ENV_KEYS : OSS_ENV_KEYS;
  }

  /**
   * Load environment variables based on mode
   */
  loadEnvironment(): void {
    // Store original values for potential restoration
    for (const key of this.allowedKeys) {
      this.originalValues.set(key, process.env[key]);
    }

    // In self-hosted mode, remove cloud-only variables
    if (!this.isCloud) {
      for (const key of CLOUD_ONLY_VARS) {
        if (process.env[key]) {
          logger.warn(`[EnvironmentIsolator] Environment variable ${key} ignored in self-hosted mode`);
          delete process.env[key];
        }
      }
    }
  }

  /**
   * Get list of allowed environment variable keys
   */
  getAllowedKeys(): string[] {
    return [...this.allowedKeys];
  }

  /**
   * Check if an environment variable key is allowed
   */
  isKeyAllowed(key: string): boolean {
    return this.allowedKeys.includes(key);
  }

  /**
   * Sanitize environment variables for safe logging
   */
  sanitizeEnvForLogging(): Record<string, string | undefined> {
    const sanitized: Record<string, string | undefined> = {};
    const sensitivePatterns = ["KEY", "SECRET", "TOKEN", "PASSWORD"];

    for (const key of this.allowedKeys) {
      const value = process.env[key];
      if (value) {
        if (sensitivePatterns.some((pattern) => key.toUpperCase().includes(pattern))) {
          sanitized[key] = "***REDACTED***";
        } else {
          sanitized[key] = value;
        }
      } else {
        sanitized[key] = undefined;
      }
    }

    return sanitized;
  }
}

// ---------------------------------------------------------------------------
// Global Instance
// ---------------------------------------------------------------------------

let isolator: EnvironmentIsolator | null = null;

/**
 * Get the global environment isolator
 */
export function getEnvironmentIsolator(): EnvironmentIsolator {
  if (!isolator) {
    isolator = new EnvironmentIsolator(!isSelfHosted());
  }
  return isolator;
}

/**
 * Initialize environment isolation
 */
export function initializeEnvironment(isCloud: boolean = false): EnvironmentIsolator {
  isolator = new EnvironmentIsolator(isCloud);
  isolator.loadEnvironment();
  return isolator;
}
