/**
 * Settings Sync Types for pakalon-cli
 *
 * Types for the user settings sync API.
 */

// ============================================================================
// Schemas and Types
// ============================================================================

/**
 * Content portion of user sync data - flat key-value storage.
 * Keys are opaque strings (typically file paths).
 * Values are UTF-8 string content (JSON, Markdown, etc).
 */
export type UserSyncContent = {
  entries: Record<string, string>;
};

/**
 * Full response from GET /api/user_settings
 */
export type UserSyncData = {
  userId: string;
  version: number;
  lastModified: string; // ISO 8601 timestamp
  checksum: string; // MD5 hash
  content: UserSyncContent;
};

/**
 * Result from fetching user settings
 */
export type SettingsSyncFetchResult = {
  success: boolean;
  data?: UserSyncData;
  isEmpty?: boolean; // true if 404 (no data exists)
  error?: string;
  skipRetry?: boolean;
};

/**
 * Result from uploading user settings
 */
export type SettingsSyncUploadResult = {
  success: boolean;
  checksum?: string;
  lastModified?: string;
  error?: string;
};

/**
 * Keys used for sync entries
 */
export const SYNC_KEYS = {
  USER_SETTINGS: "~/.pakalon/settings.json",
  USER_MEMORY: "~/.pakalon/CLAUDE.md",
  projectSettings: (projectId: string) =>
    `projects/${projectId}/.pakalon/settings.local.json`,
  projectMemory: (projectId: string) =>
    `projects/${projectId}/CLAUDE.local.md`,
} as const;
