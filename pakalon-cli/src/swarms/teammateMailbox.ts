import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import logger from "@/utils/logger.js";
import type { MailboxMessage } from "./types.js";

/**
 * TeammateMailbox — filesystem-based inter-teammate message passing.
 *
 * Messages are stored as JSON files in a shared `mailbox/` directory.
 * Each teammate has a subdirectory named after their ID, containing
 * individual message files. Messages are read atomically and deleted
 * after processing.
 */

const MAILBOX_DIR = "mailbox";

/**
 * Get the mailbox directory for a project.
 */
export function getMailboxDir(projectDir: string): string {
  return path.join(projectDir, MAILBOX_DIR);
}

/**
 * Get the inbox directory for a specific teammate.
 */
export function getTeammateInboxDir(projectDir: string, teammateId: string): string {
  return path.join(getMailboxDir(projectDir), teammateId);
}

/**
 * Initialize the mailbox directory structure for a teammate.
 */
export function initTeammateMailbox(projectDir: string, teammateId: string): void {
  const inbox = getTeammateInboxDir(projectDir, teammateId);
  fs.mkdirSync(inbox, { recursive: true });
}

/**
 * Write a message to a teammate's mailbox.
 */
export function writeToMailbox(
  projectDir: string,
  senderId: string,
  recipientId: string,
  content: string,
  type: MailboxMessage["type"] = "message",
): MailboxMessage {
  const inbox = getTeammateInboxDir(projectDir, recipientId);
  fs.mkdirSync(inbox, { recursive: true });

  const message: MailboxMessage = {
    id: randomUUID(),
    senderId,
    recipientId,
    content,
    type,
    timestamp: Date.now(),
    read: false,
  };

  const filePath = path.join(inbox, `${message.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(message, null, 2), "utf-8");
  logger.debug(`[Mailbox] ${senderId} → ${recipientId}: ${type}`);
  return message;
}

/**
 * Read all unread messages from a teammate's inbox.
 */
export function readUnreadMessages(projectDir: string, teammateId: string): MailboxMessage[] {
  const inbox = getTeammateInboxDir(projectDir, teammateId);

  if (!fs.existsSync(inbox)) return [];

  const messages: MailboxMessage[] = [];
  const files = fs.readdirSync(inbox).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    try {
      const filePath = path.join(inbox, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const msg: MailboxMessage = JSON.parse(raw);
      if (!msg.read) {
        messages.push(msg);
      }
    } catch {
      // Skip malformed files
    }
  }

  return messages.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Mark messages as read by deleting their files.
 */
export function markMessagesAsRead(projectDir: string, teammateId: string, messageIds: string[]): void {
  const inbox = getTeammateInboxDir(projectDir, teammateId);

  for (const id of messageIds) {
    const filePath = path.join(inbox, `${id}.json`);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Read and consume all unread messages (read + delete).
 */
export function consumeMessages(projectDir: string, teammateId: string): MailboxMessage[] {
  const messages = readUnreadMessages(projectDir, teammateId);
  markMessagesAsRead(projectDir, teammateId, messages.map((m) => m.id));
  return messages;
}

/**
 * Clean up a teammate's entire mailbox directory.
 */
export function cleanupMailbox(projectDir: string, teammateId: string): void {
  const inbox = getTeammateInboxDir(projectDir, teammateId);
  if (fs.existsSync(inbox)) {
    fs.rmSync(inbox, { recursive: true, force: true });
  }
}

/**
 * Get the count of unread messages for a teammate.
 */
export function getUnreadCount(projectDir: string, teammateId: string): number {
  const inbox = getTeammateInboxDir(projectDir, teammateId);
  if (!fs.existsSync(inbox)) return 0;
  return fs.readdirSync(inbox).filter((f) => f.endsWith(".json")).length;
}

/**
 * Check if a message is a shutdown signal.
 */
export function isShutdownMessage(msg: MailboxMessage): boolean {
  return msg.type === "shutdown";
}

/**
 * Check if a message is a permission request.
 */
export function isPermissionRequest(msg: MailboxMessage): boolean {
  return msg.type === "permission_request";
}

/**
 * Check if a message is a permission response.
 */
export function isPermissionResponse(msg: MailboxMessage): boolean {
  return msg.type === "permission_response";
}
