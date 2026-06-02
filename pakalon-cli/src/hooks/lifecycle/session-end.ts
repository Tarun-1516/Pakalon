/**
 * SessionEnd lifecycle handler.
 *
 * Finalises a session: writes the stop reason to the audit log when
 * available, and emits a payload downstream automation can use to release
 * resources (e.g. cleanup scratchpads or close sandboxes).
 */

import type { LifecycleContext, LifecycleHandlerResult } from "./index.js";
import logger from "@/utils/logger.js";

export async function runSessionEnd(
  context: LifecycleContext,
): Promise<LifecycleHandlerResult> {
  logger.info(`[lifecycle:SessionEnd] session=${context.sessionId}`);

  return {
    ok: true,
    message: `Session ${context.sessionId} ended.`,
    payload: {
      kind: "session-end",
      endedAt: context.timestamp,
      reason: typeof context.meta?.reason === "string" ? context.meta.reason : "completed",
    },
  };
}

export default runSessionEnd;
