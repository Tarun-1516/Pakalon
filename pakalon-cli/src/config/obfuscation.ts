/**
 * Configuration Obfuscation for Pakalon CLI
 *
 * Provides secure configuration handling and API key management.
 */

import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecureConfig {
  mode: string;
  environment?: string;
  localOllamaUrl?: string;
  localLmstudioUrl?: string;
  localOllamaEnabled?: boolean;
  localLmstudioEnabled?: boolean;
  openrouterKeySet?: boolean;
  supabaseUrlSet?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = [
  "api_key",
  "api_secret",
  "access_token",
  "secret_key",
  "password",
  "jwt_secret",
  "webhook_secret",
];

// ---------------------------------------------------------------------------
// Config Obfuscator
// ---------------------------------------------------------------------------

export class ConfigObfuscator {
  /**
   * Obfuscate sensitive values in a dictionary
   */
  static obfuscateDict(data: Record<string, unknown>): Record<string, unknown> {
    const obfuscated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEYS.some((sensitive) => key.toLowerCase().includes(sensitive))) {
        obfuscated[key] = this.redactValue(value);
      } else {
        obfuscated[key] = value;
      }
    }
    return obfuscated;
  }

  /**
   * Redact a sensitive value
   */
  static redactValue(value: unknown): string {
    if (typeof value === "string") {
      if (value.length < 8) {
        return "***";
      }
      return `${value.slice(0, 4)}...${value.slice(-4)}`;
    }
    return "***";
  }

  /**
   * Sanitize configuration for safe logging
   */
  static sanitizeForLogging(config: Record<string, unknown>): Record<string, unknown> {
    return this.obfuscateDict(config);
  }
}

// ---------------------------------------------------------------------------
// API Key Manager
// ---------------------------------------------------------------------------

export class ApiKeyManager {
  private keys: Map<string, string> = new Map();

  /**
   * Get API key for a provider
   */
  getKey(provider: string): string | undefined {
    // First check environment variables
    const envKey = process.env[`${provider.toUpperCase()}_API_KEY`];
    if (envKey) {
      return envKey;
    }

    // Then check in-memory cache
    return this.keys.get(provider);
  }

  /**
   * Set API key for a provider
   */
  setKey(provider: string, key: string): void {
    this.keys.set(provider, key);
  }

  /**
   * Check if API key exists for a provider
   */
  hasKey(provider: string): boolean {
    return this.getKey(provider) !== undefined;
  }

  /**
   * Get redacted API key for safe logging
   */
  getRedactedKey(provider: string): string {
    const key = this.getKey(provider);
    if (key) {
      return ConfigObfuscator.redactValue(key);
    }
    return "***";
  }

  /**
   * Clear all cached keys
   */
  clearKeys(): void {
    this.keys.clear();
  }
}

// ---------------------------------------------------------------------------
// Global Instances
// ---------------------------------------------------------------------------

let apiKeyManager: ApiKeyManager | null = null;

/**
 * Get the global API key manager
 */
export function getApiKeyManager(): ApiKeyManager {
  if (!apiKeyManager) {
    apiKeyManager = new ApiKeyManager();
  }
  return apiKeyManager;
}

/**
 * Get configuration with sensitive values obfuscated
 */
export function getSecureConfig(): SecureConfig {
  const mode = process.env.PAKALON_MODE || "cloud";
  const config: SecureConfig = {
    mode,
    localOllamaUrl: process.env.PAKALON_OLLAMA_URL || "http://localhost:11434",
    localLmstudioUrl: process.env.PAKALON_LMSTUDIO_URL || "http://localhost:1234",
    localOllamaEnabled: process.env.LOCAL_OLLAMA_ENABLED !== "false",
    localLmstudioEnabled: process.env.LOCAL_LMSTUDIO_ENABLED !== "false",
  };

  // Add cloud-specific config only if not self-hosted
  if (mode !== "selfhosted") {
    config.openrouterKeySet = !!process.env.OPENROUTER_API_KEY;
    config.supabaseUrlSet = !!process.env.SUPABASE_URL;
  }

  return config;
}
