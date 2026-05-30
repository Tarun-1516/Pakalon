/**
 * Streaming Tool Executor for pakalon-cli
 *
 * Executes tools with streaming output support.
 */

import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type StreamChunk<T = unknown> = {
  type: "data" | "error" | "done";
  data?: T;
  error?: string;
};

export type StreamingToolExecutor<TInput, TOutput> = {
  execute: (input: TInput) => AsyncGenerator<StreamChunk<TOutput>>;
};

// ============================================================================
// Streaming Tool Executor
// ============================================================================

/**
 * Create a streaming tool executor
 */
export function createStreamingExecutor<TInput, TOutput>(
  toolName: string,
  fn: (input: TInput) => AsyncGenerator<TOutput>
): StreamingToolExecutor<TInput, TOutput> {
  return {
    async *execute(input: TInput) {
      try {
        const generator = fn(input);

        for await (const chunk of generator) {
          yield { type: "data" as const, data: chunk };
        }

        yield { type: "done" as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[StreamingExecutor] ${toolName} failed:`, message);
        yield { type: "error" as const, error: message };
      }
    },
  };
}

/**
 * Collect all chunks from a streaming executor
 */
export async function collectStream<T>(
  stream: AsyncGenerator<StreamChunk<T>>
): Promise<T[]> {
  const results: T[] = [];

  for await (const chunk of stream) {
    if (chunk.type === "data" && chunk.data !== undefined) {
      results.push(chunk.data);
    }
    if (chunk.type === "error") {
      throw new Error(chunk.error);
    }
  }

  return results;
}

/**
 * Process streaming output with a callback
 */
export async function processStream<T>(
  stream: AsyncGenerator<StreamChunk<T>>,
  onChunk: (chunk: StreamChunk<T>) => void
): Promise<void> {
  for await (const chunk of stream) {
    onChunk(chunk);
    if (chunk.type === "error") {
      throw new Error(chunk.error);
    }
  }
}
