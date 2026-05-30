/**
 * Security and Runtime Validation for Pakalon CLI
 *
 * Validates environment and configuration at startup.
 */

import logger from "@/utils/logger.js";
import { isSelfHosted } from "@/config/mode.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
  mode: string;
}

// ---------------------------------------------------------------------------
// Security Validator
// ---------------------------------------------------------------------------

export class SecurityValidator {
  private static SENSITIVE_VARS = [
    "OPENROUTER_API_KEY",
    "OPENROUTER_MASTER_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_JWT_SECRET",
    "POLAR_ACCESS_TOKEN",
    "POLAR_WEBHOOK_SECRET",
    "RESEND_API_KEY",
    "JWT_SECRET",
  ];

  /**
   * Validate environment variables and return warnings
   */
  static validateEnvironment(isSelfhosted: boolean): string[] {
    const warnings: string[] = [];

    if (isSelfhosted) {
      // In self-hosted mode, warn if cloud variables are set
      for (const varName of this.SENSITIVE_VARS) {
        if (process.env[varName]) {
          warnings.push(
            `Environment variable ${varName} is set but will be ignored in self-hosted mode`
          );
        }
      }
    }

    // Validate JWT secret length
    const jwtSecret = process.env.JWT_SECRET || "";
    if (jwtSecret && jwtSecret.length < 32) {
      warnings.push("JWT_SECRET should be at least 32 characters");
    }

    return warnings;
  }

  /**
   * Redact an API key for safe logging
   */
  static redactApiKey(key: string): string {
    if (!key || key.length < 8) {
      return "***";
    }
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
  }

  /**
   * Sanitize environment variables for safe logging
   */
  static sanitizeEnvForLogging(): Record<string, string | undefined> {
    const sanitized: Record<string, string | undefined> = {};
    const sensitivePatterns = ["KEY", "SECRET", "TOKEN", "PASSWORD"];

    for (const key of Object.keys(process.env)) {
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
// Runtime Validator
// ---------------------------------------------------------------------------

export class RuntimeValidator {
  /**
   * Validate local provider URLs
   */
  static validateLocalProviderUrls(): string[] {
    const warnings: string[] = [];

    const ollamaUrl = process.env.PAKALON_OLLAMA_URL || "http://localhost:11434";
    const lmstudioUrl = process.env.PAKALON_LMSTUDIO_URL || "http://localhost:1234";

    // Validate Ollama URL
    if (!this.isValidLocalUrl(ollamaUrl)) {
      warnings.push(`PAKALON_OLLAMA_URL may be invalid: ${ollamaUrl}`);
    }

    // Validate LM Studio URL
    if (!this.isValidLocalUrl(lmstudioUrl)) {
      warnings.push(`PAKALON_LMSTUDIO_URL may be invalid: ${lmstudioUrl}`);
    }

    return warnings;
  }

  /**
   * Check if URL is a valid local URL
   */
  private static isValidLocalUrl(url: string): boolean {
    const pattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/;
    return pattern.test(url);
  }

  /**
   * Validate provider URL
   */
  static validateProviderUrl(
    url: string,
    providerName: string
  ): { valid: boolean; error?: string } {
    if (!url) {
      return { valid: false, error: `${providerName} URL is empty` };
    }

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { valid: false, error: `${providerName} URL must start with http:// or https://` };
    }

    return { valid: true };
  }
}

// ---------------------------------------------------------------------------
// Validation Functions
// ---------------------------------------------------------------------------

/**
 * Validate all configuration at startup
 */
export function validateStartup(): ValidationResult {
  const selfhosted = isSelfHosted();

  const result: ValidationResult = {
    valid: true,
    warnings: [],
    errors: [],
    mode: selfhosted ? "selfhosted" : "cloud",
  };

  // Validate environment
  const envWarnings = SecurityValidator.validateEnvironment(selfhosted);
  result.warnings.push(...envWarnings);

  // Validate local provider URLs (in self-hosted mode)
  if (selfhosted) {
    const urlWarnings = RuntimeValidator.validateLocalProviderUrls();
    result.warnings.push(...urlWarnings);
  }

  // Log results
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      logger.warn(`Startup validation: ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    for (const error of result.errors) {
      logger.error(`Startup validation error: ${error}`);
    }
    result.valid = false;
  }

  return result;
}
