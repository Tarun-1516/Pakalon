/**
 * Settings Sync Service for pakalon-cli
 *
 * Syncs user settings and memory files across pakalon environments.
 *
 * - Interactive CLI: Uploads local settings to remote (incremental, only changed entries)
 * - CCR: Downloads remote settings to local before plugin installation
 */

import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";
import {
  type SettingsSyncFetchResult,
  type SettingsSyncUploadResult,
  SYNC_KEYS,
  type UserSyncData,
} from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const SETTINGS_SYNC_TIMEOUT_MS = 10000; // 10 seconds
const DEFAULT_MAX_RETRIES = 3;
const MAX_FILE_SIZE_BYTES = 500 * 1024; // 500 KB per file (matches backend limit)

// ============================================================================
// Configuration
// ============================================================================

let settingsSyncEndpoint = "";
let settingsSyncAuthToken: string | undefined;

/**
 * Configure the settings sync service
 */
export function configureSettingsSync(options: {
  endpoint?: string;
  authToken?: string;
}): void {
  if (options.endpoint) {
    settingsSyncEndpoint = options.endpoint;
  }
  if (options.authToken) {
    settingsSyncAuthToken = options.authToken;
  }
}

/**
 * Get the settings sync endpoint
 */
function getSettingsSyncEndpoint(): string {
  return settingsSyncEndpoint || "https://api.pakalon.com/api/user_settings";
}

/**
 * Get auth headers for settings sync
 */
function getSettingsSyncAuthHeaders(): {
  headers: Record<string, string>;
  error?: string;
} {
  if (settingsSyncAuthToken) {
    return {
      headers: {
        Authorization: `Bearer ${settingsSyncAuthToken}`,
      },
    };
  }

  return {
    headers: {},
    error: "No auth token available",
  };
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Try to read a file for sync, with size limit and error handling.
 * Returns null if file doesn't exist, is empty, or exceeds size limit.
 */
async function tryReadFileForSync(filePath: string): Promise<string | null> {
  try {
    const stats = await stat(filePath);
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      console.log("[SettingsSync] File too large:", filePath);
      return null;
    }

    const content = await readFile(filePath, "utf8");
    // Check for empty/whitespace-only
    if (!content || /^\s*$/.test(content)) {
      return null;
    }

    return content;
  } catch {
    return null;
  }
}

/**
 * Write a file for sync with error handling
 */
async function writeFileForSync(
  filePath: string,
  content: string
): Promise<boolean> {
  try {
    const parentDir = dirname(filePath);
    if (parentDir) {
      await mkdir(parentDir, { recursive: true });
    }

    await writeFile(filePath, content, "utf8");
    console.log("[SettingsSync] File written:", filePath);
    return true;
  } catch {
    console.log("[SettingsSync] File write failed:", filePath);
    return false;
  }
}

// ============================================================================
// Build Entries
// ============================================================================

/**
 * Get the settings file path for a given source
 */
function getSettingsFilePathForSource(
  source: "userSettings" | "localSettings"
): string | null {
  if (source === "userSettings") {
    return join(homedir(), ".config", "pakalon", "settings.json");
  }
  if (source === "localSettings") {
    // This should be called with the project directory context
    return join(process.cwd(), ".pakalon", "settings.local.json");
  }
  return null;
}

/**
 * Get the memory path for a given type
 */
function getMemoryPath(type: "User" | "Local"): string {
  if (type === "User") {
    return join(homedir(), ".config", "pakalon", "CLAUDE.md");
  }
  return join(process.cwd(), ".pakalon", "CLAUDE.local.md");
}

/**
 * Get a project ID from git remote (simplified version)
 */
async function getRepoRemoteHash(): Promise<string | null> {
  try {
    const { execSync } = await import("child_process");
    const remoteUrl = execSync("git remote get-url origin", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    // Simple hash of remote URL as project ID
    let hash = 0;
    for (let i = 0; i < remoteUrl.length; i++) {
      const char = remoteUrl.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  } catch {
    return null;
  }
}

/**
 * Build entries from local files for sync
 */
async function buildEntriesFromLocalFiles(
  projectId: string | null
): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};

  // Global user settings
  const userSettingsPath = getSettingsFilePathForSource("userSettings");
  if (userSettingsPath) {
    const content = await tryReadFileForSync(userSettingsPath);
    if (content) {
      entries[SYNC_KEYS.USER_SETTINGS] = content;
    }
  }

  // Global user memory
  const userMemoryPath = getMemoryPath("User");
  const userMemoryContent = await tryReadFileForSync(userMemoryPath);
  if (userMemoryContent) {
    entries[SYNC_KEYS.USER_MEMORY] = userMemoryContent;
  }

  // Project-specific files (only if we have a project ID from git remote)
  if (projectId) {
    // Project local settings
    const localSettingsPath = getSettingsFilePathForSource("localSettings");
    if (localSettingsPath) {
      const content = await tryReadFileForSync(localSettingsPath);
      if (content) {
        entries[SYNC_KEYS.projectSettings(projectId)] = content;
      }
    }

    // Project local memory
    const localMemoryPath = getMemoryPath("Local");
    const localMemoryContent = await tryReadFileForSync(localMemoryPath);
    if (localMemoryContent) {
      entries[SYNC_KEYS.projectMemory(projectId)] = localMemoryContent;
    }
  }

  return entries;
}

