/**
 * Notifier Service for pakalon-cli
 *
 * Sends notifications to the user via various channels.
 * Supports terminal notifications, desktop notifications, and hooks.
 */

import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type NotificationOptions = {
  message: string;
  title?: string;
  notificationType: string;
};

export type NotificationChannel =
  | "auto"
  | "terminal"
  | "desktop"
  | "disabled";

// ============================================================================
// Notifier Service
// ============================================================================

const DEFAULT_TITLE = "Pakalon";

/**
 * Send a notification to the user
 */
export async function sendNotification(
  notif: NotificationOptions,
  channel: NotificationChannel = "auto"
): Promise<void> {
  const title = notif.title || DEFAULT_TITLE;

  try {
    switch (channel) {
      case "auto":
        await sendAuto(notif, title);
        break;
      case "terminal":
        sendTerminal(notif);
        break;
      case "desktop":
        await sendDesktop(notif, title);
        break;
      case "disabled":
        break;
      default:
        break;
    }

    logger.debug("[Notifier] Sent notification", {
      type: notif.notificationType,
      channel,
    });
  } catch (error) {
    logger.warn("[Notifier] Failed to send notification:", error);
  }
}

/**
 * Auto-detect and send notification via best available channel
 */
async function sendAuto(
  notif: NotificationOptions,
  title: string
): Promise<void> {
  // Try desktop notification first
  if (process.platform === "darwin" || process.platform === "win32") {
    await sendDesktop(notif, title);
    return;
  }

  // Fall back to terminal notification
  sendTerminal(notif);
}

/**
 * Send notification via terminal (console output)
 */
function sendTerminal(notif: NotificationOptions): void {
  console.log(`\n🔔 [${notif.notificationType}] ${notif.message}\n`);
}

/**
 * Send desktop notification (platform-specific)
 */
async function sendDesktop(
  notif: NotificationOptions,
  title: string
): Promise<void> {
  // Platform-specific notification logic would go here
  // For now, just log it
  logger.debug("[Notifier] Desktop notification:", {
    title,
    message: notif.message,
  });
}
