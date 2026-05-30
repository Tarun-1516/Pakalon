/**
 * MCP Server Approval
 *
 * Manages approval of MCP servers before they can be used.
 * Provides a UI-agnostic approval flow.
 */

import logger from '@/utils/logger.js';

/**
 * Approval request.
 */
export interface ApprovalRequest {
  id: string;
  serverName: string;
  serverUrl: string;
  requestedAt: number;
  status: 'pending' | 'approved' | 'denied';
}

/**
 * Approval record.
 */
export interface ApprovalRecord {
  request: ApprovalRequest;
  decision: 'approved' | 'denied';
  decidedAt: number;
  reason?: string;
  remember: boolean;
}

/**
 * Manages MCP server approval requests.
 */
export class McpServerApproval {
  private pendingRequests = new Map<string, ApprovalRequest>();
  private approvalHistory: ApprovalRecord[] = [];
  private approvedServers = new Set<string>();

  /**
   * Request approval for an MCP server.
   */
  requestApproval(serverName: string, serverUrl: string): ApprovalRequest {
    const id = `mcp_approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const request: ApprovalRequest = {
      id,
      serverName,
      serverUrl,
      requestedAt: Date.now(),
      status: 'pending',
    };

    this.pendingRequests.set(id, request);
    logger.info('[McpServerApproval] Approval requested', { serverName, serverUrl });
    return request;
  }

  /**
   * Approve a pending request.
   */
  approve(requestId: string, options?: { remember?: boolean }): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) return;

    request.status = 'approved';
    this.pendingRequests.delete(requestId);

    const record: ApprovalRecord = {
      request: { ...request },
      decision: 'approved',
      decidedAt: Date.now(),
      remember: options?.remember ?? true,
    };

    this.approvalHistory.push(record);

    if (record.remember) {
      this.approvedServers.add(request.serverName);
    }

    logger.info('[McpServerApproval] Approved', { serverName: request.serverName });
  }

  /**
   * Deny a pending request.
   */
  deny(requestId: string, reason?: string): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) return;

    request.status = 'denied';
    this.pendingRequests.delete(requestId);

    const record: ApprovalRecord = {
      request: { ...request },
      decision: 'denied',
      decidedAt: Date.now(),
      reason,
      remember: false,
    };

    this.approvalHistory.push(record);
    logger.info('[McpServerApproval] Denied', { serverName: request.serverName, reason });
  }

  /**
   * Check if a server is approved.
   */
  isApproved(serverName: string): boolean {
    return this.approvedServers.has(serverName);
  }

  /**
   * Get all pending requests.
   */
  getPendingRequests(): ApprovalRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  /**
   * Get approval history.
   */
  getApprovalHistory(): ApprovalRecord[] {
    return [...this.approvalHistory];
  }

  /**
   * Clear all approvals.
   */
  clear(): void {
    this.pendingRequests.clear();
    this.approvalHistory = [];
    this.approvedServers.clear();
  }
}

// Singleton instance
let _instance: McpServerApproval | null = null;

/**
 * Get the global MCP server approval manager.
 */
export function getMcpServerApproval(): McpServerApproval {
  if (!_instance) {
    _instance = new McpServerApproval();
  }
  return _instance;
}