// ============================================================================
// API Operations
// ============================================================================

/**
 * Fetch user settings from remote
 */
async function fetchUserSettingsOnce(): Promise<SettingsSyncFetchResult> {
  try {
    const authHeaders = getSettingsSyncAuthHeaders();
    if (authHeaders.error) {
      return {
        success: false,
        error: authHeaders.error,
        skipRetry: true,
      };
    }

    const headers: Record<string, string> = {
      ...authHeaders.headers,
      "Content-Type": "application/json",
    };

    const endpoint = getSettingsSyncEndpoint();
    const response = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(SETTINGS_SYNC_TIMEOUT_MS),
    });

    // 404 means no settings exist yet
    if (response.status === 404) {
      return {
        success: true,
        isEmpty: true,
      };
    }

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as UserSyncData;
    return {
      success: true,
      data,
      isEmpty: false,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "TimeoutError") {
        return { success: false, error: "Settings sync request timeout" };
      }
      if (error.message.includes("fetch")) {
        return { success: false, error: "Cannot connect to server" };
      }
      return { success: false, error: error.message };
    }
    return { success: false, error: "Unknown error" };
  }
}

/**
 * Fetch user settings with retries
 */
async function fetchUserSettings(
  maxRetries = DEFAULT_MAX_RETRIES
): Promise<SettingsSyncFetchResult> {
  let lastResult: SettingsSyncFetchResult | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    lastResult = await fetchUserSettingsOnce();

    if (lastResult.success) {
      return lastResult;
    }

    if (lastResult.skipRetry) {
      return lastResult;
    }

    if (attempt > maxRetries) {
      return lastResult;
    }

    // Exponential backoff
    const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
    console.log("[SettingsSync] Retry:", { attempt, maxRetries, delayMs });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return lastResult!;
}

/**
 * Upload user settings to remote
 */
