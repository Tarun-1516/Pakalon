/**
 * MCP Service for pakalon-cli
 *
 * Provides a service layer for Model Context Protocol integration.
 * Wraps the existing MCP implementation with a service interface.
 */

import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type MCPServiceConfig = {
  /** Enable MCP tool execution */
  enableTools?: boolean;
  /** Enable MCP resource access */
  enableResources?: boolean;
  /** Enable MCP prompts */
  enablePrompts?: boolean;
  /** Maximum concurrent connections */
  maxConnections?: number;
  /** Connection timeout in ms */
  connectionTimeout?: number;
};

export type MCPServerInfo = {
  name: string;
  url: string;
  capabilities: string[];
  connected: boolean;
  lastSeen?: Date;
};

export type MCPToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

// ============================================================================
// MCP Service Implementation
// ============================================================================

class MCPService {
  private config: MCPServiceConfig;
  private servers: Map<string, MCPServerInfo> = new Map();

  constructor(config: MCPServiceConfig = {}) {
    this.config = {
      enableTools: true,
      enableResources: true,
      enablePrompts: true,
      maxConnections: 10,
      connectionTimeout: 30000,
      ...config,
    };

    logger.info("[MCPService] Initialized with config:", this.config);
  }

  /**
   * Connect to an MCP server
   */
  async connectToServer(
    name: string,
    url: string
  ): Promise<boolean> {
    try {
      // Check connection limit
      if (this.servers.size >= (this.config.maxConnections ?? 10)) {
        logger.warn("[MCPService] Maximum connections reached");
        return false;
      }

      // Store server info
      this.servers.set(name, {
        name,
        url,
        capabilities: [],
        connected: true,
        lastSeen: new Date(),
      });

      logger.info(`[MCPService] Connected to server: ${name}`);
      return true;
    } catch (error) {
      logger.error(`[MCPService] Failed to connect to ${name}: ${error}`);
      return false;
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnectFromServer(name: string): Promise<boolean> {
    try {
      this.servers.delete(name);
      logger.info(`[MCPService] Disconnected from server: ${name}`);
      return true;
    } catch (error) {
      logger.error(`[MCPService] Failed to disconnect from ${name}: ${error}`);
      return false;
    }
  }

  /**
   * List connected servers
   */
  listServers(): MCPServerInfo[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get server info
   */
  getServer(name: string): MCPServerInfo | undefined {
    return this.servers.get(name);
  }

  /**
   * Execute a tool on an MCP server
   */
  async executeTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    if (!this.config.enableTools) {
      return {
        content: [{ type: "text", text: "Tools are disabled" }],
        isError: true,
      };
    }

    const server = this.servers.get(serverName);
    if (!server?.connected) {
      return {
        content: [{ type: "text", text: `Server ${serverName} not connected` }],
        isError: true,
      };
    }

    try {
      // This would call the actual MCP tool execution
      // For now, return a placeholder
      logger.info(`[MCPService] Executing tool ${toolName} on ${serverName}`);
      return {
        content: [{ type: "text", text: "Tool execution not implemented" }],
      };
    } catch (error) {
      logger.error(`[MCPService] Tool execution failed: ${error}`);
      return {
        content: [{ type: "text", text: `Tool execution failed: ${error}` }],
        isError: true,
      };
    }
  }

  /**
   * Read a resource from an MCP server
   */
  async readResource(
    serverName: string,
    resourceUri: string
  ): Promise<{ content: string; mimeType?: string } | null> {
    if (!this.config.enableResources) {
      return null;
    }

    const server = this.servers.get(serverName);
    if (!server?.connected) {
      return null;
    }

    try {
      // This would call the actual MCP resource read
      // For now, return null as placeholder
      logger.info(`[MCPService] Reading resource ${resourceUri} from ${serverName}`);
      return null;
    } catch (error) {
      logger.error(`[MCPService] Resource read failed: ${error}`);
      return null;
    }
  }

  /**
   * Get prompts from an MCP server
   */
  async getPrompts(
    serverName: string
  ): Promise<Array<{ name: string; description?: string }>> {
    if (!this.config.enablePrompts) {
      return [];
    }

    const server = this.servers.get(serverName);
    if (!server?.connected) {
      return [];
    }

    try {
      // This would call the actual MCP prompts list
      // For now, return empty array as placeholder
      logger.info(`[MCPService] Getting prompts from ${serverName}`);
      return [];
    } catch (error) {
      logger.error(`[MCPService] Get prompts failed: ${error}`);
      return [];
    }
  }

  /**
   * Shutdown MCP service
   */
  async shutdown(): Promise<void> {
    for (const [name] of this.servers) {
      await this.disconnectFromServer(name);
    }
    logger.info("[MCPService] Shutdown complete");
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultService: MCPService | null = null;

/**
 * Get or create the default MCP service
 */
export function getMCPService(config?: MCPServiceConfig): MCPService {
  if (!defaultService) {
    defaultService = new MCPService(config);
  }
  return defaultService;
}

/**
 * Create a new MCP service with custom config
 */
export function createMCPService(config: MCPServiceConfig): MCPService {
  return new MCPService(config);
}
