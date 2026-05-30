/**
 * MCP Server Approval Service for pakalon-cli
 *
 * Handles MCP server approval workflows and pending server management.
 */

import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type MCPServerStatus = "pending" | "approved" | "rejected" | "unknown";

export type MCPServerApproval = {
  serverName: string;
  status: MCPServerStatus;
  requestedAt: Date;
  resolvedAt?: Date;
};

// ============================================================================
// MCP Server Approval Service
// ============================================================================

class MCPServerApprovalService {
  private approvals: Map<string, MCPServerApproval> = new Map();

  /**
   * Request approval for an MCP server
   */
  requestApproval(serverName: string): void {
    this.approvals.set(serverName, {
      serverName,
      status: "pending",
      requestedAt: new Date(),
    });
    logger.info(`[MCPApproval] Approval requested for: ${serverName}`);
  }

  /**
   * Approve an MCP server
   */
  approve(serverName: string): void {
    const existing = this.approvals.get(serverName);
    this.approvals.set(serverName, {
      serverName,
      status: "approved",
      requestedAt: existing?.requestedAt ?? new Date(),
      resolvedAt: new Date(),
    });
    logger.info(`[MCPApproval] Approved: ${serverName}`);
  }

  /**
   * Reject an MCP server
   */
  reject(serverName: string): void {
    const existing = this.approvals.get(serverName);
    this.approvals.set(serverName, {
      serverName,
      status: "rejected",
      requestedAt: existing?.requestedAt ?? new Date(),
      resolvedAt: new Date(),
    });
    logger.info(`[MCPApproval] Rejected: ${serverName}`);
  }

  /**
   * Get server status
   */
  getStatus(serverName: string): MCPServerStatus {
    return this.approvals.get(serverName)?.status ?? "unknown";
  }

  /**
   * Get all pending approvals
   */
  getPendingApprovals(): MCPServerApproval[] {
    return Array.from(this.approvals.values()).filter(
      (a) => a.status === "pending"
    );
  }

  /**
   * Check if server is approved
   */
  isApproved(serverName: string): boolean {
    return this.getStatus(serverName) === "approved";
  }

  /**
   * Clear all approvals
   */
  clear(): void {
    this.approvals.clear();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultService: MCPServerApprovalService | null = null;

/**
 * Get or create the default MCP Server Approval service
 */
export function getMCPServerApprovalService(): MCPServerApprovalService {
  if (!defaultService) {
    defaultService = new MCPServerApprovalService();
  }
  return defaultService;
}
