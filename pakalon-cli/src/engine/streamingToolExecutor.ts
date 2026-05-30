/**
 * Streaming Tool Executor
 *
 * Enables parallel tool execution during streaming. Instead of waiting
 * for the full response before executing tools, this executor runs tools
 * as soon as they appear in the stream.
 *
 * Strategy:
 * 1. Parse tool calls from stream chunks
 * 2. Execute tools in parallel as they arrive
 * 3. Collect results and inject back into context
 * 4. Handle concurrency limits and error recovery
 */

import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamingToolExecutorOptions {
  /** Maximum concurrent tool executions (default: 5) */
  maxConcurrency?: number;
  /** Timeout per tool call in ms (default: 60000) */
  toolTimeout?: number;
  /** Whether to continue on tool error (default: true) */
  continueOnError?: boolean;
  /** Callback for tool progress updates */
  onProgress?: (update: ToolProgressUpdate) => void;
  /** Callback for tool completion */
  onComplete?: (result: ToolExecutionResult) => void;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolExecutionResult {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs: number;
  status: 'success' | 'error' | 'timeout';
}

export interface ToolProgressUpdate {
  id: string;
  name: string;
  status: 'started' | 'completed' | 'error' | 'timeout';
  result?: unknown;
  error?: string;
}

export interface StreamChunk {
  type: 'text' | 'tool_use' | 'thinking' | 'error';
  text?: string;
  toolCall?: ToolCall;
  thinking?: string;
  error?: string;
}

export interface ToolExecutor {
  execute: (tool: ToolCall) => Promise<ToolExecutionResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency Manager
// ─────────────────────────────────────────────────────────────────────────────

class ConcurrencyManager {
  private running = new Set<string>();
  private queue: Array<() => void> = [];
  private maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  async acquire(id: string): Promise<void> {
    if (this.running.size < this.maxConcurrency) {
      this.running.add(id);
      return;
    }

    // Wait for a slot to open
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running.add(id);
        resolve();
      });
    });
  }

  release(id: string): void {
    this.running.delete(id);
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }

  get activeCount(): number {
    return this.running.size;
  }

  get waitingCount(): number {
    return this.queue.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming Tool Executor
// ─────────────────────────────────────────────────────────────────────────────

export class StreamingToolExecutor {
  private options: Required<StreamingToolExecutorOptions>;
  private concurrencyManager: ConcurrencyManager;
  private pendingTools = new Map<string, ToolCall>();
  private results = new Map<string, ToolExecutionResult>();
  private executor: ToolExecutor;

  constructor(
    executor: ToolExecutor,
    options: StreamingToolExecutorOptions = {}
  ) {
    this.options = {
      maxConcurrency: 5,
      toolTimeout: 60000,
      continueOnError: true,
      onProgress: () => {},
      onComplete: () => {},
      ...options,
    };

    this.concurrencyManager = new ConcurrencyManager(
      this.options.maxConcurrency
    );
    this.executor = executor;
  }

  /**
   * Process a stream chunk and execute tools as they arrive.
   */
  async processChunk(chunk: StreamChunk): Promise<void> {
    if (chunk.type === 'tool_use' && chunk.toolCall) {
      const toolCall = chunk.toolCall;
      this.pendingTools.set(toolCall.id, toolCall);

      // Execute tool immediately in parallel
      this.executeToolAsync(toolCall);
    }
  }

  /**
   * Execute a tool asynchronously.
   */
  private async executeToolAsync(toolCall: ToolCall): Promise<void> {
    const { id, name, args } = toolCall;

    // Acquire concurrency slot
    await this.concurrencyManager.acquire(id);

    this.options.onProgress({
      id,
      name,
      status: 'started',
    });

    const startTime = Date.now();

    try {
      // Execute with timeout
      const result = await Promise.race([
        this.executor.execute(toolCall),
        this.createTimeoutPromise(id, name),
      ]);

      const executionResult: ToolExecutionResult = {
        id,
        name,
        args,
        result: (result as ToolExecutionResult).result,
        error: (result as ToolExecutionResult).error,
        durationMs: Date.now() - startTime,
        status: (result as ToolExecutionResult).status || 'success',
      };

      this.results.set(id, executionResult);
      this.pendingTools.delete(id);

      this.options.onProgress({
        id,
        name,
        status: 'completed',
        result: executionResult.result,
      });

      this.options.onComplete(executionResult);
    } catch (error) {
      const executionResult: ToolExecutionResult = {
        id,
        name,
        args,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        status: 'error',
      };

      this.results.set(id, executionResult);
      this.pendingTools.delete(id);

      this.options.onProgress({
        id,
        name,
        status: 'error',
        error: executionResult.error,
      });

      this.options.onComplete(executionResult);

      if (!this.options.continueOnError) {
        throw error;
      }
    } finally {
      this.concurrencyManager.release(id);
    }
  }

  /**
   * Create a timeout promise for tool execution.
   */
  private createTimeoutPromise(id: string, name: string): Promise<ToolExecutionResult> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool ${name} (${id}) timed out after ${this.options.toolTimeout}ms`));
      }, this.options.toolTimeout);
    });
  }

  /**
   * Wait for all pending tools to complete.
   */
  async waitForAll(): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];

    while (this.pendingTools.size > 0) {
      // Wait a bit for tools to complete
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Collect all results
    for (const result of this.results.values()) {
      results.push(result);
    }

    return results;
  }

  /**
   * Get results for specific tool call IDs.
   */
  getResults(ids: string[]): ToolExecutionResult[] {
    return ids
      .map(id => this.results.get(id))
      .filter((result): result is ToolExecutionResult => result !== undefined);
  }

  /**
   * Check if all tools have completed.
   */
  get isComplete(): boolean {
    return this.pendingTools.size === 0;
  }

  /**
   * Get count of pending tools.
   */
  get pendingCount(): number {
    return this.pendingTools.size;
  }

  /**
   * Get count of active executions.
   */
  get activeCount(): number {
    return this.concurrencyManager.activeCount;
  }

  /**
   * Clear all results and pending tools.
   */
  clear(): void {
    this.pendingTools.clear();
    this.results.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream Processor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a stream of chunks and execute tools in parallel.
 */
export async function processStreamWithTools(
  stream: AsyncIterable<StreamChunk>,
  executor: ToolExecutor,
  options: StreamingToolExecutorOptions = {}
): Promise<{
  textChunks: string[];
  toolResults: ToolExecutionResult[];
  thinkingChunks: string[];
}> {
  const toolExecutor = new StreamingToolExecutor(executor, options);
  const textChunks: string[] = [];
  const thinkingChunks: string[] = [];

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text':
        if (chunk.text) {
          textChunks.push(chunk.text);
        }
        break;
      case 'tool_use':
        await toolExecutor.processChunk(chunk);
        break;
      case 'thinking':
        if (chunk.thinking) {
          thinkingChunks.push(chunk.thinking);
        }
        break;
      case 'error':
        if (chunk.error) {
          logger.error('[StreamingToolExecutor] Stream error', {
            error: chunk.error,
          });
        }
        break;
    }
  }

  // Wait for all tools to complete
  const toolResults = await toolExecutor.waitForAll();

  return {
    textChunks,
    toolResults,
    thinkingChunks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a streaming tool executor.
 */
export function createStreamingToolExecutor(
  executor: ToolExecutor,
  options: StreamingToolExecutorOptions = {}
): StreamingToolExecutor {
  return new StreamingToolExecutor(executor, options);
}

export default StreamingToolExecutor;