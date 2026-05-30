/**
 * Tool Orchestration for pakalon-cli
 *
 * Manages tool execution ordering, dependencies, and parallel execution.
 */

import logger from "@/utils/logger.js";
import { executeTool } from "./toolExecution.js";

// ============================================================================
// Types
// ============================================================================

export type ToolDependency = {
  toolName: string;
  dependsOn: string[];
};

export type OrchestrationResult = {
  toolName: string;
  success: boolean;
  result?: unknown;
  error?: string;
};

// ============================================================================
// Tool Orchestration
// ============================================================================

/**
 * Execute tools in parallel with dependency resolution
 */
export async function executeToolsInParallel<T>(
  tools: Array<{ name: string; input: unknown; fn: () => Promise<T> }>,
  dependencies?: ToolDependency[]
): Promise<OrchestrationResult[]> {
  const results: OrchestrationResult[] = [];
  const executed = new Set<string>();
  const pending = [...tools];

  // Build dependency graph
  const depMap = new Map<string, string[]>();
  if (dependencies) {
    for (const dep of dependencies) {
      depMap.set(dep.toolName, dep.dependsOn);
    }
  }

  // Execute tools respecting dependencies
  while (pending.length > 0) {
    // Find tools that can be executed (all dependencies met)
    const ready = pending.filter((tool) => {
      const deps = depMap.get(tool.name) ?? [];
      return deps.every((dep) => executed.has(dep));
    });

    if (ready.length === 0) {
      // No tools ready - check for circular dependencies
      logger.error("[ToolOrchestration] Circular dependency detected");
      break;
    }

    // Execute ready tools in parallel
    const promises = ready.map(async (tool) => {
      try {
        const { result } = await executeTool(tool.name, tool.input, tool.fn);
        executed.add(tool.name);
        return { toolName: tool.name, success: true, result };
      } catch (error) {
        executed.add(tool.name);
        return {
          toolName: tool.name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const batchResults = await Promise.all(promises);
    results.push(...batchResults);

    // Remove executed tools from pending
    for (const tool of ready) {
      const index = pending.indexOf(tool);
      if (index !== -1) {
        pending.splice(index, 1);
      }
    }
  }

  return results;
}

/**
 * Execute tools sequentially
 */
export async function executeToolsSequentially<T>(
  tools: Array<{ name: string; input: unknown; fn: () => Promise<T> }>
): Promise<OrchestrationResult[]> {
  const results: OrchestrationResult[] = [];

  for (const tool of tools) {
    try {
      const { result } = await executeTool(tool.name, tool.input, tool.fn);
      results.push({ toolName: tool.name, success: true, result });
    } catch (error) {
      results.push({
        toolName: tool.name,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * Execute tool with retry logic
 */
export async function executeWithRetry<T>(
  toolName: string,
  input: unknown,
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await executeTool(toolName, input, fn).then((r) => r.result);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(
        `[ToolOrchestration] ${toolName} failed (attempt ${attempt}/${maxRetries}):`,
        lastError.message
      );

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }

  throw lastError;
}
