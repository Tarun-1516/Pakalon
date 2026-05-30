/**
 * Tool Execution utilities for pakalon-cli
 */

import { getToolService, type ToolExecution } from "./index.js";

/**
 * Execute a tool with timing and error handling
 */
export async function executeTool<T>(
  toolName: string,
  input: unknown,
  fn: () => Promise<T>
): Promise<{ result: T; execution: ToolExecution }> {
  const id = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const startTime = new Date();

  try {
    const result = await fn();
    const endTime = new Date();
    const duration = endTime.getTime() - startTime.getTime();

    const execution: ToolExecution = {
      id,
      toolName,
      input,
      output: result,
      startTime,
      endTime,
      duration,
      success: true,
    };

    getToolService().recordExecution(execution);
    return { result, execution };
  } catch (error) {
    const endTime = new Date();
    const duration = endTime.getTime() - startTime.getTime();

    const execution: ToolExecution = {
      id,
      toolName,
      input,
      error: error instanceof Error ? error.message : String(error),
      startTime,
      endTime,
      duration,
      success: false,
    };

    getToolService().recordExecution(execution);
    throw error;
  }
}

/**
 * Create a tool execution wrapper
 */
export function createToolWrapper<TInput, TOutput>(
  toolName: string,
  fn: (input: TInput) => Promise<TOutput>
): (input: TInput) => Promise<TOutput> {
  return async (input: TInput) => {
    const { result } = await executeTool(toolName, input, () => fn(input));
    return result;
  };
}
