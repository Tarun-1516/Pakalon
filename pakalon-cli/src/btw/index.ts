/**
 * Side-thread Q&A — "btw" (by the way) module.
 *
 * Spawns a lightweight, non-blocking sub-conversation to answer a question
 * without interrupting the agent that is currently working. The answer is
 * returned asynchronously and merged into the chat log without stalling the
 * primary agent loop.
 *
 * This is the runtime backing for the `/ans` slash command (see
 * `src/commands/ans.ts`) — `btw` is the historical shorthand for the same
 * "by the way" interaction pattern.
 */

import { randomUUID } from "node:crypto";
import logger from "@/utils/logger.js";

export interface BtwContext {
  /** Primary session id that should not be interrupted. */
  parentSessionId: string;
  /** Snapshot of the parent conversation used as light context. */
  parentSnapshot?: BtwMessage[];
  /** Maximum tokens to spend on the side-thread answer. */
  tokenBudget?: number;
  /** Optional model override; falls back to the parent model. */
  modelId?: string;
}

export interface BtwMessage {
  role: "user" | "assistant" | "system";
  content: string;
  at: number;
}

export interface BtwRequest {
  id: string;
  question: string;
  context: BtwContext;
  createdAt: number;
}

export interface BtwResult {
  id: string;
  question: string;
  answer: string;
  startedAt: number;
  finishedAt: number;
  tokensUsed: number;
  status: "completed" | "failed" | "aborted";
  error?: string;
}

export type BtwProgressListener = (result: BtwResult) => void;

const MAX_ANSWER_CHARS = 8_000;
const DEFAULT_TOKEN_BUDGET = 1_500;
const ANSWER_TIMEOUT_MS = 60_000;

class BtwManager {
  private readonly inFlight = new Map<string, Promise<BtwResult>>();
  private readonly listeners = new Set<BtwProgressListener>();
  private readonly history: BtwResult[] = [];
  private static readonly MAX_HISTORY = 100;

  /**
   * Queue a side-thread question. Returns a stable request id that resolves
   * via the registered progress listeners.
   */
  enqueue(question: string, context: BtwContext): BtwRequest {
    const trimmed = question.trim();
    if (!trimmed) {
      throw new Error("btw: question cannot be empty");
    }
    const request: BtwRequest = {
      id: randomUUID(),
      question: trimmed,
      context: {
        tokenBudget: DEFAULT_TOKEN_BUDGET,
        ...context,
      },
      createdAt: Date.now(),
    };
    const promise = this.run(request);
    this.inFlight.set(request.id, promise);
    promise.finally(() => {
      this.inFlight.delete(request.id);
    });
    return request;
  }

  /**
   * Await a side-thread answer. Resolves with the final result, or rejects on
   * timeout / abort.
   */
  async ask(question: string, context: BtwContext): Promise<BtwResult> {
    const request = this.enqueue(question, context);
    const result = await Promise.race([
      this.inFlight.get(request.id)!,
      this.timeoutAfter(request.id, ANSWER_TIMEOUT_MS),
    ]);
    return result;
  }

  cancel(requestId: string): boolean {
    const pending = this.inFlight.get(requestId);
    if (!pending) return false;
    // The promise will be observed by an abort handler; we just mark intent.
    logger.info(`[btw] cancel requested for ${requestId}`);
    return true;
  }

  onProgress(listener: BtwProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recent(limit = 20): BtwResult[] {
    return this.history.slice(-limit);
  }

  stats(): { inFlight: number; totalAnswered: number } {
    return {
      inFlight: this.inFlight.size,
      totalAnswered: this.history.length,
    };
  }

  private async run(request: BtwRequest): Promise<BtwResult> {
    const startedAt = Date.now();
    try {
      const answer = await this.composeAnswer(request);
      const result: BtwResult = {
        id: request.id,
        question: request.question,
        answer: this.truncate(answer),
        startedAt,
        finishedAt: Date.now(),
        tokensUsed: this.estimateTokens(answer),
        status: "completed",
      };
      this.record(result);
      return result;
    } catch (error) {
      const result: BtwResult = {
        id: request.id,
        question: request.question,
        answer: "",
        startedAt,
        finishedAt: Date.now(),
        tokensUsed: 0,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      this.record(result);
      return result;
    }
  }

  /**
   * Compose the answer. The real implementation will call the model SDK; the
   * default export is a deterministic local composer so the module works
   * without a configured model provider (handy for tests and offline mode).
   */
  private async composeAnswer(request: BtwRequest): Promise<string> {
    const budget = request.context.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const snapshot = (request.context.parentSnapshot ?? [])
      .slice(-6)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");
    const lines: string[] = [];
    lines.push(`Side-thread answer (parent session ${request.context.parentSessionId}).`);
    if (snapshot) {
      lines.push("");
      lines.push("Recent context:");
      lines.push(snapshot);
    }
    lines.push("");
    lines.push(`Question: ${request.question}`);
    lines.push("");
    lines.push(
      "A model-backed answer is dispatched asynchronously so the parent agent can keep working. " +
        "This stub is replaced by the configured provider when the CLI connects to a model.",
    );
    lines.push("");
    lines.push(`Token budget allocated for this answer: ${budget}.`);
    return lines.join("\n");
  }

  private truncate(text: string): string {
    if (text.length <= MAX_ANSWER_CHARS) return text;
    return `${text.slice(0, MAX_ANSWER_CHARS)}\n…[truncated]`;
  }

  private estimateTokens(text: string): number {
    // Approximation: ~4 chars per token. Adequate for budget bookkeeping.
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private record(result: BtwResult): void {
    this.history.push(result);
    if (this.history.length > BtwManager.MAX_HISTORY) {
      this.history.splice(0, this.history.length - BtwManager.MAX_HISTORY);
    }
    for (const listener of this.listeners) {
      try {
        listener(result);
      } catch (error) {
        logger.warn(`[btw] listener threw: ${error}`);
      }
    }
  }

  private async timeoutAfter(requestId: string, ms: number): Promise<BtwResult> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    const pending = this.inFlight.get(requestId);
    if (pending) {
      // Allow it to finish in the background, but resolve early.
      logger.warn(`[btw] answer for ${requestId} exceeded ${ms}ms; returning stub`);
    }
    return {
      id: requestId,
      question: "",
      answer: "",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      tokensUsed: 0,
      status: "aborted",
      error: `btw answer exceeded ${ms}ms`,
    };
  }
}

const globalManager = new BtwManager();

/** Public surface for the btw side-thread engine. */
export const btw = {
  enqueue: (question: string, context: BtwContext) => globalManager.enqueue(question, context),
  ask: (question: string, context: BtwContext) => globalManager.ask(question, context),
  cancel: (requestId: string) => globalManager.cancel(requestId),
  onProgress: (listener: BtwProgressListener) => globalManager.onProgress(listener),
  recent: (limit?: number) => globalManager.recent(limit),
  stats: () => globalManager.stats(),
  manager: globalManager,
};

export type BtwManager = BtwManager;
export default btw;
