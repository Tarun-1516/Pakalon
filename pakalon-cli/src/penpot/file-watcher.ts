/**
 * Penpot file watcher — watches the actual `.penpot` file (the editable
 * design file) and triggers a re-export of the wireframes whenever the
 * designer saves.
 *
 * This complements `sync-bridge.ts` (which mirrors the export dir →
 * wireframes dir) by closing the loop on the source design file.
 *
 * Flow:
 *   .penpot file change
 *     → onPenpotFileChange()
 *       → exportPenpotFile()  (calls Penpot export API)
 *         → startSyncBridge() picks up the new SVGs automatically
 */
import * as fs from "fs/promises";
import * as path from "path";
import { watch, type FSWatcher } from "chokidar";
import logger from "@/utils/logger.js";
import { exportPenpotDesign, type PenpotFile } from "./export.js";
import { startSyncBridge, stopSyncBridge } from "./sync-bridge.js";

export interface PenpotFileWatcherOptions {
  /** Cooldown between re-exports, in milliseconds. Default 5s. */
  cooldownMs?: number;
  /** Whether to start the export bridge automatically. Default true. */
  autoBridge?: boolean;
}

export interface PenpotFileWatcherState {
  penpotFile: string;
  projectDir: string;
  wireframesDir: string;
  watcher: FSWatcher;
  cooldownMs: number;
  lastExportAt: number | null;
}

let activeWatcher: PenpotFileWatcherState | null = null;
let exportTimer: NodeJS.Timeout | null = null;

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function isPenpotFile(p: string): boolean {
  return p.toLowerCase().endsWith(".penpot");
}

/**
 * Start watching a .penpot file. Whenever the file changes, an
 * export is triggered (after a debounce) and the resulting SVGs
 * are mirrored into the wireframes directory by the sync bridge.
 */
export async function startPenpotFileWatcher(
  projectDir: string,
  penpotFile: string,
  options: PenpotFileWatcherOptions = {},
): Promise<PenpotFileWatcherState> {
  if (activeWatcher) {
    logger.warn(`[penpot-watcher] Already watching ${activeWatcher.penpotFile}; returning existing handle`);
    return activeWatcher;
  }

  const stat = await fs.stat(penpotFile).catch(() => null);
  if (!stat) {
    throw new Error(`[penpot-watcher] File not found: ${penpotFile}`);
  }
  if (!isPenpotFile(penpotFile)) {
    throw new Error(`[penpot-watcher] Not a .penpot file: ${penpotFile}`);
  }

  const cooldownMs = options.cooldownMs ?? 5000;
  const wireframesDir = path.join(projectDir, ".pakalon-agents", "wireframes");
  const penpotExportDir = path.join(projectDir, ".pakalon-agents", "ai-agents", "phase-2");
  await ensureDir(wireframesDir);
  await ensureDir(penpotExportDir);

  const watcher = watch(penpotFile, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
  });

  activeWatcher = {
    penpotFile,
    projectDir,
    wireframesDir,
    watcher,
    cooldownMs,
    lastExportAt: null,
  };

  const handleEvent = (): void => {
    if (exportTimer) clearTimeout(exportTimer);
    exportTimer = setTimeout(() => {
      void triggerExport(projectDir, penpotFile, penpotExportDir);
    }, cooldownMs);
  };

  watcher
    .on("add", handleEvent)
    .on("change", handleEvent)
    .on("unlink", () => {
      logger.warn(`[penpot-watcher] Source file removed: ${penpotFile}`);
    });

  if (options.autoBridge !== false) {
    await startSyncBridge(projectDir, penpotExportDir, { cooldownMs });
  }

  logger.info(
    `[penpot-watcher] Watching ${penpotFile} (cooldown: ${cooldownMs}ms, export dir: ${penpotExportDir})`,
  );
  return activeWatcher;
}

async function triggerExport(
  projectDir: string,
  penpotFile: string,
  penpotExportDir: string,
): Promise<void> {
  if (!activeWatcher) return;
  try {
    const raw = await fs.readFile(penpotFile, "utf-8");
    const penpotData = JSON.parse(raw) as PenpotFile;
    const result = await exportPenpotDesign(penpotData, {
      format: "all",
      outputDir: penpotExportDir,
      quality: "high",
      includeMetadata: true,
    });
    activeWatcher.lastExportAt = Date.now();
    logger.info(
      `[penpot-watcher] Re-exported ${penpotFile} → ${result.exportedFiles.length} files in ${penpotExportDir}` +
        (result.errors.length > 0 ? ` (${result.errors.length} errors)` : ""),
    );
  } catch (err) {
    logger.error({ err }, `[penpot-watcher] Export failed for ${penpotFile}`);
  }
}

export async function stopPenpotFileWatcher(): Promise<boolean> {
  if (!activeWatcher) return true;
  if (exportTimer) {
    clearTimeout(exportTimer);
    exportTimer = null;
  }
  await activeWatcher.watcher.close();
  await stopSyncBridge().catch(() => undefined);
  activeWatcher = null;
  logger.info("[penpot-watcher] Stopped");
  return true;
}

export function getPenpotFileWatcher(): PenpotFileWatcherState | null {
  return activeWatcher;
}
