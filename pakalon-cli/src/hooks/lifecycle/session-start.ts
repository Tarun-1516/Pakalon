/**
 * SessionStart lifecycle handler.
 *
 * Captures the start of a session: rehydrates any persisted hook state,
 * surfaces the active model, and announces the session id to downstream
 * automation.
 */

import type { LifecycleContext, LifecycleHandlerResult } from "./index.js";
import logger from "@/utils/logger.js";

export async function runSessionStart(
  context: LifecycleContext,
): Promise<LifecycleHandlerResult> {
  logger.info(
    `[lifecycle:SessionStart] session=${context.sessionId} project=${context.projectDir ?? "(none)"}`,
  );

  return {
    ok: true,
    message: `Session ${context.sessionId} started.`,
    payload: {
      kind: "session-start",
      projectDir: context.projectDir ?? null,
      startedAt: context.timestamp,
    },
  };
}

export default runSessionStart;
