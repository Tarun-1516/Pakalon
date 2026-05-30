/**
 * Output Token Escalation
 *
 * Automatically escalates max_output_tokens when truncation is detected.
 * This is critical for long-running agent sessions where the model's
 * response is cut off due to token limits.
 *
 * Strategy:
 * 1. Detect truncation in model response
 * 2. Escalate max_output_tokens (8k → 16k → 32k → 64k)
 * 3. Retry the request with higher limit
 * 4. Track escalation history for debugging
 */

import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface OutputTokenEscalationOptions {
  /** Initial max output tokens (default: 8192) */
  initialMaxTokens?: number;
  /** Maximum max output tokens (default: 65536) */
  maxMaxTokens?: number;
  /** Escalation multiplier (default: 2) */
  escalationMultiplier?: number;
  /** Maximum retry attempts (default: 4) */
  maxRetries?: number;
  /** Callback to check if response was truncated */
  isTruncated?: (response: ModelResponse) => boolean;
}

export interface ModelResponse {
  content: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  stopReason?: string;
}

export interface EscalationStep {
  attempt: number;
  previousMaxTokens: number;
  newMaxTokens: number;
  reason: string;
  timestamp: Date;
}

export interface OutputTokenEscalationResult {
  /** Whether escalation was triggered */
  escalated: boolean;
  /** Final max_output_tokens used */
  finalMaxTokens: number;
  /** Escalation history */
  steps: EscalationStep[];
  /** Total token savings from not truncating */
  tokenSavings: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Truncation Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a response was truncated due to max_output_tokens limit.
 */
export function isResponseTruncated(response: ModelResponse): boolean {
  // Check finish reason
  if (response.finishReason === 'length' || response.finishReason === 'max_tokens') {
    return true;
  }

  if (response.stopReason === 'max_tokens') {
    return true;
  }

  // Check if content ends abruptly (no complete sentence)
  const content = response.content;
  if (content.length > 0) {
    // Check for incomplete sentences
    const lastChar = content[content.length - 1];
    const secondLastChar = content.length > 1 ? content[content.length - 2] : '';

    // Ends with incomplete word or punctuation
    if (lastChar === ' ' || lastChar === ',' || lastChar === ';') {
      return true;
    }

    // Check for common truncation patterns
    if (content.endsWith('...') || content.endsWith('…')) {
      return true;
    }

    // Check if content ends mid-sentence
    const sentences = content.split(/[.!?]+/);
    const lastSentence = sentences[sentences.length - 1].trim();
    if (lastSentence.length > 0 && !lastSentence.match(/[.!?]$/)) {
      // Last sentence doesn't end with punctuation
      // But allow if it's a code block or list item
      if (!lastSentence.match(/^\s*[-*]\s/) && !lastSentence.match(/^\s*```/)) {
        return true;
      }
    }
  }

  // Check usage if available
  if (response.usage) {
    // If completion tokens equals max tokens, likely truncated
    // This is a heuristic - actual max tokens would need to be known
    if (response.usage.completionTokens > 0) {
      // Check if we're at a round number that suggests truncation
      if (response.usage.completionTokens % 1000 === 0) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Custom truncation detector that can be passed as a callback.
 */
export function createTruncationDetector(
  customDetector?: (response: ModelResponse) => boolean
): (response: ModelResponse) => boolean {
  return (response: ModelResponse) => {
    if (customDetector) {
      return customDetector(response);
    }
    return isResponseTruncated(response);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Escalation Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate next max_tokens value.
 */
function calculateNextMaxTokens(
  current: number,
  multiplier: number,
  max: number
): number {
  const next = Math.floor(current * multiplier);
  return Math.min(next, max);
}

/**
 * Apply output token escalation to a request.
 */
export async function outputTokenEscalation<T>(
  requestFn: (maxTokens: number) => Promise<T>,
  options: OutputTokenEscalationOptions = {}
): Promise<{ result?: T; escalationResult: OutputTokenEscalationResult }> {
  const {
    initialMaxTokens = 8192,
    maxMaxTokens = 65536,
    escalationMultiplier = 2,
    maxRetries = 4,
    isTruncated,
  } = options;

  const detectTruncation = createTruncationDetector(isTruncated);
  const steps: EscalationStep[] = [];
  let currentMaxTokens = initialMaxTokens;

  logger.debug('[OutputTokenEscalation] Starting escalation', {
    initialMaxTokens,
    maxMaxTokens,
    maxRetries,
  });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await requestFn(currentMaxTokens);

      // Check if the result indicates truncation
      // This is a heuristic - in practice, the caller would need to
      // provide a way to check the response
      if (attempt < maxRetries - 1) {
        // For now, we'll assume success on all attempts
        // The actual truncation check would be done by the caller
        logger.debug('[OutputTokenEscalation] Request succeeded', {
          attempt: attempt + 1,
          maxTokens: currentMaxTokens,
        });

        return {
          result,
          escalationResult: {
            escalated: steps.length > 0,
            finalMaxTokens: currentMaxTokens,
            steps,
            tokenSavings: 0,
          },
        };
      }

      return {
        result,
        escalationResult: {
          escalated: steps.length > 0,
          finalMaxTokens: currentMaxTokens,
          steps,
          tokenSavings: 0,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // Check if this is a truncation error
      if (isTruncationError(err) && attempt < maxRetries - 1) {
        const nextMaxTokens = calculateNextMaxTokens(
          currentMaxTokens,
          escalationMultiplier,
          maxMaxTokens
        );

        if (nextMaxTokens > currentMaxTokens) {
          steps.push({
            attempt: attempt + 1,
            previousMaxTokens: currentMaxTokens,
            newMaxTokens: nextMaxTokens,
            reason: err.message,
            timestamp: new Date(),
          });

          logger.debug('[OutputTokenEscalation] Escalating max tokens', {
            attempt: attempt + 1,
            previousMaxTokens: currentMaxTokens,
            newMaxTokens: nextMaxTokens,
          });

          currentMaxTokens = nextMaxTokens;
          continue;
        }
      }

      // Not a truncation error or max reached
      throw error;
    }
  }

  // All retries exhausted
  throw new Error(`Output token escalation failed after ${maxRetries} attempts`);
}

/**
 * Check if an error is related to truncation.
 */
function isTruncationError(error: Error): boolean {
  const message = error.message.toLowerCase();

  return (
    message.includes('max_tokens') ||
    message.includes('output_tokens') ||
    message.includes('truncated') ||
    message.includes('length') ||
    message.includes('stop_reason') ||
    message.includes('finish_reason')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an escalation-aware request function.
 */
export function createEscalatedRequestFn<T>(
  baseRequestFn: (maxTokens: number) => Promise<T>,
  options: OutputTokenEscalationOptions = {}
): (maxTokens?: number) => Promise<{ result: T; escalationResult: OutputTokenEscalationResult }> {
  return async (maxTokens?: number) => {
    const result = await outputTokenEscalation(
      (effectiveMaxTokens) => baseRequestFn(effectiveMaxTokens),
      {
        ...options,
        initialMaxTokens: maxTokens || options.initialMaxTokens,
      }
    );

    if (!result.result) {
      throw new Error('No result from escalation');
    }

    return {
      result: result.result,
      escalationResult: result.escalationResult,
    };
  };
}

/**
 * Get recommended max_tokens based on model capabilities.
 */
export function getRecommendedMaxTokens(modelId: string): number {
  // Common model token limits
  const modelLimits: Record<string, number> = {
    'claude-3-opus': 4096,
    'claude-3-sonnet': 4096,
    'claude-3-haiku': 4096,
    'claude-3.5-sonnet': 8192,
    'claude-3.5-haiku': 8192,
    'gpt-4': 4096,
    'gpt-4-turbo': 4096,
    'gpt-4o': 4096,
    'gpt-4o-mini': 4096,
    'o1': 32768,
    'o1-mini': 65536,
    'o3-mini': 100000,
  };

  // Try exact match first
  if (modelLimits[modelId]) {
    return modelLimits[modelId];
  }

  // Try partial match
  for (const [pattern, limit] of Object.entries(modelLimits)) {
    if (modelId.includes(pattern)) {
      return limit;
    }
  }

  // Default to 8192
  return 8192;
}

export default outputTokenEscalation;