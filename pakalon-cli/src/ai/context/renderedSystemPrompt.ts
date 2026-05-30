/**
 * Rendered System Prompt
 *
 * Tracks the frozen system prompt bytes for prompt cache optimization.
 * When a fork subagent uses the same system prompt prefix, the API can
 * return cached responses for the shared prefix.
 */

import * as crypto from 'crypto';

/**
 * Tracks the frozen system prompt for cache sharing.
 */
export class RenderedSystemPrompt {
  private prompt: string | null = null;
  private tokenCount: number = 0;
  private frozenAt: number | null = null;
  private promptHash: string | null = null;

  /**
   * Freeze the system prompt (snapshot for cache sharing).
   */
  freeze(prompt: string, tokenCount: number): void {
    this.prompt = prompt;
    this.tokenCount = tokenCount;
    this.frozenAt = Date.now();
    this.promptHash = this.computeHash(prompt);
  }

  /**
   * Get the frozen prompt.
   */
  getFrozenPrompt(): string | null {
    return this.prompt;
  }

  /**
   * Get the token count.
   */
  getTokenCount(): number {
    return this.tokenCount;
  }

  /**
   * Check if a prompt is currently frozen.
   */
  isFrozen(): boolean {
    return this.prompt !== null;
  }

  /**
   * Unfreeze the prompt.
   */
  unfreeze(): void {
    this.prompt = null;
    this.tokenCount = 0;
    this.frozenAt = null;
    this.promptHash = null;
  }

  /**
   * Get the prompt hash (SHA-256 of first 500 chars).
   */
  getPromptHash(): string | null {
    return this.promptHash;
  }

  /**
   * Get when the prompt was frozen.
   */
  getFrozenAt(): Date | null {
    return this.frozenAt ? new Date(this.frozenAt) : null;
  }

  /**
   * Check if this prompt is compatible with another (for cache sharing).
   * Two prompts are compatible if their first 500 characters match.
   */
  isCompatibleWith(other: RenderedSystemPrompt): boolean {
    if (!this.prompt || !other.prompt) return false;
    return this.promptHash === other.promptHash;
  }

  /**
   * Get cache info for display.
   */
  getCacheInfo(): {
    isFrozen: boolean;
    tokenCount: number;
    promptHash: string | null;
    frozenAt: string | null;
    first500chars: string | null;
  } {
    return {
      isFrozen: this.isFrozen(),
      tokenCount: this.tokenCount,
      promptHash: this.promptHash,
      frozenAt: this.frozenAt ? new Date(this.frozenAt).toISOString() : null,
      first500chars: this.prompt?.slice(0, 500) ?? null,
    };
  }

  /**
   * Compute SHA-256 hash of the first 500 characters.
   */
  private computeHash(prompt: string): string {
    const prefix = prompt.slice(0, 500);
    return crypto.createHash('sha256').update(prefix).digest('hex').slice(0, 16);
  }
}
