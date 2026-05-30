/**
 * LSP Service for pakalon-cli
 *
 * Provides Language Server Protocol integration as a service layer.
 * Wraps the existing LSP implementation with a service interface.
 */

import { LSPServerManager } from "@/lsp/LSPServerManager.js";
import { LSPDiagnosticRegistry } from "@/lsp/LSPDiagnosticRegistry.js";
import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type LSPServiceConfig = {
  /** Enable LSP diagnostics */
  enableDiagnostics?: boolean;
  /** Enable symbol navigation */
  enableSymbols?: boolean;
  /** Enable code completion */
  enableCompletion?: boolean;
  /** Enable formatting */
  enableFormatting?: boolean;
  /** Maximum concurrent servers */
  maxServers?: number;
};

export type LSPDocumentSymbol = {
  name: string;
  kind: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
};

export type LSPDiagnostic = {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
};

// ============================================================================
// LSP Service Implementation
// ============================================================================

class LSPService {
  private config: LSPServiceConfig;
  private serverManager: LSPServerManager;
  private diagnosticRegistry: LSPDiagnosticRegistry;

  constructor(config: LSPServiceConfig = {}) {
    this.config = {
      enableDiagnostics: true,
      enableSymbols: true,
      enableCompletion: true,
      enableFormatting: true,
      maxServers: 5,
      ...config,
    };

    this.serverManager = new LSPServerManager();
    this.diagnosticRegistry = new LSPDiagnosticRegistry();

    logger.info("[LSPService] Initialized with config:", this.config);
  }

  /**
   * Initialize LSP for a document
   */
  async initializeDocument(filePath: string): Promise<boolean> {
    try {
      await this.serverManager.ensureServerForFile(filePath);
      logger.info(`[LSPService] Initialized LSP for: ${filePath}`);
      return true;
    } catch (error) {
      logger.warn(`[LSPService] Failed to initialize LSP for ${filePath}: ${error}`);
      return false;
    }
  }

  /**
   * Get symbols for a document
   */
  async getDocumentSymbols(filePath: string): Promise<LSPDocumentSymbol[]> {
    if (!this.config.enableSymbols) {
      return [];
    }

    try {
      const server = await this.serverManager.getServerForFile(filePath);
      if (!server) {
        return [];
      }

      // This would call the actual LSP documentSymbol request
      // For now, return empty array as placeholder
      return [];
    } catch (error) {
      logger.warn(`[LSPService] Failed to get symbols for ${filePath}: ${error}`);
      return [];
    }
  }

  /**
   * Get diagnostics for a document
   */
  async getDiagnostics(filePath: string): Promise<LSPDiagnostic[]> {
    if (!this.config.enableDiagnostics) {
      return [];
    }

    try {
      const diagnostics = this.diagnosticRegistry.getDiagnostics(filePath);
      return diagnostics.map((d) => ({
        range: d.range,
        severity: d.severity,
        message: d.message,
        source: d.source,
      }));
    } catch (error) {
      logger.warn(`[LSPService] Failed to get diagnostics for ${filePath}: ${error}`);
      return [];
    }
  }

  /**
   * Format a document
   */
  async formatDocument(filePath: string): Promise<string | null> {
    if (!this.config.enableFormatting) {
      return null;
    }

    try {
      const server = await this.serverManager.getServerForFile(filePath);
      if (!server) {
        return null;
      }

      // This would call the actual LSP formatting request
      // For now, return null as placeholder
      return null;
    } catch (error) {
      logger.warn(`[LSPService] Failed to format ${filePath}: ${error}`);
      return null;
    }
  }

  /**
   * Get hover information
   */
  async getHover(
    filePath: string,
    line: number,
    character: number
  ): Promise<string | null> {
    try {
      const server = await this.serverManager.getServerForFile(filePath);
      if (!server) {
        return null;
      }

      // This would call the actual LSP hover request
      // For now, return null as placeholder
      return null;
    } catch (error) {
      logger.warn(`[LSPService] Failed to get hover info: ${error}`);
      return null;
    }
  }

  /**
   * Go to definition
   */
  async getDefinition(
    filePath: string,
    line: number,
    character: number
  ): Promise<{ file: string; line: number; character: number } | null> {
    try {
      const server = await this.serverManager.getServerForFile(filePath);
      if (!server) {
        return null;
      }

      // This would call the actual LSP definition request
      // For now, return null as placeholder
      return null;
    } catch (error) {
      logger.warn(`[LSPService] Failed to get definition: ${error}`);
      return null;
    }
  }

  /**
   * Find references
   */
  async getReferences(
    filePath: string,
    line: number,
    character: number
  ): Promise<Array<{ file: string; line: number; character: number }>> {
    try {
      const server = await this.serverManager.getServerForFile(filePath);
      if (!server) {
        return [];
      }

      // This would call the actual LSP references request
      // For now, return empty array as placeholder
      return [];
    } catch (error) {
      logger.warn(`[LSPService] Failed to get references: ${error}`);
      return [];
    }
  }

  /**
   * Shutdown LSP service
   */
  async shutdown(): Promise<void> {
    try {
      await this.serverManager.shutdown();
      logger.info("[LSPService] Shutdown complete");
    } catch (error) {
      logger.warn(`[LSPService] Shutdown error: ${error}`);
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultService: LSPService | null = null;

/**
 * Get or create the default LSP service
 */
export function getLSPService(config?: LSPServiceConfig): LSPService {
  if (!defaultService) {
    defaultService = new LSPService(config);
  }
  return defaultService;
}

/**
 * Create a new LSP service with custom config
 */
export function createLSPService(config: LSPServiceConfig): LSPService {
  return new LSPService(config);
}

// ============================================================================
// Re-exports
// ============================================================================

export type { LSPServiceConfig, LSPDocumentSymbol, LSPDiagnostic };
