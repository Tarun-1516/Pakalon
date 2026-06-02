/**
 * /install-github-app — open the GitHub App install flow.
 *
 * Phase 5 deploy agent and the auditor call this to wire up PR
 * comments and auto-merge.
 */
import logger from "@/utils/logger.js";

const APP_URL = "https://github.com/apps/pakalon-cli";

export interface InstallGithubAppResult {
  installUrl: string;
  opened: boolean;
}

export async function installGithubApp(): Promise<InstallGithubAppResult> {
  const { default: open } = await import("open").catch(() => ({ default: null as any }));
  if (typeof open !== "function") {
    logger.warn({ appUrl: APP_URL }, "open() unavailable; print URL only");
    return { installUrl: APP_URL, opened: false };
  }
  await open(APP_URL, { wait: false });
  return { installUrl: APP_URL, opened: true };
}
