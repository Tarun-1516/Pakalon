/**
 * /install-slack-app — open the Slack App install flow.
 */
import logger from "@/utils/logger.js";

const APP_URL = "https://pakalon.com/install/slack";

export interface InstallSlackAppResult {
  installUrl: string;
  opened: boolean;
}

export async function installSlackApp(): Promise<InstallSlackAppResult> {
  const { default: open } = await import("open").catch(() => ({ default: null as any }));
  if (typeof open !== "function") {
    logger.warn({ appUrl: APP_URL }, "open() unavailable; print URL only");
    return { installUrl: APP_URL, opened: false };
  }
  await open(APP_URL, { wait: false });
  return { installUrl: APP_URL, opened: true };
}
