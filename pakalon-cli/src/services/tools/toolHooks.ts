/**
 * Tool Hooks for pakalon-cli
 *
 * Provides pre/post execution hooks for tools.
 */

import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type ToolHook = {
  name: string;
  before?: (toolName: string, input: unknown) => Promise<unknown> | unknown;
  after?: (toolName: string, input: unknown, output: unknown) => Promise<void> | void;
  onError?: (toolName: string, input: unknown, error: Error) => Promise<void> | void;
};

// ============================================================================
// Tool Hooks Manager
// ============================================================================

class ToolHooksManager {
  private hooks: Map<string, ToolHook[]> = new Map();

  /**
   * Register a hook for a specific tool
   */
  register(toolName: string, hook: ToolHook): void {
    const existing = this.hooks.get(toolName) ?? [];
    existing.push(hook);
    this.hooks.set(toolName, existing);
  }

  /**
   * Register a global hook (applies to all tools)
   */
  registerGlobal(hook: ToolHook): void {
    this.register("*", hook);
  }

  /**
   * Get all hooks for a tool
   */
  getHooks(toolName: string): ToolHook[] {
    const toolHooks = this.hooks.get(toolName) ?? [];
    const globalHooks = this.hooks.get("*") ?? [];
    return [...globalHooks, ...toolHooks];
  }

  /**
   * Execute before hooks
   */
  async executeBefore(toolName: string, input: unknown): Promise<unknown> {
    const hooks = this.getHooks(toolName);
    let currentInput = input;

    for (const hook of hooks) {
      if (hook.before) {
        try {
          const result = await hook.before(toolName, currentInput);
          if (result !== undefined) {
            currentInput = result;
          }
        } catch (error) {
          logger.warn(`[ToolHooks] Before hook failed for ${toolName}:`, error);
        }
      }
    }

    return currentInput;
  }

  /**
   * Execute after hooks
   */
  async executeAfter(toolName: string, input: unknown, output: unknown): Promise<void> {
    const hooks = this.getHooks(toolName);

    for (const hook of hooks) {
      if (hook.after) {
        try {
          await hook.after(toolName, input, output);
        } catch (error) {
          logger.warn(`[ToolHooks] After hook failed for ${toolName}:`, error);
        }
      }
    }
  }

  /**
   * Execute error hooks
   */
  async executeOnError(toolName: string, input: unknown, error: Error): Promise<void> {
    const hooks = this.getHooks(toolName);

    for (const hook of hooks) {
      if (hook.onError) {
        try {
          await hook.onError(toolName, input, error);
        } catch (hookError) {
          logger.warn(`[ToolHooks] Error hook failed for ${toolName}:`, hookError);
        }
      }
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultManager: ToolHooksManager | null = null;

/**
 * Get or create the default Tool Hooks manager
 */
export function getToolHooksManager(): ToolHooksManager {
  if (!defaultManager) {
    defaultManager = new ToolHooksManager();
  }
  return defaultManager;
}
