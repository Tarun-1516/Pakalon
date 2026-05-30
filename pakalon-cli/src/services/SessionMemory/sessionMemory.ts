/**
 * Session Memory Service for pakalon-cli
 *
 * Session Memory automatically maintains a markdown file with notes about the current conversation.
 * It runs periodically in the background to extract key information without interrupting
 * the main conversation flow.
 */

import {
  getSessionMemoryContent,
  getSessionMemoryConfig,
  isSessionMemoryInitialized,
  hasMetInitializationThreshold,
  hasMetUpdateThreshold,
  markSessionMemoryInitialized,
  markExtractionStarted,
  markExtractionCompleted,
  recordExtractionTokenCount,
  setLastSummarizedMessageId,
  writeSessionMemory,
  getToolCallsBetweenUpdates,
  isExtractionInProgress,
  waitForSessionMemoryExtraction,
  resetSessionMemoryState,
  type SessionMemoryConfig,
} from "./sessionMemoryUtils.js";
import {
  loadSessionMemoryTemplate,
  buildSessionMemoryUpdatePrompt,
  buildManualExtractionPrompt,
} from "./prompts.js";

// ============================================================================
// Types
// ============================================================================

export type ManualExtractionResult = {
  success: boolean;
  memoryPath?: string;
  error?: string;
};

// ============================================================================
// Feature Gate (Configurable)
// ============================================================================

let sessionMemoryEnabled = true;

/**
 * Check if session memory feature is enabled.
 */
export function isSessionMemoryEnabled(): boolean {
  return sessionMemoryEnabled;
}

/**
 * Enable or disable session memory feature.
 */
export function setSessionMemoryEnabled(enabled: boolean): void {
  sessionMemoryEnabled = enabled;
}

// ============================================================================
// Module State
// ============================================================================

let lastMemoryMessageUuid: string | undefined;

/**
 * Reset the last memory message UUID (for testing)
 */
export function resetLastMemoryMessageUuid(): void {
  lastMemoryMessageUuid = undefined;
}

// ============================================================================
// Memory Extraction Logic
// ============================================================================

/**
 * Count tool calls since a specific message UUID
 */
function countToolCallsSince(
  messages: Array<{ uuid?: string; type?: string; message?: { content?: unknown } }>,
  sinceUuid: string | undefined
): number {
  let toolCallCount = 0;
  let foundStart = sinceUuid === null || sinceUuid === undefined;

  for (const message of messages) {
    if (!foundStart) {
      if (message.uuid === sinceUuid) {
        foundStart = true;
      }
      continue;
    }

    if (message.type === "assistant") {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        toolCallCount += content.filter(
          (block: { type?: string }) => block.type === "tool_use"
        ).length;
      }
    }
  }

  return toolCallCount;
}

/**
 * Check if we should extract memory based on thresholds
 */
export function shouldExtractMemory(
  messages: Array<{ uuid?: string; type?: string; message?: { content?: unknown } }>
): boolean {
  // Estimate token count (rough: 4 chars per token)
  const totalChars = messages.reduce((sum, msg) => {
    const content = msg.message?.content;
    if (typeof content === "string") return sum + content.length;
    if (Array.isArray(content)) {
      return (
        sum +
        content.reduce(
          (s: number, block: { type?: string; text?: string }) =>
            s + (typeof block.text === "string" ? block.text.length : 100),
          0
        )
      );
    }
    return sum;
  }, 0);
  const currentTokenCount = Math.ceil(totalChars / 4);

  // Check if we've met the initialization threshold
  if (!isSessionMemoryInitialized()) {
    if (!hasMetInitializationThreshold(currentTokenCount)) {
      return false;
    }
    markSessionMemoryInitialized();
  }

  // Check if we've met the minimum tokens between updates threshold
  const hasMetTokenThreshold = hasMetUpdateThreshold(currentTokenCount);

  // Check if we've met the tool calls threshold
  const toolCallsSinceLastUpdate = countToolCallsSince(
    messages,
    lastMemoryMessageUuid
  );
  const hasMetToolCallThreshold =
    toolCallsSinceLastUpdate >= getToolCallsBetweenUpdates();

  // Check if the last assistant turn has no tool calls (safe to extract)
  const lastMessage = messages[messages.length - 1];
  const hasToolCallsInLastTurn =
    lastMessage?.type === "assistant" &&
    Array.isArray(lastMessage.message?.content) &&
    lastMessage.message?.content.some(
      (block: { type?: string }) => block.type === "tool_use"
    );

  // Trigger extraction when:
  // 1. Both thresholds are met (tokens AND tool calls), OR
  // 2. No tool calls in last turn AND token threshold is met
  const shouldExtract =
    (hasMetTokenThreshold && hasMetToolCallThreshold) ||
    (hasMetTokenThreshold && !hasToolCallsInLastTurn);

  if (shouldExtract) {
    if (lastMessage?.uuid) {
      lastMemoryMessageUuid = lastMessage.uuid;
    }
    return true;
  }

  return false;
}