async function uploadUserSettings(
  entries: Record<string, string>
): Promise<SettingsSyncUploadResult> {
  try {
    const authHeaders = getSettingsSyncAuthHeaders();
    if (authHeaders.error) {
      return {
        success: false,
        error: authHeaders.error,
      };
    }

    const headers: Record<string, string> = {
      ...authHeaders.headers,
      "Content-Type": "application/json",
    };

    const endpoint = getSettingsSyncEndpoint();
    const response = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({ entries }),
      signal: AbortSignal.timeout(SETTINGS_SYNC_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as {
      checksum?: string;
      lastModified?: string;
    };

    console.log("[SettingsSync] Uploaded:", {
      entryCount: Object.keys(entries).length,
    });
    return {
      success: true,
      checksum: data.checksum,
      lastModified: data.lastModified,
    };
  } catch (error) {
    console.log("[SettingsSync] Upload error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// ============================================================================
// Apply Remote Entries
// ============================================================================

/**
 * Apply remote entries to local files (CCR pull pattern).
 * Only writes files that match expected keys.
 */
async function applyRemoteEntriesToLocal(
  entries: Record<string, string>,
  projectId: string | null
): Promise<void> {
  let appliedCount = 0;

  // Helper to check size limit (defense-in-depth, matches backend limit)
  const exceedsSizeLimit = (content: string): boolean => {
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      console.log("[SettingsSync] File too large:", sizeBytes);
      return true;
    }
    return false;
  };

  // Apply global user settings
  const userSettingsContent = entries[SYNC_KEYS.USER_SETTINGS];
  if (userSettingsContent) {
    const userSettingsPath = getSettingsFilePathForSource("userSettings");
    if (
      userSettingsPath &&
      !exceedsSizeLimit(userSettingsContent)
    ) {
      if (await writeFileForSync(userSettingsPath, userSettingsContent)) {
        appliedCount++;
      }
    }
  }

  // Apply global user memory
  const userMemoryContent = entries[SYNC_KEYS.USER_MEMORY];
  if (userMemoryContent) {
    const userMemoryPath = getMemoryPath("User");
    if (!exceedsSizeLimit(userMemoryContent)) {
      if (await writeFileForSync(userMemoryPath, userMemoryContent)) {
        appliedCount++;
      }
    }
  }

  // Apply project-specific files (only if project ID matches)
  if (projectId) {
    const projectSettingsKey = SYNC_KEYS.projectSettings(projectId);
    const projectSettingsContent = entries[projectSettingsKey];
    if (projectSettingsContent) {
      const localSettingsPath = getSettingsFilePathForSource("localSettings");
      if (
        localSettingsPath &&
        !exceedsSizeLimit(projectSettingsContent)
      ) {
        if (
          await writeFileForSync(localSettingsPath, projectSettingsContent)
        ) {
          appliedCount++;
        }
      }
    }

    const projectMemoryKey = SYNC_KEYS.projectMemory(projectId);
    const projectMemoryContent = entries[projectMemoryKey];
    if (projectMemoryContent) {
      const localMemoryPath = getMemoryPath("Local");
      if (!exceedsSizeLimit(projectMemoryContent)) {
        if (await writeFileForSync(localMemoryPath, projectMemoryContent)) {
          appliedCount++;
        }
      }
    }
  }

  console.log("[SettingsSync] Applied:", { appliedCount });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Upload local settings to remote (interactive CLI only).
 * Runs in background - caller should not await unless needed.
 */
export async function uploadUserSettingsInBackground(): Promise<void> {
  try {
    if (!settingsSyncEndpoint && !settingsSyncAuthToken) {
      console.log("[SettingsSync] Upload skipped: not configured");
      return;
    }

    console.log("[SettingsSync] Upload starting");
    const result = await fetchUserSettings();
    if (!result.success) {
      console.log("[SettingsSync] Upload fetch failed");
      return;
    }

    const projectId = await getRepoRemoteHash();
    const localEntries = await buildEntriesFromLocalFiles(projectId);
    const remoteEntries = result.isEmpty ? {} : result.data!.content.entries;
    const changedEntries: Record<string, string> = {};

    for (const [key, value] of Object.entries(localEntries)) {
      if (remoteEntries[key] !== value) {
        changedEntries[key] = value;
      }
    }

    const entryCount = Object.keys(changedEntries).length;
    if (entryCount === 0) {
      console.log("[SettingsSync] Upload skipped: no changes");
      return;
    }

    const uploadResult = await uploadUserSettings(changedEntries);
    if (uploadResult.success) {
      console.log("[SettingsSync] Upload success:", { entryCount });
    } else {
      console.log("[SettingsSync] Upload failed:", uploadResult.error);
    }
  } catch {
    // Fail-open: log unexpected errors but don't block startup
    console.log("[SettingsSync] Upload unexpected error");
  }
}

// Cached download promise
let downloadPromise: Promise<boolean> | null = null;

/**
 * Download settings from remote for CCR mode.
 * Fired fire-and-forget at startup; awaited before plugin install.
 * Returns true if settings were applied, false otherwise.
 */
export function downloadUserSettings(): Promise<boolean> {
  if (downloadPromise) {
    return downloadPromise;
  }
  downloadPromise = doDownloadUserSettings();
  return downloadPromise;
}

/**
 * Force a fresh download, bypassing the cached startup promise.
 */
export function redownloadUserSettings(): Promise<boolean> {
  downloadPromise = doDownloadUserSettings(0);
  return downloadPromise;
}

async function doDownloadUserSettings(
  maxRetries = DEFAULT_MAX_RETRIES
): Promise<boolean> {
  try {
    if (!settingsSyncEndpoint && !settingsSyncAuthToken) {
      console.log("[SettingsSync] Download skipped: not configured");
      return false;
    }

    console.log("[SettingsSync] Download starting");
    const result = await fetchUserSettings(maxRetries);
    if (!result.success) {
      console.log("[SettingsSync] Download fetch failed");
      return false;
    }

    if (result.isEmpty) {
      console.log("[SettingsSync] Download empty");
      return false;
    }

    const entries = result.data!.content.entries;
    const projectId = await getRepoRemoteHash();
    const entryCount = Object.keys(entries).length;
    console.log("[SettingsSync] Download applying:", { entryCount });
    await applyRemoteEntriesToLocal(entries, projectId);
    console.log("[SettingsSync] Download success:", { entryCount });
    return true;
  } catch {
    console.log("[SettingsSync] Download error");
    return false;
  }
}

/**
 * Get settings sync status
 */
export function getSettingsSyncStatus(): {
  configured: boolean;
  endpoint: string;
  hasToken: boolean;
} {
  return {
    configured: !!(settingsSyncEndpoint || settingsSyncAuthToken),
    endpoint: settingsSyncEndpoint,
    hasToken: !!settingsSyncAuthToken,
  };
}
