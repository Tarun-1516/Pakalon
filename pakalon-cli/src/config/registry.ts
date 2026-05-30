/**
 * Provider Registry System for Pakalon CLI
 *
 * Manages provider registration and availability based on feature flags.
 */

import logger from "@/utils/logger.js";
import { getFeatureFlags, type FeatureFlags } from "@/config/features.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderType = "local" | "cloud";

export interface ProviderConfig {
  baseUrl: string;
  timeout?: number;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface ModelProvider {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  config: ProviderConfig;
  capabilities: string[];
}

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

export class ProviderRegistry {
  private providers: Map<string, ModelProvider> = new Map();
  private features: FeatureFlags;

  constructor() {
    this.features = getFeatureFlags();
  }

  /**
   * Register a provider if feature flags allow it
   */
  registerProvider(provider: ModelProvider): void {
    // Check if cloud provider is allowed
    if (provider.type === "cloud" && !this.features.cloudProviders) {
      logger.warn(`[ProviderRegistry] Cloud provider ${provider.id} disabled in self-hosted mode`);
      return;
    }

    // Check if local provider is allowed
    if (provider.type === "local" && !this.features.localModels) {
      logger.warn(`[ProviderRegistry] Local provider ${provider.id} disabled`);
      return;
    }

    this.providers.set(provider.id, provider);
    logger.info(`[ProviderRegistry] Registered provider: ${provider.id} (${provider.type})`);
  }

  /**
   * Get a registered provider
   */
  getProvider(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Get all enabled providers
   */
  getEnabledProviders(): ModelProvider[] {
    return Array.from(this.providers.values()).filter((p) => p.enabled);
  }

  /**
   * Get providers by type
   */
  getProvidersByType(type: ProviderType): ModelProvider[] {
    return Array.from(this.providers.values()).filter((p) => p.type === type);
  }

  /**
   * Check if a provider is available
   */
  isProviderAvailable(providerId: string): boolean {
    const provider = this.providers.get(providerId);
    return provider !== undefined && provider.enabled;
  }

  /**
   * Get list of available provider IDs
   */
  getAvailableProviderIds(): string[] {
    return this.getEnabledProviders().map((p) => p.id);
  }

  /**
   * Clear all registered providers
   */
  clear(): void {
    this.providers.clear();
  }
}

// Global instance
let registry: ProviderRegistry | null = null;

export function getProviderRegistry(): ProviderRegistry {
  if (!registry) {
    registry = new ProviderRegistry();
    registerDefaultProviders();
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Default Providers
// ---------------------------------------------------------------------------

function registerDefaultProviders(): void {
  const flags = getFeatureFlags();
  const reg = getProviderRegistry();

  // Register local providers
  if (flags.localModels) {
    // Register Ollama
    reg.registerProvider({
      id: "ollama",
      name: "Ollama",
      type: "local",
      enabled: true,
      config: {
        baseUrl: process.env.PAKALON_OLLAMA_URL || "http://localhost:11434",
        timeout: 30000,
      },
      capabilities: ["chat", "embeddings"],
    });

    // Register LM Studio
    reg.registerProvider({
      id: "lmstudio",
      name: "LM Studio",
      type: "local",
      enabled: true,
      config: {
        baseUrl: process.env.PAKALON_LMSTUDIO_URL || "http://localhost:1234",
        timeout: 30000,
      },
      capabilities: ["chat", "embeddings"],
    });
  }

  // Register cloud providers
  if (flags.cloudProviders && process.env.OPENROUTER_API_KEY) {
    reg.registerProvider({
      id: "openrouter",
      name: "OpenRouter",
      type: "cloud",
      enabled: true,
      config: {
        baseUrl: "https://openrouter.ai/api/v1",
        timeout: 60000,
        apiKey: process.env.OPENROUTER_API_KEY,
      },
      capabilities: ["chat", "embeddings", "completions"],
    });
  }
}

// ---------------------------------------------------------------------------
// Convenience Functions
// ---------------------------------------------------------------------------

/**
 * Get available providers
 */
export function getAvailableProviders(): ModelProvider[] {
  return getProviderRegistry().getEnabledProviders();
}

/**
 * Check if provider is available
 */
export function isProviderAvailable(providerId: string): boolean {
  return getProviderRegistry().isProviderAvailable(providerId);
}

/**
 * Get provider by ID
 */
export function getProvider(providerId: string): ModelProvider | undefined {
  return getProviderRegistry().getProvider(providerId);
}
