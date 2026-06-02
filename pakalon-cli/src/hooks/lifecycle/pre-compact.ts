/**
 * PreCompact lifecycle handler.
 *
 * Fires before the agent compacts its context. The default implementation
 * logs the event; consumers can register additional handlers (e.g. to dump
 * working state to a scratchpad) via `registerLifecycleHandler("PreCompact", …)`.
 */

import type { LifecycleContext, LifecycleHandlerResult } from "./index.js";
import logger from "@/utils/logger.js";

export async function runPreCompact(
  context: LifecycleContext,
): Promise<LifecycleHandlerResult> {
  logger.info(`[lifecycle:PreCompact] session=${context.sessionId}`);

  return {
    ok: true,
    message: `PreCompact acknowledged for session ${context.sessionId}.`,
    payload: {
      kind: "pre-compact",
      sessionId: context.sessionId,
      at: context.timestamp,
    },
  };
}

export default runPreCompact;
