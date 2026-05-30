import type { Message } from "@/types/message.js";

export interface TokenEstimationConfig {
  charTokensRatio?: number;
  messageOverhead?: number;
}

const DEFAULT_RATIO = 4;
const DEFAULT_MESSAGE_OVERHEAD = 4;

export function normalizeContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
          if (typeof record.type === "string" && record.type.includes("tool")) return JSON.stringify(record).slice(0, 2_000);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    return JSON.stringify(record);
  }
  return content === undefined || content === null ? "" : String(content);
}

export function estimateTextTokens(text: string, config: TokenEstimationConfig = {}): number {
  if (!text) return 0;
  const ratio = config.charTokensRatio ?? DEFAULT_RATIO;
  return Math.ceil(text.length / Math.max(1, ratio));
}

export function estimateToolResultTokens(result: unknown, config: TokenEstimationConfig = {}): number {
  return estimateTextTokens(normalizeContentToText(result), config);
}

export function estimateMessageTokens(message: Message, config: TokenEstimationConfig = {}): number {
  const content = normalizeContentToText((message as { content?: unknown }).content);
  return estimateTextTokens(content, config) + (config.messageOverhead ?? DEFAULT_MESSAGE_OVERHEAD);
}

export function estimateMessagesTokens(messages: readonly Message[], config: TokenEstimationConfig = {}): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message, config), 0);
}

// ============================================================================
// Enhanced Token Estimation (from reference)
// ============================================================================

/**
 * Returns an estimated bytes-per-token ratio for a given file extension.
 * Dense JSON has many single-character tokens (`{`, `}`, `:`, `,`, `"`)
 * which makes the real ratio closer to 2 rather than the default 4.
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension.toLowerCase()) {
    case "json":
    case "jsonl":
    case "jsonc":
      return 2;
    case "xml":
    case "yaml":
    case "yml":
      return 3;
    default:
      return DEFAULT_RATIO;
  }
}

/**
 * Like {@link estimateTextTokens} but uses a more accurate
 * bytes-per-token ratio when the file type is known.
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string
): number {
  return estimateTextTokens(content, {
    charTokensRatio: bytesPerTokenForFileType(fileExtension),
  });
}

/**
 * Estimates token count for a Message object by extracting and analyzing its text content.
 * This provides a more reliable estimate for messages that may have been compacted.
 */
export function roughTokenCountEstimationForMessage(message: {
  type: string;
  message?: { content?: unknown };
  attachment?: unknown;
}): number {
  if (
    (message.type === "assistant" || message.type === "user") &&
    message.message?.content
  ) {
    return roughTokenCountEstimationForContent(message.message.content);
  }

  if (message.type === "attachment" && message.attachment) {
    const content = normalizeContentToText(message.attachment);
    return estimateTextTokens(content);
  }

  return 0;
}

/**
 * Estimates token count for an array of messages.
 */
export function roughTokenCountEstimationForMessages(
  messages: readonly {
    type: string;
    message?: { content?: unknown };
    attachment?: unknown;
  }[]
): number {
  let totalTokens = 0;
  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForMessage(message);
  }
  return totalTokens;
}

/**
 * Estimate token count for content blocks (string, array of blocks, etc.)
 */
function roughTokenCountEstimationForContent(
  content:
    | string
    | Array<{ type?: string; text?: string; content?: unknown; name?: string; input?: unknown; thinking?: string; data?: string }>
    | undefined
): number {
  if (!content) {
    return 0;
  }
  if (typeof content === "string") {
    return estimateTextTokens(content);
  }
  let totalTokens = 0;
  for (const block of content) {
    totalTokens += roughTokenCountEstimationForBlock(block);
  }
  return totalTokens;
}

/**
 * Estimate token count for a single content block
 */
function roughTokenCountEstimationForBlock(
  block: string | { type?: string; text?: string; content?: unknown; name?: string; input?: unknown; thinking?: string; data?: string }
): number {
  if (typeof block === "string") {
    return estimateTextTokens(block);
  }
  if (block.type === "text" && typeof block.text === "string") {
    return estimateTextTokens(block.text);
  }
  if (block.type === "image" || block.type === "document") {
    // Images are resized to max 2000x2000 (5333 tokens)
    return 2000;
  }
  if (block.type === "tool_result") {
    return roughTokenCountEstimationForContent(
      block.content as string | Array<{ type?: string; text?: string }> | undefined
    );
  }
  if (block.type === "tool_use") {
    return estimateTextTokens(
      (block.name ?? "") + JSON.stringify(block.input ?? {})
    );
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return estimateTextTokens(block.thinking);
  }
  if (block.type === "redacted_thinking" && typeof block.data === "string") {
    return estimateTextTokens(block.data);
  }
  // Default: stringify and estimate
  return estimateTextTokens(JSON.stringify(block));
}

/**
 * Count tokens using API (placeholder for future implementation)
 * Returns null if API is not available
 */
export async function countTokensWithAPI(
  _content: string
): Promise<number | null> {
  // Placeholder - in a full implementation, this would call the model's API
  return null;
}

/**
 * Count tokens for messages using API (placeholder for future implementation)
 */
export async function countMessagesTokensWithAPI(
  _messages: unknown[],
  _tools: unknown[]
): Promise<number | null> {
  // Placeholder - in a full implementation, this would call the model's API
  return null;
}
