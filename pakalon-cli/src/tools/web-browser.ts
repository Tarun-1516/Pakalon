/**
 * /web-browser — launch a URL in the user's default browser.
 *
 * Mirrors the reference CLI's `WebBrowser` tool. Used by `/penpot`,
 * `/install-github-app`, `/install-slack-app`, etc.
 */
import logger from "@/utils/logger.js";

export interface WebBrowserResult {
  url: string;
  opened: boolean;
}

export async function openUrl(url: string): Promise<WebBrowserResult> {
  const { default: open } = await import("open").catch(() => ({ default: null as any }));
  if (typeof open !== "function") {
    logger.warn({ url }, "open() unavailable; print URL only");
    return { url, opened: false };
  }
  try {
    await open(url, { wait: false });
    return { url, opened: true };
  } catch (err) {
    logger.warn({ err, url }, "open() failed");
    return { url, opened: false };
  }
}