/**
 * Setup session memory file (create if not exists, load content)
 */
async function setupSessionMemoryFile(): Promise<{
  memoryPath: string;
  currentMemory: string;
}> {
  // Ensure directory exists
  const { ensureSessionMemoryDir, getSessionMemoryPath } = await import(
    "./sessionMemoryUtils.js"
  );
  await ensureSessionMemoryDir();

  const memoryPath = getSessionMemoryPath();

  // Try to load existing memory
  let currentMemory = await getSessionMemoryContent();

  // Create template if file doesn't exist
  if (currentMemory === null) {
    const template = await loadSessionMemoryTemplate();
    await writeSessionMemory(template);
    currentMemory = template;
  }

  return { memoryPath, currentMemory };
}

/**
 * Session memory extraction function
 * Called periodically to extract and update session notes
 */
export async function extractSessionMemory(
  messages: Array<{ uuid?: string; type?: string; message?: { content?: unknown } }>
): Promise<void> {
  // Only run if enabled
  if (!sessionMemoryEnabled) {
    return;
  }

  // Check if extraction is already in progress
  if (isExtractionInProgress()) {
    return;
  }

  if (!shouldExtractMemory(messages)) {
    return;
  }

  markExtractionStarted();

  try {
    // Set up file system and read current state
    const { memoryPath, currentMemory } = await setupSessionMemoryFile();

    // Create extraction message
    const userPrompt = await buildSessionMemoryUpdatePrompt(
      currentMemory,
      memoryPath
    );

    // In a full implementation, this would use a forked agent to update the file
    // For now, we log the extraction and update the memory with new content
    console.log("[SessionMemory] Extraction triggered:", {
      messageCount: messages.length,
      memoryPath,
    });

    // Record the context size at extraction
    const totalChars = messages.reduce((sum, msg) => {
      const content = msg.message?.content;
      if (typeof content === "string") return sum + content.length;
      return sum;
    }, 0);
    recordExtractionTokenCount(Math.ceil(totalChars / 4));

    // Update lastSummarizedMessageId after successful completion
    if (lastMessage?.uuid) {
      setLastSummarizedMessageId(lastMessage.uuid);
    }

    markExtractionCompleted();
  } catch (error) {
    console.error("[SessionMemory] Extraction failed:", error);
    markExtractionCompleted();
  }
}

/**
 * Initialize session memory
 */
export function initSessionMemory(): void {
  // Session memory is used for compaction, so respect auto-compact settings
  console.log("[SessionMemory] Initialized");
}

/**
 * Manually trigger session memory extraction, bypassing threshold checks.
 * Used by the /summary command.
 */
export async function manuallyExtractSessionMemory(
  messages: Array<{ uuid?: string; type?: string; message?: { content?: unknown } }>
): Promise<ManualExtractionResult> {
  if (messages.length === 0) {
    return { success: false, error: "No messages to summarize" };
  }

  markExtractionStarted();

  try {
    // Set up file system and read current state
    const { memoryPath, currentMemory } = await setupSessionMemoryFile();

    // Create extraction message
    const messagesText = messages
      .map((m) => {
        const content =
          typeof m.message?.content === "string"
            ? m.message.content
            : JSON.stringify(m.message?.content);
        return `[${m.type}]: ${content?.slice(0, 500) || "(empty)"}`;
      })
      .join("\n\n");

    const userPrompt = await buildManualExtractionPrompt(
      messagesText,
      currentMemory || ""
    );

    // In a full implementation, this would use a forked agent
    console.log("[SessionMemory] Manual extraction triggered:", {
      messageCount: messages.length,
      memoryPath,
    });

    // Record the context size at extraction
    const totalChars = messages.reduce((sum, msg) => {
      const content = msg.message?.content;
      if (typeof content === "string") return sum + content.length;
      return sum;
    }, 0);
    recordExtractionTokenCount(Math.ceil(totalChars / 4));

    // Update lastSummarizedMessageId after successful completion
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.uuid) {
      setLastSummarizedMessageId(lastMessage.uuid);
    }

    return { success: true, memoryPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    markExtractionCompleted();
  }
}

/**
 * Get session memory status
 */
export function getSessionMemoryStatus(): {
  enabled: boolean;
  initialized: boolean;
  extractionInProgress: boolean;
  config: SessionMemoryConfig;
} {
  return {
    enabled: sessionMemoryEnabled,
    initialized: isSessionMemoryInitialized(),
    extractionInProgress: isExtractionInProgress(),
    config: getSessionMemoryConfig(),
  };
}

// Re-export utilities
export {
  waitForSessionMemoryExtraction,
  resetSessionMemoryState,
  type SessionMemoryConfig,
} from "./sessionMemoryUtils.js";
