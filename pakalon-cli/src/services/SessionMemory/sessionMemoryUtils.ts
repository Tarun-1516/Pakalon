/**
 * Session Memory utility functions for pakalon-cli.
 * These are separate from the main sessionMemory.ts to avoid circular dependencies.
 */

import { readFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for session memory extraction thresholds
 */
export type SessionMemoryConfig = {
  /** Minimum context window tokens before initializing session memory. */
  minimumMessageTokensToInit: number;
  /** Minimum context window growth (in tokens) between session memory updates. */
  minimumTokensBetweenUpdate: number;
  /** Number of tool calls between session memory updates */
  toolCallsBetweenUpdates: number;
};

// Default configuration values
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,
  minimumTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3,
};

// ============================================================================
// Module State
// ============================================================================

// Current session memory configuration
let sessionMemoryConfig: SessionMemoryConfig = {
  ...DEFAULT_SESSION_MEMORY_CONFIG,
};

// Track the last summarized message ID (shared state)
let lastSummarizedMessageId: string | undefined;

// Track extraction state with timestamp (set by sessionMemory.ts)
let extractionStartedAt: number | undefined;

// Track context size at last memory extraction (for minimumTokensBetweenUpdate)
let tokensAtLastExtraction = 0;

// Track whether session memory has been initialized (met minimumMessageTokensToInit)
let sessionMemoryInitialized = false;

// ============================================================================
// Getters and Setters
// ============================================================================

/**
 * Get the message ID up to which the session memory is current
 */
export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId;
}

/**
 * Set the last summarized message ID (called from sessionMemory.ts)
 */
export function setLastSummarizedMessageId(
  messageId: string | undefined
): void {
  lastSummarizedMessageId = messageId;
}

/**
 * Mark extraction as started (called from sessionMemory.ts)
 */
export function markExtractionStarted(): void {
  extractionStartedAt = Date.now();
}

/**
 * Mark extraction as completed (called from sessionMemory.ts)
 */
export function markExtractionCompleted(): void {
  extractionStartedAt = undefined;
}

/**
 * Check if extraction is currently in progress
 */
export function isExtractionInProgress(): boolean {
  return extractionStartedAt !== undefined;
}

/**
 * Wait for any in-progress session memory extraction to complete (with 15s timeout)
 * Returns immediately if no extraction is in progress or if extraction is stale (>1min old).
 */
export async function waitForSessionMemoryExtraction(): Promise<void> {
  const EXTRACTION_WAIT_TIMEOUT_MS = 15000;
  const EXTRACTION_STALE_THRESHOLD_MS = 60000;
  const startTime = Date.now();

  while (extractionStartedAt) {
    const extractionAge = Date.now() - extractionStartedAt;
    if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) {
      return;
    }

    if (Date.now() - startTime > EXTRACTION_WAIT_TIMEOUT_MS) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Get the session memory directory path
 */
export function getSessionMemoryDir(): string {
  return join(homedir(), ".config", "pakalon", "session-memory");
}

/**
 * Get the session memory file path
 */
export function getSessionMemoryPath(): string {
  return join(getSessionMemoryDir(), "session-memory.md");
}

/**
 * Get the current session memory content
 */
export async function getSessionMemoryContent(): Promise<string | null> {
  const memoryPath = getSessionMemoryPath();

  try {
    const content = await readFile(memoryPath, "utf-8");
    return content;
  } catch {
    return null;
  }
}

/**
 * Ensure the session memory directory exists
 */
export async function ensureSessionMemoryDir(): Promise<void> {
  const dir = getSessionMemoryDir();
  await mkdir(dir, { recursive: true });
}

/**
 * Write session memory content to file
 */
export async function writeSessionMemory(
  content: string
): Promise<void> {
  await ensureSessionMemoryDir();
  const memoryPath = getSessionMemoryPath();
  await writeFile(memoryPath, content, "utf-8");
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Set the session memory configuration
 */
export function setSessionMemoryConfig(
  config: Partial<SessionMemoryConfig>
): void {
  sessionMemoryConfig = {
    ...sessionMemoryConfig,
    ...config,
  };
}

/**
 * Get the current session memory configuration
 */
export function getSessionMemoryConfig(): SessionMemoryConfig {
  return { ...sessionMemoryConfig };
}

/**
 * Record the context size at the time of extraction.
 * Used to measure context growth for minimumTokensBetweenUpdate threshold.
 */
export function recordExtractionTokenCount(currentTokenCount: number): void {
  tokensAtLastExtraction = currentTokenCount;
}

/**
 * Check if session memory has been initialized (met minimumTokensToInit threshold)
 */
export function isSessionMemoryInitialized(): boolean {
  return sessionMemoryInitialized;
}

/**
 * Mark session memory as initialized
 */
export function markSessionMemoryInitialized(): void {
  sessionMemoryInitialized = true;
}

/**
 * Check if we've met the threshold to initialize session memory.
 * Uses total context window tokens for consistent behavior.
 */
export function hasMetInitializationThreshold(
  currentTokenCount: number
): boolean {
  return currentTokenCount >= sessionMemoryConfig.minimumMessageTokensToInit;
}

/**
 * Check if we've met the threshold for the next update.
 * Measures actual context window growth since last extraction.
 */
export function hasMetUpdateThreshold(currentTokenCount: number): boolean {
  const tokensSinceLastExtraction = currentTokenCount - tokensAtLastExtraction;
  return (
    tokensSinceLastExtraction >= sessionMemoryConfig.minimumTokensBetweenUpdate
  );
}

/**
 * Get the configured number of tool calls between updates
 */
export function getToolCallsBetweenUpdates(): number {
  return sessionMemoryConfig.toolCallsBetweenUpdates;
}

/**
 * Reset session memory state (useful for testing)
 */
export function resetSessionMemoryState(): void {
  sessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG };
  tokensAtLastExtraction = 0;
  sessionMemoryInitialized = false;
  lastSummarizedMessageId = undefined;
  extractionStartedAt = undefined;
}
