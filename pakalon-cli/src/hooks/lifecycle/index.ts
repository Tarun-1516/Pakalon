/**
 * Lifecycle hook handler registry.
 *
 * Dispatches lifecycle events to registered handlers, persisted to
 * `~/.config/pakalon/hooks.json` (or a project-local `.pakalon/hooks.json`).
 *
 * The handlers themselves live in `./session-start.ts`, `./session-end.ts`,
 * `./pre-compact.ts`, and `./stop.ts`.
 */

import logger from "@/utils/logger.js";
import { runSessionStart } from "./session-start.js";
import { runSessionEnd } from "./session-end.js";
import { runPreCompact } from "./pre-compact.js";
import { runStop } from "./stop.js";

export type LifecycleEvent =
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact"
  | "Stop"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure";

export interface LifecycleContext {
  sessionId: string;
  userId?: string;
  projectDir?: string;
  timestamp: number;
  /** Free-form metadata; for PreToolUse/PostToolUse this carries tool info. */
  meta?: Record<string, unknown>;
}

export interface LifecycleHandlerResult {
  /** Exit 0 equivalent — allow / continue normally. */
  ok: boolean;
  /** Optional text to surface in the chat log when non-blocking. */
  message?: string;
  /** Optional structured payload for downstream automation. */
  payload?: Record<string, unknown>;
  /** When true, blocks the next step (PreToolUse, UserPromptSubmit). */
  blocking?: boolean;
}

export type LifecycleHandler = (
  context: LifecycleContext,
) => Promise<LifecycleHandlerResult> | LifecycleHandlerResult;

const REGISTRY: Record<LifecycleEvent, LifecycleHandler[]> = {
  SessionStart: [runSessionStart],
  SessionEnd: [runSessionEnd],
  PreCompact: [runPreCompact],
  Stop: [runStop],
  PreToolUse: [],
  PostToolUse: [],
  PostToolUseFailure: [],
};

export function registerLifecycleHandler(
  event: LifecycleEvent,
  handler: LifecycleHandler,
): void {
  REGISTRY[event] = REGISTRY[event] ?? [];
  REGISTRY[event].push(handler);
  logger.debug(`[lifecycle] registered handler for ${event} (total: ${REGISTRY[event].length})`);
}

export function listLifecycleHandlers(event: LifecycleEvent): readonly LifecycleHandler[] {
  return REGISTRY[event] ?? [];
}

export async function dispatchLifecycle(
  event: LifecycleEvent,
  context: LifecycleContext,
): Promise<LifecycleHandlerResult> {
  const handlers = REGISTRY[event] ?? [];
  if (handlers.length === 0) {
    return { ok: true };
  }

  const result: LifecycleHandlerResult = { ok: true };
  for (const handler of handlers) {
    try {
      const next = await handler(context);
      if (!next.ok) {
        result.ok = false;
      }
      if (next.message) {
        result.message = [result.message, next.message].filter(Boolean).join("\n");
      }
      if (next.payload) {
        result.payload = { ...(result.payload ?? {}), ...next.payload };
      }
      if (next.blocking) {
        result.blocking = true;
        return result;
      }
    } catch (error) {
      logger.error(`[lifecycle] handler for ${event} failed: ${error}`);
      result.ok = false;
      result.message = [
        result.message,
        `handler error: ${error instanceof Error ? error.message : String(error)}`,
      ]
        .filter(Boolean)
        .join("\n");
    }
  }
  return result;
}

export { runSessionStart, runSessionEnd, runPreCompact, runStop };
export default dispatchLifecycle;
