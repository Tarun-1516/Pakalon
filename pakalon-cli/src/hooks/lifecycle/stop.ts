/**
 * Stop lifecycle handler.
 *
 * Fires when the agent loop is asked to stop (user interrupt, completion,
 * or error). Records the stop event and forwards a payload so downstream
 * automation can react (e.g. flush logs, close sandboxes).
 */

import type { LifecycleContext, LifecycleHandlerResult } from "./index.js";
import logger from "@/utils/logger.js";

export async function runStop(
  context: LifecycleContext,
): Promise<LifecycleHandlerResult> {
  const reason = typeof context.meta?.reason === "string" ? context.meta.reason : "user";
  logger.info(`[lifecycle:Stop] session=${context.sessionId} reason=${reason}`);

  return {
    ok: true,
    message: `Stop acknowledged for session ${context.sessionId} (${reason}).`,
    payload: {
      kind: "stop",
      reason,
      at: context.timestamp,
    },
  };
}

export default runStop;
